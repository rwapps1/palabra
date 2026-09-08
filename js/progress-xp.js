// Progress load/save, XP and level maths, and SRS box helpers.
// MUST load before state.js — state.js calls loadProgress() immediately
// when the state object is constructed.


  function defaultProgress() {
    return {
      wordStats: {},
      verbStats: {},
      streak: { current: 0, best: 0 },
      conjugateStreak: { current: 0, best: 0 },
      lifetime: { totalAnswered: 0, totalCorrect: 0 },
      conjugateLifetime: { totalAnswered: 0, totalCorrect: 0 },
      timeAttackBest: 0,
      taLifetime: { totalAnswered: 0, totalCorrect: 0 },
      memoryBest: {},
      memoryLifetime: { boardsCleared: 0, bySize: { '6': 0, '8': 0, '12': 0 } },
      memoryClearedSizes: {},
      streamLifetime: { totalAnswered: 0, totalCorrect: 0, checkpointsCompleted: 0, audioCorrect: 0 },
      masteredWordsCount: 0, // words that have EVER reached box 6 — permanent, never drops if a word later regresses (see ws.masteredEver)
      settings: { direction: 'mixed', roundLength: '10', autoSpeak: true, answerMode: 'choice', soundEffects: true, memoryGridSize: '8' },
      achievements: {},
      dailyDoubleLastHandled: null, // 'YYYY-MM-DD' of last Play decision, local device date
      dailyDoubleBonusXP: 0,        // cumulative bonus from completed Daily Double rounds
      dailyXPGoal: DEFAULT_DAILY_XP_GOAL, // user-adjustable, default 60
      dailyStreak: { current: 0, best: 0 }, // daily login/practice streak (distinct from in-session answer streak)
      lastActiveDate: null,         // 'YYYY-MM-DD' of the last day with qualifying activity — gates the streak increment
      recentActiveDates: [],        // trimmed list of qualifying-activity dates (last ~14), drives the week pip strip
      todaySnapshot: { date: null, xpAtStart: 0, answeredAtStart: 0 }, // baseline computeXP()/answered-count at the start of "today", used to derive today's XP/words live
      dailyGoalCelebratedDate: null, // 'YYYY-MM-DD' of the last day the "goal reached" toast was shown, so it only fires once per day
      keyVersion: PROGRESS_KEY_VERSION, // shape of the wordStats/verbStats keys — see remapProgressKeysToIds(). A brand-new account starts on the current scheme with nothing to migrate; data loaded from anywhere else defaults to 1 (text keys) unless it says otherwise.
    };
  }

  function achievementIdsForGroup(group) {
    const allIds = Object.keys(ACHIEVEMENTS);
    if (group.prefix === null) {
      const otherPrefixes = ACHIEVEMENT_GROUPS.filter(g => g.prefix).map(g => g.prefix);
      return allIds.filter(id => !otherPrefixes.some(p => id.startsWith(p)));
    }
    return allIds.filter(id => id.startsWith(group.prefix));
  }

  // Reverse of achievementIdsForGroup() — which group does a given
  // achievement id belong to. Used to jump straight to an achievement's
  // detail screen (e.g. from the hub's "closest to unlocking" teaser)
  // instead of dropping the person on the top-level Achievements list.
  function groupIdForAchievement(id) {
    const prefixed = ACHIEVEMENT_GROUPS.find(g => g.prefix && id.startsWith(g.prefix));
    if (prefixed) return prefixed.id;
    const fallback = ACHIEVEMENT_GROUPS.find(g => g.prefix === null);
    return fallback ? fallback.id : ACHIEVEMENT_GROUPS[0].id;
  }

  function computeXP(progress) {
    let xp = 0;
    xp += progress.lifetime.totalCorrect * XP_PER_QUIZ_CORRECT;
    xp += progress.conjugateLifetime.totalCorrect * XP_PER_CONJUGATE_CORRECT;
    xp += progress.taLifetime.totalCorrect * XP_PER_TIMEATTACK_CORRECT;

    const bySize = (progress.memoryLifetime && progress.memoryLifetime.bySize) || {};
    let trackedBoards = 0;
    Object.keys(XP_MEMORY_BOARD).forEach(size => {
      const count = bySize[size] || 0;
      trackedBoards += count;
      xp += count * XP_MEMORY_BOARD[size];
    });
    // Boards cleared before per-size tracking existed still count, just at
    // a flat rate since we don't know what size they were.
    const totalBoards = (progress.memoryLifetime && progress.memoryLifetime.boardsCleared) || 0;
    const legacyBoards = Math.max(0, totalBoards - trackedBoards);
    xp += legacyBoards * XP_MEMORY_LEGACY;

    xp += progress.streak.best * XP_PER_BEST_STREAK_POINT;
    xp += progress.conjugateStreak.best * XP_PER_BEST_STREAK_POINT;

    const achievementsUnlocked = Object.values(progress.achievements || {}).filter(a => a && a.unlocked).length;
    xp += achievementsUnlocked * XP_PER_ACHIEVEMENT;

    xp += progress.dailyDoubleBonusXP || 0;

    return Math.round(xp);
  }

  // Walks the compounding-XP curve to find the current level and progress
  // toward the next one. Cheap even at very high XP totals since it stops
  // the moment the cumulative threshold passes the current amount.
  function getXPLevel(progress) {
    const xp = computeXP(progress);
    let span = XP_LEVEL_BASE_SPAN;
    let cumulative = 0;
    let level = 1;
    while (cumulative + span <= xp) {
      cumulative += span;
      level += 1;
      span = Math.round(span * XP_LEVEL_GROWTH);
    }
    const xpIntoLevel = xp - cumulative;
    const pct = Math.max(0, Math.min(100, Math.round((xpIntoLevel / span) * 100)));
    return { xp, level, xpIntoLevel, xpForNextLevel: span, pct };
  }

  // Bumped when the SHAPE OF THE KEYS in wordStats/verbStats changes.
  //   1 = text-derived keys (normalize(es) + '::' + normalize(en))
  //   2 = stable row IDs ('id:74', and 'id:74::3' for verb combos)
  // Stored on the progress object so the one-off remap below knows whether
  // it still has work to do, and runs exactly once per set of data rather
  // than on every load.
  const PROGRESS_KEY_VERSION = 2;

  function normalizeWordStats(wordStats) {
    // NOTE: this used to also carry a migration that stripped a trailing
    // parenthetical off a stored key - "aquel::that (over there)" ->
    // "aquel::that" - to follow along when a disambiguator moved out of the
    // English cell into the Note column. It has been REMOVED, and it should
    // not come back.
    //
    // It caused real damage. It renamed the key but left the record's stored
    // `en` untouched, and where the renamed key already existed it returned
    // early instead of merging, stranding the original permanently. The
    // result was a word carrying two records - one holding the history, one
    // sitting at box 0 - which Daily Double then served every single day.
    // Keys are no longer derived from editable text at all (see wordKey() in
    // utils.js), so there is nothing left for it to do, and any future
    // rescue of orphaned records belongs in the deliberate one-off below
    // rather than in a routine that silently rewrites data on every load.
    Object.keys(wordStats).forEach(key => {
      const ws = wordStats[key];
      if (typeof ws.box !== 'number') {
        const right = ws.right || 0;
        const wrong = ws.wrong || 0;
        ws.box = wrong > 0 ? 0 : Math.min(right, SRS_INTERVALS_DAYS.length - 1);
        ws.nextDue = 0;
        ws.lastSeen = ws.lastSeen || 0;
      }
    });
    return wordStats;
  }

  // --- One-off text-key -> ID-key remap ---------------------------------
  //
  // Progress used to be keyed on the word's own text, so every edit to a
  // Spanish or English cell forked that word onto a fresh key and stranded
  // its history on the old one. Keys are now the stable ID in column G of
  // words.xlsx. This walks the existing records once and moves each one onto
  // its word's ID key, merging the forks back together.
  //
  // Deliberately NOT an automatic cleanup that runs on every load. A
  // well-meaning routine that quietly rewrote records on load is exactly
  // what caused the damage this is repairing. It runs once, gated on
  // progress.keyVersion, and then never again.
  //
  // Merge rule where several old records land on the same ID: keep the
  // highest box, sum right and wrong, keep masteredEver if either had it,
  // take the most recent lastSeen, and recompute nextDue from the surviving
  // box so the schedule stays internally consistent. Display text is taken
  // from the live row, not from either record.
  //
  // Records whose text matches no current row are dropped - they are
  // unreachable by definition, since nothing in the app can ever produce
  // their key again.
  //
  // Pass { dryRun: true } to get the same report back without writing
  // anything. Worth running from the console first:
  //     remapProgressKeysToIds({ dryRun: true })
  function remapProgressKeysToIds(options) {
    const dryRun = !!(options && options.dryRun);
    const report = {
      ran: false, reason: '', dryRun,
      words: { before: 0, after: 0, migrated: 0, merged: 0, dropped: 0, alreadyId: 0, recoveredByAlternatives: 0, droppedKeys: [] },
      verbs: { before: 0, after: 0, migrated: 0, merged: 0, dropped: 0, alreadyId: 0 },
      idCollisions: [],
    };

    // Nothing to map against until the word list has actually loaded.
    if (!state.pairs || state.pairs.length === 0) {
      report.reason = 'word list not loaded yet';
      return report;
    }

    // SAFETY BRAKE 1 — a word list with no IDs in it at all.
    // This is the scenario that would do real damage: a stale service-worker
    // copy of words.xlsx from before the ID column existed, or an old file
    // uploaded by hand. Every record would match nothing, and "matches
    // nothing" means "drop", so the entire history would be wiped in one
    // pass. The word list is the untrusted input here, not the progress
    // data, so refuse outright rather than migrate against it.
    const withIds = state.pairs.filter(p => p.id).length;
    if (withIds === 0) {
      report.reason = 'the loaded word list has no IDs at all — refusing to remap';
      console.warn('Palabra: ' + report.reason + '. The words.xlsx being used is probably an older copy without column G (a stale cache, or a manual upload). Nothing has been changed.');
      return report;
    }

    if (!dryRun && state.progress.keyVersion >= PROGRESS_KEY_VERSION) {
      report.reason = 'already migrated';
      return report;
    }

    // Old text key -> live row, for every row that has an ID. Two rows can
    // normalise to the same text key (accented and unaccented spellings of
    // the same word, e.g. "cuál" and "cual"), in which case they shared a
    // single record before and only one of them can inherit it - the other
    // starts fresh. Recorded rather than hidden.
    const byTextKey = {};
    const byEsKey = {};
    state.pairs.forEach(pair => {
      if (!pair.id) return;
      const tk = normalize(pair.es) + '::' + normalize(pair.en);
      if (byTextKey[tk]) report.idCollisions.push(tk);
      byTextKey[tk] = pair;
      const ek = normalize(pair.es);
      if (!byEsKey[ek]) byEsKey[ek] = pair;
    });

    // Second-chance lookup for records that match no row exactly.
    //
    // An exact match only reunites a fork when both halves of the old key
    // still appear verbatim in the sheet - which is often not the case,
    // because the forks were CAUSED by the text changing. The record holding
    // the real history is usually the one whose text is now out of date.
    // "enfermo::sick" is the clearest example: 15 correct answers and a
    // mastery flag sitting on a key the sheet can no longer produce, because
    // the Spanish cell has since become "enfermo / malo". Dropping it would
    // throw away the genuine history and keep the two-answer stub.
    //
    // So each cell is split into its alternatives and indexed by every
    // Spanish/English pairing it can produce. "enfermo / malo" = "sick"
    // registers enfermo::sick and malo::sick as well as its exact key, and
    // the orphan lands back on its own row.
    //
    // Only an unambiguous hit counts. If an old key could belong to two
    // different rows, there's no evidence for choosing between them, so it
    // is left to drop and reported rather than guessed at.
    const byAlternative = {};
    state.pairs.forEach(pair => {
      if (!pair.id) return;
      const esAlts = splitAnswers(pair.es).map(normalize);
      const enAlts = splitAnswers(pair.en).map(normalize);
      esAlts.forEach(a => enAlts.forEach(b => {
        const k = a + '::' + b;
        if (!byAlternative[k]) byAlternative[k] = new Set();
        byAlternative[k].add(pair.id);
      }));
    });

    const lookupAlternatives = (esPart, enPart) => {
      const esAlts = splitAnswers(esPart).map(normalize);
      const enAlts = splitAnswers(enPart).map(normalize);
      const hits = new Set();
      esAlts.forEach(a => enAlts.forEach(b => {
        const found = byAlternative[a + '::' + b];
        if (found) found.forEach(id => hits.add(id));
      }));
      if (hits.size !== 1) return null;
      const id = hits.values().next().value;
      return state.pairs.find(p => p.id === id) || null;
    };

    // Third and last chance: a trailing parenthetical.
    //
    // Some old keys carry a disambiguator that used to live in the English
    // cell and has since moved to the Note column - "aquel::that (over
    // there)", "ser::to be (permanent)". Those hold real history (23 correct
    // answers apiece) and nothing else will ever match them, because the
    // bracketed text appears nowhere in the sheet any more.
    //
    // Stripping the parenthetical is what the old normalizeWordStats()
    // migration did, and it is worth being clear about why doing it here is
    // not the same mistake. That one ran on every single load, renamed the
    // key while leaving the record's stored text stale, and silently gave up
    // when the destination already existed - so it created the orphans it
    // was meant to prevent. This runs once, merges into the destination
    // instead of bailing out, takes display text from the live row, and
    // reports what it did. Same observation, opposite handling.
    const findLiveRow = (key) => {
      const sep = key.indexOf('::');
      if (sep === -1) return null;
      const esPart = key.slice(0, sep);
      const enPart = key.slice(sep + 2);
      const direct = lookupAlternatives(esPart, enPart);
      if (direct) return direct;
      const strip = (s) => s.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const esStripped = strip(esPart);
      const enStripped = strip(enPart);
      if (esStripped === esPart && enStripped === enPart) return null;
      if (!esStripped || !enStripped) return null;
      return lookupAlternatives(esStripped, enStripped);
    };

    const mergeInto = (target, src, pair) => {
      if (!target) {
        target = { box: 0, nextDue: 0, right: 0, wrong: 0, lastSeen: 0 };
      }
      target.box = Math.max(target.box || 0, src.box || 0);
      target.right = (target.right || 0) + (src.right || 0);
      target.wrong = (target.wrong || 0) + (src.wrong || 0);
      target.lastSeen = Math.max(target.lastSeen || 0, src.lastSeen || 0);
      if (src.masteredEver || target.masteredEver) target.masteredEver = true;
      // Derived, not inherited: two merged records carry two unrelated
      // nextDue values, and the only one that makes sense is the one implied
      // by the box the merged record ends up in.
      target.nextDue = target.lastSeen + (SRS_INTERVALS_DAYS[target.box] || 0) * 86400000;
      if (pair) {
        target.es = primaryText(pair.es);
        target.en = primaryText(pair.en);
      }
      return target;
    };

    // --- wordStats: 'es::en' -> 'id:N' ---
    const oldWords = state.progress.wordStats || {};
    report.words.before = Object.keys(oldWords).length;
    const newWords = {};
    Object.keys(oldWords).forEach(key => {
      const ws = oldWords[key];
      if (key.indexOf('id:') === 0) {
        report.words.alreadyId++;
        newWords[key] = newWords[key] ? mergeInto(newWords[key], ws, null) : ws;
        return;
      }
      let pair = byTextKey[key];
      if (!pair) {
        pair = findLiveRow(key);
        if (pair) report.words.recoveredByAlternatives++;
      }
      if (!pair) {
        report.words.dropped++;
        if (report.words.droppedKeys.length < 100) report.words.droppedKeys.push(key);
        return;
      }
      const newKey = 'id:' + pair.id;
      if (newWords[newKey]) report.words.merged++; else report.words.migrated++;
      newWords[newKey] = mergeInto(newWords[newKey], ws, pair);
    });
    report.words.after = Object.keys(newWords).length;

    // --- verbStats: 'es::personIndex' -> 'id:N::personIndex' ---
    const oldVerbs = state.progress.verbStats || {};
    report.verbs.before = Object.keys(oldVerbs).length;
    const newVerbs = {};
    Object.keys(oldVerbs).forEach(key => {
      const vs = oldVerbs[key];
      if (key.indexOf('id:') === 0) {
        report.verbs.alreadyId++;
        newVerbs[key] = newVerbs[key] ? mergeInto(newVerbs[key], vs, null) : vs;
        return;
      }
      const sep = key.lastIndexOf('::');
      const esPart = sep === -1 ? key : key.slice(0, sep);
      const person = sep === -1 ? '' : key.slice(sep + 2);
      const pair = byEsKey[esPart];
      if (!pair || person === '') { report.verbs.dropped++; return; }
      const newKey = 'id:' + pair.id + '::' + person;
      if (newVerbs[newKey]) report.verbs.merged++; else report.verbs.migrated++;
      newVerbs[newKey] = mergeInto(newVerbs[newKey], vs, null);
    });
    report.verbs.after = Object.keys(newVerbs).length;

    report.ran = true;

    // SAFETY BRAKE 2 — a plausible-looking but wrong word list.
    // Brake 1 catches a list with no IDs; this catches one whose IDs simply
    // don't correspond to this account's history (a different list, a
    // half-written sheet, a bad re-numbering). A handful of dropped records
    // is expected and fine - they're the orphans this is meant to clear -
    // but losing most of them means the input is wrong, not the data.
    // Better to leave everything untouched and be told than to find out
    // afterwards.
    if (!dryRun && report.words.before > 20 && report.words.dropped > report.words.before / 2) {
      report.ran = false;
      report.reason = `refusing to remap: ${report.words.dropped} of ${report.words.before} records match no row in the loaded word list`;
      console.warn('Palabra: ' + report.reason + '. Nothing has been changed. Check that words.xlsx is the current one, then run remapProgressKeysToIds({ dryRun: true }) to see the detail.');
      return report;
    }

    if (dryRun) {
      report.reason = 'dry run - nothing written';
      console.log('Palabra key remap DRY RUN:', report);
      return report;
    }

    state.progress.wordStats = newWords;
    state.progress.verbStats = newVerbs;
    state.progress.keyVersion = PROGRESS_KEY_VERSION;
    // masteredWordsCount is deliberately left alone. It's a lifetime counter
    // that by design only ever goes up (see ws.masteredEver in
    // recordAnswer), and merging two mastered records into one would
    // otherwise make an already-earned achievement appear to regress.
    saveProgress();
    console.log('Palabra: progress keys migrated to word IDs.', report);
    return report;
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultProgress();
      const parsed = JSON.parse(raw);
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
    } catch (e) {
      return defaultProgress();
    }
  }

  // Detects a level-up the instant it happens, from wherever it happens —
  // saveProgress() is already called after every stat-changing action
  // across all four games, so this one hook covers everything without
  // touching each game engine individually. Doesn't show anything itself;
  // just flags it, so the actual celebration can wait for a safe moment
  // (see leaveResults() below) rather than interrupting live play.
  function checkLevelUp() {
    const level = getXPLevel(state.progress).level;
    if (state.lastKnownLevel === null) {
      // First check this session — establish the baseline, don't celebrate
      // whatever level the account already happened to be at.
      state.lastKnownLevel = level;
      return;
    }
    if (level > state.lastKnownLevel) {
      // Stash the pre-level-up value before overwriting it, so the Level
      // Up ring animation (renderLevelUp() in render-quiz.js) can draw
      // itself in from the real previous level rather than guessing
      // `level - 1` — a multi-level jump (e.g. a big XP grant) should
      // still show the actual prior number, not an approximation.
      state.pendingLevelUpFrom = state.lastKnownLevel;
      state.pendingLevelUp = level;
      state.lastKnownLevel = level;
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch (e) {
      // storage unavailable (private browsing etc.) - fail silently
    }
    state.progressDirty = true;
    pushCloudProgressDebounced();
    checkLevelUp();
    checkDailyGoalCrossed();
  }

  // Fires the one-time "daily XP goal reached" toast the moment today's XP
  // crosses progress.dailyXPGoal, mirroring checkLevelUp()'s pattern —
  // every XP-affecting write already funnels through saveProgress(), so
  // this one hook covers every source (answers, achievements, best-streak
  // bonuses) without touching each award site individually. Deliberately
  // does NOT call ensureTodaySnapshot()/getTodayXP() (progress-xp.js
  // helpers with their own saveProgress() side effect) to avoid re-entrant
  // saves — if today's snapshot genuinely isn't set yet this no-ops and
  // catches up on the next saveProgress() call, which in practice is only
  // ever moments away.
  function checkDailyGoalCrossed() {
    const today = todayDateString();
    if (state.progress.dailyGoalCelebratedDate === today) return;
    const snap = state.progress.todaySnapshot;
    if (!snap || snap.date !== today) return;
    const todayXP = Math.max(0, computeXP(state.progress) - snap.xpAtStart);
    const goal = state.progress.dailyXPGoal || DEFAULT_DAILY_XP_GOAL;
    if (todayXP >= goal) {
      state.progress.dailyGoalCelebratedDate = today;
      showDailyGoalToast();
    }
  }

  function exportProgress() {
    const blob = new Blob([JSON.stringify(state.progress, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'palabra-progress.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importProgress(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
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
        state.progress = merged;
        saveProgress();
        render();
      } catch (e) {
        alert("That file doesn't look like a valid progress export.");
      }
    };
    reader.readAsText(file);
  }

  // ---- Today panel / daily streak helpers ----

  // True if `today` is exactly the calendar day after `dateStr` (both
  // 'YYYY-MM-DD', local device dates). Used to decide whether a new day's
  // activity continues the streak or resets it.
  function isNextCalendarDay(dateStr, today) {
    if (!dateStr) return false;
    const prev = new Date(dateStr + 'T00:00:00');
    const cur = new Date(today + 'T00:00:00');
    const diffDays = Math.round((cur - prev) / 86400000);
    return diffDays === 1;
  }

  // Called from the one qualifying-activity spot in each of the four game
  // engines (recordAnswer, recordConjugateAnswer, endMemoryMatch) — NOT
  // from every saveProgress(), so toggling a setting doesn't count as
  // "practiced today". Safe to call more than once per day; only the
  // first call each day does anything.
  function markDailyActivity() {
    const today = todayDateString();
    if (state.progress.lastActiveDate === today) return;
    const wasConsecutive = isNextCalendarDay(state.progress.lastActiveDate, today);
    state.progress.dailyStreak.current = wasConsecutive ? (state.progress.dailyStreak.current || 0) + 1 : 1;
    if (state.progress.dailyStreak.current > (state.progress.dailyStreak.best || 0)) {
      state.progress.dailyStreak.best = state.progress.dailyStreak.current;
    }
    state.progress.lastActiveDate = today;
    if (!state.progress.recentActiveDates) state.progress.recentActiveDates = [];
    if (!state.progress.recentActiveDates.includes(today)) {
      state.progress.recentActiveDates.push(today);
      if (state.progress.recentActiveDates.length > 14) {
        state.progress.recentActiveDates = state.progress.recentActiveDates.slice(-14);
      }
    }
  }

  // Rolls today's XP/words baseline forward whenever the local calendar
  // day has changed since it was last set — including just from opening
  // the app the next day, not only from new activity. computeXP() is
  // fully derived from lifetime counters (see above), so this snapshot-
  // diff approach needs no per-award hooks and stays correct even as new
  // XP sources get added to computeXP() in future.
  function ensureTodaySnapshot() {
    const today = todayDateString();
    if (state.progress.todaySnapshot && state.progress.todaySnapshot.date === today) return;
    state.progress.todaySnapshot = {
      date: today,
      xpAtStart: computeXP(state.progress),
      answeredAtStart: (state.progress.lifetime.totalAnswered || 0) + (state.progress.conjugateLifetime.totalAnswered || 0),
    };
    saveProgress();
  }

  function getTodayXP() {
    ensureTodaySnapshot();
    return Math.max(0, computeXP(state.progress) - state.progress.todaySnapshot.xpAtStart);
  }

  function getTodayWordsCount() {
    ensureTodaySnapshot();
    const total = (state.progress.lifetime.totalAnswered || 0) + (state.progress.conjugateLifetime.totalAnswered || 0);
    return Math.max(0, total - state.progress.todaySnapshot.answeredAtStart);
  }

  // Monday-start 7-day pip strip for the current calendar week (local
  // time). Each entry: { date, filled, isToday }.
  function getWeekPips() {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const todayStr = todayDateString();
    const activeDates = state.progress.recentActiveDates || [];
    const pips = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      pips.push({ date: dateStr, filled: activeDates.includes(dateStr), isToday: dateStr === todayStr });
    }
    return pips;
  }

  // ---- My Progress helpers ----

  // Counts how many stats entries sit in each of the 6 SRS boxes. Works for
  // both wordStats and verbStats (same shape). Used for the box-distribution
  // bars on the My Progress screen.
  function boxCounts(statsObj) {
    const counts = [0, 0, 0, 0, 0, 0];
    Object.keys(statsObj).forEach(key => {
      const box = statsObj[key].box || 0;
      if (box >= 0 && box < counts.length) counts[box] += 1;
    });
    return counts;
  }
