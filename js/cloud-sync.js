// Firestore progress sync: pulling/merging/pushing progress, debounced push.


  // --- Auth ---------------------------------------------------------

  let cloudSyncTimer = null;

  // --- Cloud progress sync -------------------------------------------

  // Same defensive shape-merge as loadProgress()/importProgress() below,
  // applied to whatever's stored in Firestore so a malformed or
  // partial cloud doc can't corrupt local state.
  //
  // THIS IS A SHAPE GATE. It starts from defaultProgress() and copies across
  // only the fields named below, so ANY field not explicitly listed here is
  // silently reset to its default on the next cloud pull — even though
  // doCloudPush() sends the whole object and Firestore holds it correctly.
  // The data survives the round trip out and is destroyed on the way back in.
  //
  // Adding a field to defaultProgress() therefore means adding it in FOUR
  // places: defaultProgress(), loadProgress(), importProgress() (all in
  // progress-xp.js) and here. Miss this one and the symptom is progress that
  // saves, displays correctly, and then quietly reverts a moment later —
  // exactly how Story Mode's storiesRead/storyLifetime behaved on 2026-09-09.
  function mergeProgressShape(parsed) {
    const merged = defaultProgress();
    merged.wordStats = normalizeWordStats(parsed.wordStats || {});
    merged.verbStats = normalizeWordStats(parsed.verbStats || {});
    merged.streak = Object.assign(merged.streak, parsed.streak || {});
    merged.conjugateStreak = Object.assign(merged.conjugateStreak, parsed.conjugateStreak || {});
    merged.lifetime = Object.assign(merged.lifetime, parsed.lifetime || {});
    merged.conjugateLifetime = Object.assign(merged.conjugateLifetime, parsed.conjugateLifetime || {});
    merged.timeAttackBest = typeof parsed.timeAttackBest === 'number' ? parsed.timeAttackBest : 0;
    merged.masteredWordsCount = typeof parsed.masteredWordsCount === 'number' ? parsed.masteredWordsCount : 0;
    merged.taLifetime = Object.assign(merged.taLifetime, parsed.taLifetime || {});
    merged.memoryBest = Object.assign({}, parsed.memoryBest || {});
    merged.memoryLifetime = Object.assign(merged.memoryLifetime, parsed.memoryLifetime || {});
    merged.streamLifetime = Object.assign(merged.streamLifetime, parsed.streamLifetime || {});
    merged.storyLifetime = Object.assign(merged.storyLifetime, parsed.storyLifetime || {});
    merged.storiesRead = Object.assign({}, parsed.storiesRead || {});
    merged.memoryClearedSizes = Object.assign({}, parsed.memoryClearedSizes || {});
    merged.settings = Object.assign(merged.settings, parsed.settings || {});
    merged.achievements = Object.assign({}, parsed.achievements || {});
    merged.dailyDoubleLastHandled = typeof parsed.dailyDoubleLastHandled === 'string' ? parsed.dailyDoubleLastHandled : null;
    merged.dailyDoubleBonusXP = typeof parsed.dailyDoubleBonusXP === 'number' ? parsed.dailyDoubleBonusXP : 0;
    merged.dailyXPGoal = typeof parsed.dailyXPGoal === 'number' && parsed.dailyXPGoal > 0 ? parsed.dailyXPGoal : DEFAULT_DAILY_XP_GOAL;
    merged.dailyStreak = Object.assign(merged.dailyStreak, parsed.dailyStreak || {});
    merged.lastActiveDate = typeof parsed.lastActiveDate === 'string' ? parsed.lastActiveDate : null;
    merged.recentActiveDates = Array.isArray(parsed.recentActiveDates) ? parsed.recentActiveDates.slice(-14) : [];
    merged.todaySnapshot = Object.assign({}, merged.todaySnapshot, parsed.todaySnapshot || {});
    merged.dailyGoalCelebratedDate = typeof parsed.dailyGoalCelebratedDate === 'string' ? parsed.dailyGoalCelebratedDate : null;
    // Absent means data written before IDs existed — treat as text keys so the one-off remap knows to run.
    merged.keyVersion = typeof parsed.keyVersion === 'number' ? parsed.keyVersion : 1;
    return merged;
  }

  async function pullCloudProgress(uid) {
    try {
      const snap = await window.PalabraAuth.getUserDoc(uid);
      if (snap.exists() && snap.data().progress) {
        const data = snap.data();
        const remoteMs = data.updatedAtMs || 0;
        if (remoteMs < state.lastSyncedMs) {
          // This device has already pushed something newer than this
          // snapshot — skip it so older cloud data can't clobber more
          // recent local progress (e.g. a push from this device still
          // landing, or a slow read racing a faster write elsewhere).
          return;
        }
        state.progress = mergeProgressShape(data.progress);
        state.username = data.username || '';
        state.lastSyncedMs = remoteMs;
        state.progressDirty = false;
        // Resync the level baseline silently — this data may reflect a
        // level reached on a different device, and shouldn't replay a
        // celebration here for a milestone this device didn't just earn.
        state.lastKnownLevel = getXPLevel(state.progress).level;
        // Write straight to localStorage rather than via saveProgress(),
        // which would also schedule another cloud push — a pull should
        // never trigger a push right back, or two open tabs can end up
        // volleying stale writes at each other.
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); } catch (e) {}
        // A pull replaces state.progress wholesale, so data that predates
        // the ID keys can arrive here long after the word list loaded and
        // the local remap already ran. Re-checked rather than assumed:
        // it's gated on the incoming data's own keyVersion, so it does
        // nothing unless this particular copy still needs migrating.
        remapProgressKeysToIds();
      } else {
        // Signed-in user with no cloud doc yet — this is a genuinely new
        // account (email/password signups already write a doc in
        // handleAuthSubmit before this ever runs, so in practice this only
        // fires for a first-time Google sign-in, or the rare edge case
        // that comment above already described). Same rule as email
        // signup: never carry forward whatever's currently local — it may
        // belong to a different account previously used on this device.
        state.progress = defaultProgress();
        state.progress.dailyDoubleLastHandled = todayDateString(); // same grace-day rule as email signup
        const ms = Date.now();
        await window.PalabraAuth.setUserDoc(uid, {
          progress: state.progress,
          createdAtMs: ms,
          createdAt: window.PalabraAuth.serverTimestamp(),
          updatedAtMs: ms,
          updatedAt: window.PalabraAuth.serverTimestamp(),
          platform: detectPlatform()
        });
        state.lastSyncedMs = ms;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); } catch (e) {}
        const provider = (state.user && state.user.providerData && state.user.providerData[0] && state.user.providerData[0].providerId === 'google.com') ? 'google' : 'email';
        notifyNewSignup(state.user && state.user.email, provider);
      }
    } catch (err) {
      // Offline or blocked — fall back silently to local progress.
    }
  }

  // Debounced so a run of quick answers doesn't fire a Firestore write per
  // answer — resets on every call, actually writes once things go quiet.
  // Pushes with updateDoc, which REPLACES progress outright, rather than
  // setDoc(..., { merge: true }), which deep-merges it.
  //
  // The difference was invisible for as long as Palabra only ever added
  // words: a merge adds new keys happily, and no key was ever removed. The
  // word-ID migration removes 125 records, and under a merged write those
  // removals simply never reached Firestore - the server document ended up
  // holding BOTH the old text-keyed records and the new id-keyed ones, about
  // 40,200 index entries against Firestore's hard ceiling of 40,000 per
  // document. Firestore rejected the whole write with "too many index
  // entries for entity", the catch below swallowed it, and every reload
  // pulled the stale cloud copy back over the migrated local one.
  //
  // A replacing write means the document holds exactly what the device
  // holds, which is both correct and about half the size.
  function doCloudPush() {
    if (!state.user) return Promise.resolve();
    const ms = Date.now();
    const payload = {
      progress: state.progress,
      username: state.username || null,
      updatedAtMs: ms,
      updatedAt: window.PalabraAuth.serverTimestamp()
    };
    const uid = state.user.uid;
    const write = window.PalabraAuth.updateUserDoc
      ? window.PalabraAuth.updateUserDoc(uid, payload).catch((err) => {
          // updateDoc requires the document to exist. A brand-new account can
          // race its own creation, so fall back to the create path once
          // rather than losing that first push.
          if (err && err.code === 'not-found') return window.PalabraAuth.setUserDoc(uid, payload);
          throw err;
        })
      : window.PalabraAuth.setUserDoc(uid, payload);

    return write.then(() => {
      state.lastSyncedMs = ms;
      state.progressDirty = false;
    }).catch((err) => {
      // Offline or blocked — local progress is still safe and will retry next
      // time saveProgress() runs. Logged rather than silently discarded: a
      // push that fails every time for a structural reason (as the index-entry
      // rejection above did) is otherwise completely invisible, and the only
      // symptom is progress quietly reverting on the next load.
      console.warn('Palabra: progress push failed —', (err && err.code) || '', (err && err.message) || err);
    });
  }

  function pushCloudProgressDebounced() {
    if (!state.user) return;
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = setTimeout(doCloudPush, 2500);
  }

  // Pushes any not-yet-synced local change immediately (skipping the
  // debounce wait), used before pulling fresh cloud data so a genuine
  // unsaved local change can't get clobbered by an older cloud copy. If
  // nothing has actually changed locally since the last sync, this is a
  // no-op — pushing a stale-but-unchanged copy just to "flush" would stamp
  // it with a fresh timestamp and let it wrongly win over genuinely newer
  // data from another device, which is exactly the bug this exists to avoid.
  function flushCloudSync() {
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if (!state.progressDirty) return Promise.resolve();
    return doCloudPush();
  }
