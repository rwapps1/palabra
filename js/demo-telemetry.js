// /new demo-funnel telemetry — writes one Firestore document per event.
//
// Loaded by BOTH new/index.html and index.html, and that's the whole reason
// this is its own file rather than living inside demo-boot.js: most events
// happen on /new, but signup_screen_reached and account_created happen on
// the real app, after a full page navigation. One implementation, two
// pages, no duplicated copy to drift apart.
//
// Loads immediately after config.js (it needs DEMO_SESSION_KEY) and has no
// other dependency. IMPORTANT: this file defines functions and nothing
// else — it must have no side effects at load time, because the real app
// loads it on every single page view for every signed-in user, the vast
// majority of whom never came anywhere near the demo. Nothing here does
// anything at all until startDemoTelemetrySession() has created a session,
// which only ever happens on /new.
//
// Transport is the Firestore REST API via plain fetch(), not the Firebase
// SDK — /new deliberately loads no Firebase, and adding ~100KB of SDK to
// an ad landing page is exactly the wrong trade when paid clicks are the
// traffic most sensitive to load time.
//
// Every event is a CREATE of a new document at a deterministic id
// ("{sessionId}-{seq}", e.g. "a7f3-03"), never an update. That matches the
// Firestore rule, which forbids updates outright, and makes retries free:
// re-sending an event that already landed returns 409 ALREADY_EXISTS,
// which is treated here as success rather than an error.
//
// FAILURE ISOLATION IS THE POINT (see the 2026-08-25 question-8 freeze,
// where one unhandled throw in a supporting call silently killed the whole
// conversion path). Every public function below is wrapped top-to-bottom
// in try/catch, no fetch is ever awaited by a caller, and no return value
// is ever meaningful. A blocked request, dead network, exhausted quota,
// rules rejection, or unavailable sessionStorage must all leave the demo
// completely playable.

  // Same project as firebase-auth.js and admin.html. Repeated here rather
  // than imported because /new loads neither of those — and this config is
  // not a secret in any case; access is enforced by Firestore rules.
  const DEMO_TELEMETRY_PROJECT_ID = 'palabra-f8778';
  const DEMO_TELEMETRY_API_KEY = 'AIzaSyBa47dn0gfyqYtF07i7EEsUCJtYIPZs5NM';
  const DEMO_TELEMETRY_COLLECTION = 'demoEvents';
  const DEMO_TELEMETRY_ENDPOINT =
    'https://firestore.googleapis.com/v1/projects/' + DEMO_TELEMETRY_PROJECT_ID +
    '/databases/(default)/documents/' + DEMO_TELEMETRY_COLLECTION;

  // Session ids are exactly 4 lowercase alphanumerics, because the
  // Firestore rule validates them against ^[a-z0-9]{4}$ and then splices
  // that into the document-id regex. If this alphabet or length ever
  // changes, the rule has to change with it or every write silently fails.
  //
  // Note this does NOT use Math.random().toString(36).slice(2, 6): that
  // occasionally yields fewer than 4 characters, since Math.random() can
  // produce a short decimal (e.g. 0.5 -> "0.i" -> "i"). Every such session
  // would be rejected by the rule and lost. Building the string a
  // character at a time guarantees the length.
  const DEMO_SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const DEMO_SESSION_ID_LENGTH = 4;

  // The rule caps seq at 99 (two digits in the document id). The real
  // funnel tops out at 16, so this is only ever reached by something
  // pathological — in which case we stop recording rather than start
  // emitting writes the rule will reject.
  const DEMO_TELEMETRY_MAX_SEQ = 99;

  // Cap on unsent events held in sessionStorage. Bounded so a long offline
  // stretch can't grow the stored blob without limit; oldest are dropped
  // first, since a later event is more informative about where someone
  // actually stopped than an earlier one that's already implied by it.
  const DEMO_TELEMETRY_MAX_PENDING = 30;

  // Used when sessionStorage is unavailable (private browsing, storage
  // disabled, some embedded webviews). The session then can't survive the
  // navigation to the real signup page, so that visitor's conversion won't
  // be linkable — but the demo itself plays perfectly normally, which
  // matters far more than the data point.
  let demoTelemetryMemoryFallback = null;
  let demoTelemetryStorageBlocked = false;

  // Set post-signup by auth.js. Held in memory only and deliberately never
  // written to sessionStorage — it's a real Firebase ID token, and the
  // account_created event is the one write the rules require to be
  // authenticated.
  let demoTelemetryIdToken = null;

  // seq numbers with a fetch currently in flight, so a flush triggered
  // while an earlier flush is still running doesn't send the same event
  // twice. (Harmless if it did — the second would 409 — but pointless.)
  const demoTelemetryInFlight = {};

  function demoTelemetryReadState() {
    try {
      if (demoTelemetryStorageBlocked) return demoTelemetryMemoryFallback;
      const raw = sessionStorage.getItem(DEMO_SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && parsed.id) ? parsed : null;
    } catch (e) {
      demoTelemetryStorageBlocked = true;
      return demoTelemetryMemoryFallback;
    }
  }

  function demoTelemetryWriteState(s) {
    demoTelemetryMemoryFallback = s;
    try {
      if (demoTelemetryStorageBlocked) return;
      sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(s));
    } catch (e) {
      demoTelemetryStorageBlocked = true;
    }
  }

  function newDemoSessionId() {
    let out = '';
    for (let i = 0; i < DEMO_SESSION_ID_LENGTH; i++) {
      out += DEMO_SESSION_ID_ALPHABET.charAt(
        Math.floor(Math.random() * DEMO_SESSION_ID_ALPHABET.length)
      );
    }
    return out;
  }

  // Called once, by demo-boot.js, at /new page load. Creating a session is
  // deliberately NOT something recordDemoEvent() will do on its own —
  // otherwise a stray call on the real app would mint a phantom session
  // for a user who never saw the demo.
  //
  // If a session already exists in this tab (e.g. someone reloaded /new),
  // it's kept rather than replaced, so the reload continues the same
  // record instead of splitting one person into two.
  function startDemoTelemetrySession() {
    try {
      const existing = demoTelemetryReadState();
      if (existing) return existing.id;
      const s = {
        id: newDemoSessionId(),
        startedAt: Date.now(),
        seq: 0,
        lastAtMs: 0,
        converted: false,
        pending: [],
      };
      demoTelemetryWriteState(s);
      return s.id;
    } catch (e) {
      return null;
    }
  }

  // Read by auth.js so a conversion can be stamped into the existing
  // Telegram signup ping. Returns null when there's no demo session in
  // this tab — i.e. for every normal signup that didn't come via /new.
  function getDemoSessionId() {
    try {
      const s = demoTelemetryReadState();
      return s ? s.id : null;
    } catch (e) {
      return null;
    }
  }

  // Records one funnel event. No-ops silently if no session exists, which
  // is the normal case everywhere except /new and a demo-originated signup.
  //
  // `extra` fields are whitelisted and clamped here to exactly what the
  // Firestore rule accepts — an out-of-range or wrong-typed value would
  // otherwise fail the whole write, so it's better to clamp locally and
  // land a slightly-squashed value than to lose the event entirely.
  function recordDemoEvent(key, extra) {
    try {
      const s = demoTelemetryReadState();
      if (!s) return;
      if (s.seq >= DEMO_TELEMETRY_MAX_SEQ) return;

      const now = Date.now();
      const ev = {
        sessionId: s.id,
        seq: s.seq + 1,
        key: key,
        atMs: Math.max(0, now - s.startedAt),
        deltaMs: Math.max(0, now - (s.lastAtMs || s.startedAt)),
      };

      if (extra && typeof extra === 'object') {
        if (typeof extra.qIndex === 'number' && isFinite(extra.qIndex)) {
          ev.qIndex = Math.min(8, Math.max(1, Math.round(extra.qIndex)));
        }
        if (typeof extra.format === 'string' && extra.format) {
          ev.format = extra.format.replace(/\s+/g, ' ').trim().slice(0, 12);
        }
        if (typeof extra.correct === 'boolean') {
          ev.correct = extra.correct;
        }
        if (typeof extra.xpEarned === 'number' && isFinite(extra.xpEarned)) {
          ev.xpEarned = Math.min(10000, Math.max(0, Math.round(extra.xpEarned)));
        }
        if (typeof extra.tile === 'string' && extra.tile) {
          ev.tile = extra.tile.replace(/\s+/g, ' ').trim().slice(0, 40);
        }
        if (typeof extra.uid === 'string' && extra.uid) {
          ev.uid = extra.uid;
        }
      }

      s.seq = ev.seq;
      s.lastAtMs = now;
      s.pending = (s.pending || []).concat([ev]).slice(-DEMO_TELEMETRY_MAX_PENDING);
      demoTelemetryWriteState(s);

      flushDemoTelemetry();
    } catch (e) { /* telemetry must never affect the demo */ }
  }

  // Attempts to send everything not yet confirmed written. Called after
  // every recordDemoEvent(), and once more on the real app when a
  // demo-originated signup is detected — which is what gives events
  // stranded by a flaky connection on /new a second chance to land after
  // the navigation.
  function flushDemoTelemetry() {
    try {
      const s = demoTelemetryReadState();
      if (!s || !s.pending || !s.pending.length) return;
      s.pending.slice().forEach(sendDemoEvent);
    } catch (e) { /* ignore */ }
  }

  function demoTelemetryDocId(ev) {
    const seq = String(ev.seq);
    return ev.sessionId + '-' + (seq.length < 2 ? '0' + seq : seq);
  }

  // Firestore's REST API wants explicitly-typed field values, and integers
  // must be sent as strings (JSON numbers would be read back as doubles,
  // and the rule's `is int` checks would then reject every event).
  function demoTelemetryFields(ev) {
    const f = {
      sessionId: { stringValue: ev.sessionId },
      seq: { integerValue: String(ev.seq) },
      key: { stringValue: ev.key },
      atMs: { integerValue: String(ev.atMs) },
      deltaMs: { integerValue: String(ev.deltaMs) },
    };
    if (typeof ev.qIndex === 'number') f.qIndex = { integerValue: String(ev.qIndex) };
    if (typeof ev.format === 'string') f.format = { stringValue: ev.format };
    if (typeof ev.correct === 'boolean') f.correct = { booleanValue: ev.correct };
    if (typeof ev.xpEarned === 'number') f.xpEarned = { integerValue: String(ev.xpEarned) };
    if (typeof ev.tile === 'string') f.tile = { stringValue: ev.tile };
    if (typeof ev.uid === 'string') f.uid = { stringValue: ev.uid };
    return f;
  }

  function sendDemoEvent(ev) {
    try {
      if (demoTelemetryInFlight[ev.seq]) return;
      demoTelemetryInFlight[ev.seq] = true;

      const headers = { 'Content-Type': 'application/json' };
      // Only account_created is (and must be) authenticated — the rule
      // requires request.auth.uid to match the uid field, which is what
      // makes a conversion impossible to fake from outside.
      if (ev.key === 'account_created' && demoTelemetryIdToken) {
        headers['Authorization'] = 'Bearer ' + demoTelemetryIdToken;
      }

      const url = DEMO_TELEMETRY_ENDPOINT +
        '?documentId=' + encodeURIComponent(demoTelemetryDocId(ev)) +
        '&key=' + encodeURIComponent(DEMO_TELEMETRY_API_KEY);

      fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ fields: demoTelemetryFields(ev) }),
      })
        .then((res) => {
          demoTelemetryInFlight[ev.seq] = false;
          // 409 means this exact document already exists — a duplicate
          // send of an event that did land. Same outcome as a fresh 200,
          // so clear it from pending either way.
          if (res && (res.ok || res.status === 409)) clearDemoPending(ev.seq);
        })
        .catch(() => {
          // Left in pending; a later event's flush will retry it.
          demoTelemetryInFlight[ev.seq] = false;
        });
    } catch (e) {
      demoTelemetryInFlight[ev.seq] = false;
    }
  }

  function clearDemoPending(seq) {
    try {
      const s = demoTelemetryReadState();
      if (!s || !s.pending) return;
      s.pending = s.pending.filter((p) => p.seq !== seq);
      demoTelemetryWriteState(s);
    } catch (e) { /* ignore */ }
  }

  // As recordDemoEvent(), but guaranteed to log a given key at most once per
  // session. Used for signup_screen_reached, which fires on a page load and
  // would otherwise log again every time someone refreshes the signup page
  // or navigates back to it — turning one person into several arrivals.
  function recordDemoEventOnce(key, extra) {
    try {
      const s = demoTelemetryReadState();
      if (!s) return;
      s.logged = s.logged || {};
      if (s.logged[key]) return;
      s.logged[key] = true;
      demoTelemetryWriteState(s);
      recordDemoEvent(key, extra);
    } catch (e) { /* ignore */ }
  }

  // Called by auth.js immediately after a successful signup that followed a
  // demo. The token is required by the rule; without it the write is
  // rejected, so this records nothing rather than queueing an event that
  // could only ever fail. `converted` is stored so a second signup in the
  // same tab can't log a second conversion for one session.
  function recordDemoConversion(uid, idToken) {
    try {
      const s = demoTelemetryReadState();
      if (!s || s.converted) return;
      if (!uid || !idToken) return;
      demoTelemetryIdToken = idToken;
      s.converted = true;
      demoTelemetryWriteState(s);
      recordDemoEvent('account_created', { uid: uid });
    } catch (e) { /* ignore */ }
  }
