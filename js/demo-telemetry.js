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
        // Captured once, at session start, so every event in the session
        // agrees — and so the real app can still stamp it on the
        // account_created event after the navigation.
        dev: isDemoDevDevice(),
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
        // Wall-clock time, as well as the relative atMs above. Needed
        // because Firestore's own document create-time isn't readable from
        // the browser SDK, so without this the dashboard has no way to say
        // when a session happened or to sort sessions newest-first. Taken
        // from the visitor's device clock, so a badly-set clock gives a
        // wrong date — acceptable, since atMs/deltaMs (which are what the
        // durations are actually computed from) stay correct regardless.
        epochMs: now,
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
        if (typeof extra.ref === 'string' && extra.ref) {
          ev.ref = extra.ref.replace(/\s+/g, '').slice(0, 80);
        }
        if (typeof extra.ua === 'string' && extra.ua) {
          ev.ua = extra.ua.replace(/\s+/g, '').slice(0, 24);
        }
        if (typeof extra.utm === 'string' && extra.utm) {
          ev.utm = extra.utm.replace(/\s+/g, '').slice(0, 24);
        }
      }

      // Stamped on EVERY event rather than just page_load, so a session
      // whose page_load was dropped from the retry queue is still
      // identifiable as the developer's. One boolean; cheap insurance.
      if (s.dev) ev.dev = true;

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
      epochMs: { integerValue: String(ev.epochMs) },
    };
    if (typeof ev.qIndex === 'number') f.qIndex = { integerValue: String(ev.qIndex) };
    if (typeof ev.format === 'string') f.format = { stringValue: ev.format };
    if (typeof ev.correct === 'boolean') f.correct = { booleanValue: ev.correct };
    if (typeof ev.xpEarned === 'number') f.xpEarned = { integerValue: String(ev.xpEarned) };
    if (typeof ev.tile === 'string') f.tile = { stringValue: ev.tile };
    if (typeof ev.uid === 'string') f.uid = { stringValue: ev.uid };
    if (typeof ev.ref === 'string') f.ref = { stringValue: ev.ref };
    if (typeof ev.ua === 'string') f.ua = { stringValue: ev.ua };
    if (typeof ev.utm === 'string') f.utm = { stringValue: ev.utm };
    if (ev.dev === true) f.dev = { booleanValue: true };
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

  // The call /new actually makes at page load — NOT startDemoTelemetrySession()
  // directly.
  //
  // Android Chrome discards background tabs under memory pressure and
  // reloads them when you return to the browser. A tab sitting on /new in
  // the background therefore fires a page load that no human was present
  // for, and that phantom landing goes straight into the "landed but never
  // started" bucket — precisely the number used to judge whether the intro
  // card is doing its job. A handful of those makes the intro look worse
  // than it is.
  //
  // So nothing is recorded, and no session even exists, until the page is
  // genuinely visible. A restored background tab is hidden at load, so it
  // stays silent until someone actually looks at it — at which point the
  // session begins and every subsequent duration is measured from the
  // moment the person really arrived, not from whenever Chrome happened to
  // reload the tab.
  //
  // Nothing else needs a visibility guard: every later event follows a tap,
  // and a hidden tab can't be tapped.
  function startDemoTelemetryWhenVisible() {
    try {
      applyDemoDevFlagFromUrl();
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        startDemoTelemetrySession();
        recordDemoEvent('page_load', demoVisitContext());
        return;
      }
      let started = false;
      const onVisible = function () {
        try {
          if (started || document.visibilityState !== 'visible') return;
          started = true;
          document.removeEventListener('visibilitychange', onVisible);
          startDemoTelemetrySession();
          recordDemoEvent('page_load', demoVisitContext());
        } catch (e) { /* ignore */ }
      };
      document.addEventListener('visibilitychange', onVisible);
    } catch (e) { /* telemetry must never affect the demo */ }
  }

  // ---- Visit context -----------------------------------------------------
  // Added 2026-08-27, after seven overnight sessions arrived with fresh
  // session ids and never got past the landing. Fresh ids meant separate
  // browser contexts, which ruled out both Rob's own tabs and address-bar
  // preloading — the signature of automated traffic. Without any of the
  // below there was no way to tell a crawler from a real ad click from
  // Rob testing, which made "landed but never started" — the single number
  // this whole exercise exists to produce — unusable.

  // localStorage, NOT sessionStorage: the point is to persist across tabs,
  // browser restarts and days, so one visit to /new?dev=1 permanently marks
  // this device as the developer's. Deliberately kept here rather than in
  // config.js: it's internal to telemetry, and config.js changing would
  // force a service-worker cache bump for no benefit.
  const DEMO_DEV_FLAG_KEY = 'palabraDemoDev_v1';

  // Known crawlers, scanners and link-preview fetchers. Not exhaustive and
  // never will be — the generic /bot|crawler|spider/ catch below handles
  // the long tail, and anything that lies about its user agent can't be
  // caught this way at all. Good enough to keep the funnel numbers honest.
  const DEMO_BOT_SIGNATURES = [
    'googlebot', 'bingbot', 'yandex', 'duckduckbot', 'baiduspider',
    'applebot', 'facebookexternalhit', 'twitterbot', 'slackbot',
    'telegrambot', 'whatsapp', 'discordbot', 'linkedinbot', 'petalbot',
    'ahrefsbot', 'semrushbot', 'mj12bot', 'dotbot', 'bytespider',
    'gptbot', 'claudebot', 'perplexitybot', 'headlesschrome',
    'phantomjs', 'python-requests', 'curl/', 'wget', 'scrapy'
  ];

  // Visiting /new?dev=1 once marks this device; /new?dev=0 unmarks it.
  // Called before the session starts so the flag is already set when
  // page_load is written.
  function applyDemoDevFlagFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('dev')) return;
      if (params.get('dev') === '0') localStorage.removeItem(DEMO_DEV_FLAG_KEY);
      else localStorage.setItem(DEMO_DEV_FLAG_KEY, '1');
    } catch (e) { /* localStorage may be unavailable; flag simply won't stick */ }
  }

  function isDemoDevDevice() {
    try {
      return localStorage.getItem(DEMO_DEV_FLAG_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  // A bucket, not the raw user-agent string. The raw string is long, and
  // storing it alongside behavioural data edges towards a device
  // fingerprint — which is exactly what was rejected when this was scoped.
  // A bucket answers the only question being asked: is this a bot, and if
  // not, roughly what kind of device.
  function coarseUserAgent() {
    try {
      const ua = (navigator.userAgent || '').toLowerCase();
      // Set by Selenium, Puppeteer, Playwright and similar. Honest
      // automation announces itself here.
      if (navigator.webdriver === true) return 'bot:webdriver';
      for (let i = 0; i < DEMO_BOT_SIGNATURES.length; i++) {
        if (ua.indexOf(DEMO_BOT_SIGNATURES[i]) !== -1) {
          return ('bot:' + DEMO_BOT_SIGNATURES[i].replace('/', '')).slice(0, 24);
        }
      }
      if (/\bbot\b|crawler|spider|crawling|preview/.test(ua)) return 'bot:other';
      if (ua.indexOf('android') !== -1) return 'android';
      if (/iphone|ipad|ipod/.test(ua)) return 'ios';
      if (!ua) return 'unknown';
      return 'desktop';
    } catch (e) {
      return 'unknown';
    }
  }

  // Where the visit came from. 'direct' covers a typed URL, a bookmark, an
  // app-to-browser handoff, or a referrer the browser chose to withhold —
  // those are genuinely indistinguishable from the page's point of view.
  // Host and path only; the query string is dropped, since it can carry
  // personal data from the referring site.
  function referrerLabel() {
    try {
      const raw = document.referrer || '';
      if (!raw) return 'direct';
      const u = new URL(raw);
      return (u.hostname + (u.pathname === '/' ? '' : u.pathname)).slice(0, 80);
    } catch (e) {
      return 'unknown';
    }
  }

  // utm_source from the landing URL — the proper attribution signal, since
  // Rob controls the ad's destination URL and can tag each campaign.
  function utmSourceLabel() {
    try {
      const v = new URLSearchParams(window.location.search || '').get('utm_source');
      return v ? v.slice(0, 24) : null;
    } catch (e) {
      return null;
    }
  }

  // Everything worth knowing about where this visit came from, gathered
  // once and attached to page_load only — it can't change mid-session.
  function demoVisitContext() {
    const ctx = { ref: referrerLabel(), ua: coarseUserAgent() };
    const utm = utmSourceLabel();
    if (utm) ctx.utm = utm;
    return ctx;
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
