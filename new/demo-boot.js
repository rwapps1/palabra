// /new landing-page demo — boot script.
//
// Loads last, after config.js/utils.js/audio.js/progress-xp.js/
// achievements.js/word-selection.js/conjugation-engine.js/game-quiz.js/
// game-timeattack.js/game-memory.js/game-conjugate.js/render-quiz.js/
// render-hub.js/render-timeattack.js/render-memory.js/render-conjugate.js/
// render-progress.js/render-dispatch.js/navigation.js (all reused
// completely unmodified — see index.html's own comments for why each
// other file was left out).
//
// This file supplies its own throwaway `state` object rather than loading
// the real state.js, because state.js's progress field comes from
// loadProgress() — which reads localStorage['palabraProgress_v1'], the
// EXACT key the real signed-in app uses. If this device already has a
// real Palabra account, that read would be harmless on its own, but it
// would mean the demo starts from (and could visually display) someone's
// real progress instead of a fresh one. Building a brand new in-memory
// state/progress object here instead sidesteps that entirely — nothing
// in this file ever reads real app storage, and (see saveProgress()
// below) nothing it does ever writes to it either.
//
// Three small, deliberate overrides of otherwise-untouched game engine
// functions are defined at the bottom: saveProgress() (drop persistence
// entirely — Firestore push already no-ops with no state.user, so this
// only needs to skip the localStorage line), nextQuestion() (end the
// round after these fixed 8 questions instead of Stream's normal
// 20-question checkpoint/infinite-topup behavior), and render() (wrapped,
// not replaced — adds the demo-only "already have an account" escape
// hatch and the results-screen single CTA).
//
// 2026-08-28 (read-only "explore the app" layer): previously every single
// tap anywhere on the hub screen redirected straight to signup — nothing
// beyond the initial 8-question round was ever actually visible. Agreed
// with Rob: a demo visitor should now be free to browse the mode picker,
// Time Attack/Memory Match setup, My Progress, and Achievements, and only
// hit the signup wall the moment they'd actually start playing something
// (Settings, Continue/Start Stream, any mode's Start button) or tap
// something this demo's hardcoded word list has nothing real to show for
// (the Sentences and Conjugate tiles, and any individual Categories
// entry — see the click-gate at the bottom for the full reasoning).
// navigation.js is now loaded (previously it wasn't — this page had NO
// back-button history protection at all, for any screen, which is
// exactly the "hole" Rob suspected) so hardware/gesture back now works
// through every one of these newly-browsable screens the same proven way
// it already works in the real app, right down to "back on the hub
// closes the app" — no demo-specific back-button code needed anywhere in
// this file; it all comes from loading the real, unmodified navigation.js.

  // ---- Word pool ----
  // The 8 curated target words plus filler so getDistractors() has real
  // candidates for multiple-choice options. Hardcoded rather than pulled
  // from words.xlsx on purpose — this page is the first thing an ad
  // visitor sees and can't depend on a spreadsheet fetch succeeding, and
  // shouldn't silently change if the real word list changes later.
  const DEMO_FILLER_WORDS = [
    { es: 'casa', en: 'house' },
    { es: 'perro', en: 'dog' },
    { es: 'gato', en: 'cat' },
    { es: 'libro', en: 'book' },
    { es: 'amigo', en: 'friend' },
    { es: 'día', en: 'day' },
    { es: 'noche', en: 'night' },
    { es: 'mesa', en: 'table' },
    { es: 'sol', en: 'sun' },
    { es: 'luna', en: 'moon' },
    { es: 'café', en: 'coffee' },
    { es: 'playa', en: 'beach' },
    { es: 'coche', en: 'car' },
    { es: 'niño', en: 'boy' },
  ];

  // The fixed 8-question order, agreed in advance: safe cognate wins to
  // open, one genuine stretch (agua, typed — no spelling giveaway) placed
  // second-to-last so the round still ends on a confident note either way.
  const DEMO_QUESTIONS = [
    { es: 'hotel', en: 'hotel', format: 'mc', direction: 'es-en' },
    { es: 'gracias', en: 'thank you', format: 'audio', direction: 'es-en' },
    { es: 'animal', en: 'animal', format: 'mc', direction: 'es-en' },
    { es: 'hola', en: 'hello', format: 'truefalse', direction: 'es-en' },
    { es: 'chocolate', en: 'chocolate', format: 'audio', direction: 'es-en' },
    {
      es: 'hospital', en: 'hospital', format: 'cloze', direction: 'es-en',
      sentence: 'Voy al hospital porque estoy enfermo.',
      sentenceTranslation: "I'm going to the hospital because I'm sick.",
    },
    { es: 'agua', en: 'water', format: 'type', direction: 'es-en' },
    { es: 'familia', en: 'family', format: 'truefalse', direction: 'es-en' },
  ];

  // 2026-08-28: now keeping .sentence/.sentenceTranslation (previously
  // stripped down to just es/en). Needed so sentencePairs() finds the one
  // real sentence this demo already has (hospital) — without it the
  // Sentences tile renders `disabled` (see render-hub.js's noSentenceWords
  // check) and a disabled button never fires a click event at all, which
  // would make it impossible for the click-gate below to ever redirect a
  // tap on it to signup, as agreed with Rob. This is not new content —
  // just no longer discarding a field that was already there.
  const DEMO_WORD_POOL = DEMO_QUESTIONS
    .map(q => ({ es: q.es, en: q.en, sentence: q.sentence, sentenceTranslation: q.sentenceTranslation }))
    .concat(DEMO_FILLER_WORDS);

  // ---- Throwaway state object ----
  // Same shape as the real state.js, minus loadProgress() (see header
  // comment). 2026-08-28: now carries the full shape, including the
  // Time Attack / Memory Match / Conjugate / category-loading fields that
  // used to be left out here — those modes' setup screens (and, for
  // Conjugate, quitConjugateRound via navigation.js) are now reachable
  // from this page's mode picker, so those fields need to actually exist
  // rather than read back undefined.
  const state = {
    screen: 'demo-intro',
    user: null,
    username: '',
    showMenu: false,
    loading: false,
    error: '',
    showUpload: false,
    pairs: DEMO_WORD_POOL,
    mainPool: DEMO_WORD_POOL,
    questions: DEMO_QUESTIONS.map(q => ({ ...q })),
    index: 0,
    input: '',
    checked: false,
    wasCorrect: false,
    results: [],
    newBestThisRound: false,
    progress: defaultProgress(),
    effectiveAnswerMode: 'type',
    currentOptions: null,
    selectedOption: null,
    autoAdvanceTimer: null,
    autoAdvanceDelay: 0,
    celebrateTimer: null,
    celebrateVariant: null,
    celebrateNext: null,
    lastKnownLevel: null,
    pendingLevelUp: null,
    levelUpNextFn: null,
    levelUpTimer: null,
    queuedAchievementToasts: [],
    lastFlippedIndex: -1,
    lastWasTypo: false,
    resultMode: 'round',
    isDailyDoubleRound: false,
    // true for the whole round — this is what makes prepareQuestion()/
    // renderQuiz() use each question's own .format instead of a single
    // round-level answer mode. Flipped to false only at the very end,
    // matching the real stopStream()'s own behavior, purely so
    // renderResult() renders the same way a real Stream result would.
    isStreamRound: true,
    lastRoundWasStream: false,
    lastRoundWasSentences: false,
    streamCheckpointCount: 0,
    streamSessionStreak: 0,
    streamSessionCheckpoints: 0,
    streamFormatsCorrect: {},
    tfClaimEn: '',
    tfIsTrue: false,
    tfSessionStreak: 0,
    scrambleBank: [],
    scramblePlaced: [],
    scrambleSessionStreak: 0,
    activeCategory: null,
    categoryPairs: [],
    categoryLoading: false,
    categoryError: '',
    achievementGroup: null,
    quitConfirmMode: null,
    // ---- Added 2026-08-28 for the read-only "explore the app" layer ----
    // Time Attack / Memory Match / Conjugate setup screens (and, for
    // Conjugate, navigation.js's BACK_QUIT_HANDLERS referencing
    // quitConjugateRound at parse time) now get loaded on this page — see
    // index.html's comment — so these fields need to exist with the exact
    // same defaults state.js gives them, copied straight from there.
    taActive: false,
    taScore: 0,
    taStreak: 0,
    taTimeLeft: 60,
    taEndTime: 0,
    taTimerHandle: null,
    taFlashTimer: null,
    taCurrentQuestion: null,
    taCurrentOptions: null,
    taInput: '',
    taIsNewBest: false,
    memoryTiles: [],
    memoryFlipped: [],
    memoryMatchedCount: 0,
    memoryTotalPairs: 0,
    memoryMoves: 0,
    memoryBusy: false,
    memoryStartTime: 0,
    memorySeconds: 0,
    memoryTimerHandle: null,
    memoryFlipTimer: null,
    memoryIsNewBest: false,
    memoryJustFlipped: [],
    memoryReacting: [],
    verbPairs: [],
    verbsLoaded: false,
    verbsLoading: false,
    verbsError: '',
    conjugateQuestions: [],
    conjugateIndex: 0,
    conjugateResults: [],
    conjugateInput: '',
    conjugateChecked: false,
    conjugateWasCorrect: false,
    conjugateCurrentOptions: null,
    conjugateSelectedOption: null,
    conjugateNewBestStreak: false,
    conjugateLastWasTypo: false,
    // Not part of the real app's state shape — checked only by this
    // file's own render() wrapper and click-gate below.
    isDemoMode: true,
  };

  // The hub's "Today" panel (XP today / Words today) is a snapshot diff —
  // computeXP() now minus computeXP() at the moment todaySnapshot was last
  // baselined (progress-xp.js's ensureTodaySnapshot()/getTodayXP()). In
  // the real app that baseline always gets set on the hub's very first
  // render of the day, which always happens BEFORE Stream starts (Stream
  // is launched from the hub). This demo runs the opposite order —
  // questions happen before the hub is ever shown — so without this call,
  // the baseline would only get set the first time the hub renders, i.e.
  // AFTER the round, at the exact XP total just earned, making "today"
  // net out to zero. Calling it here, before any answer is recorded,
  // baselines it at the true starting point (0) instead.
  ensureTodaySnapshot();

  // ---- Stub for the one remaining cross-file call this page's included
  // files still make, whose real implementation lives in a file
  // deliberately not loaded here (auth.js — no account exists yet). It's
  // a no-op-with-a-guard in the real app too when there's no signed-in
  // user, so functionally this changes nothing — it just avoids a
  // ReferenceError since auth.js itself isn't present to define it.
  //
  // 2026-08-28: syncBackHistory() and runAsTimerAdvance() used to be
  // stubbed here as well, back when navigation.js wasn't loaded on this
  // page at all (see index.html's comment for why that changed — this
  // page previously had no back-button history protection whatsoever).
  // Both are now the real, unmodified functions navigation.js defines.
  function pingActivity() {}

  // ---- Funnel telemetry ----
  // Starts the session record (see js/demo-telemetry.js) and logs the very
  // first event. page_load is the one measurement that can't be inferred
  // from anything else: without it there's no way to distinguish "clicked
  // the ad and bounced instantly" from "clicked the ad, read the intro
  // card, and decided not to start" — which are different problems with
  // different fixes. Everything after this point is timed relative to it.
  //
  // Deliberately the visibility-aware variant, not startDemoTelemetrySession()
  // plus a direct recordDemoEvent('page_load'): a background tab that Chrome
  // discards and silently reloads would otherwise log a landing no human was
  // present for. See the function's own comment for the full reasoning.
  //
  // Internally wrapped and cannot throw. Not awaited.
  startDemoTelemetryWhenVisible();

  // How many answers have already been logged, so the render() wrapper
  // below can log each new one exactly once. Instrumenting via render()
  // rather than by wrapping submitAnswer() is deliberate: game-quiz.js and
  // render-quiz.js are reused completely unmodified here, and the wrapper
  // only reads state fields (state.results / state.questions) that are
  // part of the shared state shape — so it can't be broken by an internal
  // refactor of how answers get submitted, and doesn't need to know which
  // of the several answer paths (typed, tapped option, true/false) ran.
  let demoAnswersLogged = 0;
  let demoResultsLogged = false;
  let demoHubLogged = false;

  // Best-effort label for which hub tile someone tapped before being sent
  // to signup — the point being to learn what people actually wanted to
  // look at. Falls back through data-mode, then element id, then trimmed
  // text, then 'unknown'; never throws, and always returns a string short
  // enough to satisfy the Firestore rule's 40-character cap.
  // Which hub tile someone tapped before being sent to signup — the point
  // being to learn what people actually wanted to look at.
  //
  // Targets [data-tile] first, which is how render-hub.js identifies every
  // real tile (gamemodes / myprogress / achievements / each game tile),
  // then buttons and links by id (start-stream-btn, dd-row, menu-btn).
  //
  // Deliberately does NOT match a bare [id] any more: the old version did,
  // and a tap on card padding or background matched the #app wrapper and
  // recorded the tile as "app" — technically true, completely useless, and
  // exactly what happened in session e7xs on 2026-08-27. A tap that isn't
  // on anything interactive is now reported as such, which is itself worth
  // knowing: it means someone prodded the screen rather than chose a tile.
  function demoTileLabel(target) {
    try {
      if (!target || !target.closest) return 'unknown';
      const el = target.closest('[data-tile], button, a');
      if (!el) return 'non-tile area';
      // .tile-name is the tile's own label; preferred over textContent,
      // which would drag in the icon, the meta line and any "Soon" badge.
      const nameEl = el.querySelector ? el.querySelector('.tile-name') : null;
      const raw = el.getAttribute('data-tile')
        || el.id
        || (nameEl ? nameEl.textContent : '')
        || el.textContent
        || '';
      const cleaned = String(raw).replace(/\s+/g, ' ').trim();
      return (cleaned || 'unknown').slice(0, 40);
    } catch (e) {
      return 'unknown';
    }
  }

  // ---- Achievement gate ----
  // The demo is meant to feel like one genuine, modest win - "First
  // Steps" - not a fireworks show of every achievement a lucky perfect
  // run happens to qualify for. With only 8 questions, a player who
  // answers everything correctly (very possible - most of this lineup is
  // deliberately easy) would also legitimately qualify for Perfect Round,
  // Triple Threat, and Quadruple Threat all at once via the real
  // evaluateRoundAchievements()/recordAnswer() logic (untouched, see
  // below) - four unlocks' worth of bonus XP (20 each) stacked with the
  // streak/correct-answer XP was enough on its own to blow straight past
  // the real app's default 60 XP daily goal before the person even has an
  // account. Gating to firstRound only keeps that first real hub view
  // modest and genuine rather than looking already "maxed out" on day
  // one. Declared as a plain reassignment, not a `function` declaration -
  // a same-name function declaration here would hoist and shadow the
  // real achievements.js version before this line even runs, capturing
  // itself instead of the real implementation.
  const realUnlockAchievement = unlockAchievement;
  unlockAchievement = function (id) {
    if (id !== 'firstRound') return false;
    return realUnlockAchievement(id);
  };

  // ---- Safe persistence override ----
  // Firestore push already no-ops with no state.user (see the real
  // pushCloudProgressDebounced in cloud-sync.js — not loaded here anyway).
  // The only real risk was the localStorage.setItem line in the original
  // saveProgress(), which would write to the exact key the real signed-in
  // app reads from. Dropping it here means this whole page can safely
  // reuse the real recordAnswer()/unlockAchievement()/etc. machinery
  // unmodified — every one of them already routes through saveProgress()
  // rather than touching storage directly. checkLevelUp()/
  // checkDailyGoalCrossed() are kept since they only touch state fields
  // in memory.
  function saveProgress() {
    state.progressDirty = true;
    checkLevelUp();
    checkDailyGoalCrossed();
  }

  // ---- Demo-started notification ----
  // Mirrors notifyNewSignup() in auth.js exactly — same Telegram Bot API
  // call, same fire-and-forget/never-throws shape, reusing the same
  // TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID constants already loaded via
  // config.js (no new token, no new file). A failed or disabled
  // notification must never get in the way of someone actually starting
  // the demo.
  function notifyDemoStarted() {
    if (!TELEGRAM_CHAT_ID) return;
    try {
      fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: '🚀 Someone started the Palabra demo\nvia /new landing page',
        }),
      }).catch(() => {});
    } catch (e) { /* ignore — notification is best-effort only */ }
  }

  // ---- Fixed-length round override ----
  // The real nextQuestion() only ends a Stream round via the 20-question
  // checkpoint, topping up the batch with buildStreamBatch() (random
  // words/formats from whatever pool is active) whenever it runs low —
  // exactly what a curated, fixed 8-question demo must never do. This
  // replaces it with the same ending path Quiz/Sentences/Daily Double
  // already use once the fixed question list runs out, while still
  // relying on state.isStreamRound === true throughout the round itself
  // so prepareQuestion()/renderQuiz() keep using each question's own
  // per-question .format.
  function nextQuestion() {
    clearAutoAdvanceTimer();
    if (state.index + 1 >= state.questions.length) {
      const score = state.results.filter(r => r.correct).length;
      const total = state.results.length;
      const perfect = total > 0 && score === total;
      state.lastRoundWasStream = true;
      state.isStreamRound = false;
      suppressAchievementFX = true;
      evaluateRoundAchievements();
      suppressAchievementFX = false;
      showCelebration(perfect ? 'perfect' : 'finished', 'result');
      return;
    }
    state.index += 1;
    state.input = '';
    state.checked = false;
    prepareQuestion();
    render();
  }

  // ---- Signup handoff ----
  // Stashes exactly the fields auth.js's handleAuthSubmit() knows how to
  // fold into a brand-new signup (see js/auth.js), shows a brief message
  // so the jump to signup doesn't feel abrupt, then sends the person to
  // the real app's signup tab. Read and cleared there, once — never
  // touched by signing in to an existing account.
  //
  // 2026-08-28 (back-button fix): this used to be a bare DOM overlay,
  // appended straight to <body> with its own untracked setTimeout redirect
  // — invisible to navigation.js entirely. Confirmed live: pressing back
  // while it was showing DID correctly return to the previous screen (or,
  // from the hub, correctly exited — see navigation.js's own comments) via
  // navigation.js's generic click-#back-btn fallback, but the redirect
  // timer kept running regardless, uncancelled — so a few seconds later the
  // app navigated to signup anyway, out from under whatever the person had
  // backed out to look at. Worse, opened from the hub floor (navDepth 0,
  // no real entry to land back on at all) there was nothing for a back
  // press to do BUT exit for real. Fixed by making this its own real
  // screen ('demo-signup') instead of a floating overlay: entering and
  // leaving it goes through the exact same render()/syncBackHistory() path
  // as every other screen, so it always gets a genuine history entry —
  // even from the floor — and back always has somewhere real to land.
  // 'demo-signup' isn't in any of navigation.js's own floor/swallow/quit
  // sets, so hardware back on it falls through to that file's generic
  // fallback (click whatever #back-btn it finds) completely unmodified —
  // see renderDemoSignupModal()'s own comment for how that's pointed at
  // cancelDemoSignup() instead of the screen underneath's own back button.
  let signupHandoffStarted = false; // true only while this screen is showing / mid-redirect — reset on cancel so a later gated tap can show it again
  let demoSignupPrevScreen = null;
  let demoSignupTimer = null;

  function goToSignupFromDemo() {
    // Guards against a double-tap while this screen is already showing
    // (still possible during the redirect's own delay) stacking a second
    // history entry/timer.
    if (signupHandoffStarted) return;
    signupHandoffStarted = true;

    recordDemoEvent('signup_modal_opened');

    try {
      const handoff = {
        wordStats: state.progress.wordStats,
        streak: state.progress.streak,
        lifetime: state.progress.lifetime,
        achievements: state.progress.achievements,
        dailyStreak: state.progress.dailyStreak,
        lastActiveDate: state.progress.lastActiveDate,
        recentActiveDates: state.progress.recentActiveDates,
      };
      sessionStorage.setItem(DEMO_HANDOFF_KEY, JSON.stringify(handoff));
    } catch (e) {
      // Storage blocked (e.g. private browsing) — signup still proceeds
      // normally on the other end, just without the carried-over demo
      // progress.
    }

    demoSignupPrevScreen = state.screen;
    state.screen = 'demo-signup';
    render();
  }

  // Draws the modal itself. render-dispatch.js's real render() has no
  // 'demo-signup' branch, so calling it (from the wrapper below) leaves
  // #app's markup exactly as it was — the screen the modal was opened over
  // stays visible underneath, exactly as intended.
  function renderDemoSignupModal() {
    if (document.querySelector('.dd-modal-backdrop')) return; // already showing

    // navigation.js's hardware-back fallback does
    // `document.getElementById('back-btn').click()` on whatever it finds —
    // and the screen underneath's own #back-btn is still sitting in the
    // (untouched) DOM right now. Renaming it out of the way so that lookup
    // finds OUR hook below instead is what makes back cancel this screen
    // and land exactly back where the tap came from, rather than clicking
    // through to that screen's own parent. Nothing needs to put the id
    // back afterward — cancelDemoSignup() re-renders the previous screen
    // from scratch, which draws it a brand new #back-btn of its own.
    const underlyingBack = document.getElementById('back-btn');
    if (underlyingBack) underlyingBack.removeAttribute('id');

    // A centered modal, not a toast — reuses the Daily Double popup's own
    // shell classes (dd-modal-backdrop/dd-card/dd-ring-*, loaded via
    // daily-double.css) for the dimmed-background/centered-card look,
    // since a corner achievement-style toast read as a reward rather
    // than what this actually is: a requirement before continuing. The
    // shell/ring/eyebrow/headline/subline are Daily Double's classes reused
    // (not its content); the benefits list and countdown bar below are this
    // modal's own (`.demo-signup-*`, styled in daily-double.css alongside
    // the dd- rules it sits next to).
    //
    // 2026-08-28: restored the benefits copy and 6-second countdown bar
    // that had been agreed earlier and were missing from the zip this
    // session built from — Rob flagged the plain version as a regression,
    // not a new request. Copy is his own remembered wording verbatim
    // (1,100+ words / 6 modes / spaced repetition / free & no ads); he
    // didn't have the original file to confirm exact phrasing beyond that,
    // so this is a fresh rewrite of those four points, not a byte-for-byte
    // restore — flag if the wording should be closer to the original.
    const modal = document.createElement('div');
    modal.className = 'dd-modal-backdrop';
    modal.innerHTML = `
      <div class="dd-card">
        <div class="dd-ring-outer">
          <div class="dd-ring-disc">
            <div class="dd-ring-inner"><span style="font-size:34px;">💾</span></div>
          </div>
        </div>
        <div class="dd-eyebrow">Almost there</div>
        <h2 class="dd-headline">Create your account</h2>
        <p class="dd-subline">to save your progress</p>
        <ul class="demo-signup-benefits">
          <li><span class="demo-signup-check">✓</span>1,100+ Spanish words</li>
          <li><span class="demo-signup-check">✓</span>6 game modes</li>
          <li><span class="demo-signup-check">✓</span>Spaced repetition — practice what you actually need</li>
          <li><span class="demo-signup-check">✓</span>Free, no ads</li>
        </ul>
        <div class="demo-signup-countdown"><div class="demo-signup-countdown-fill"></div></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Invisible on purpose — this is a hook for navigation.js's generic
    // back-button fallback to find and click, not a visible on-screen
    // control (Rob's own modal design has no dismiss button; only the
    // hardware/gesture back path was reported broken).
    const backHook = document.createElement('button');
    backHook.id = 'back-btn';
    backHook.type = 'button';
    backHook.style.display = 'none';
    backHook.addEventListener('click', cancelDemoSignup);
    modal.appendChild(backHook);

    // 6000ms to match the countdown bar's own CSS animation duration below
    // (.demo-signup-countdown-fill in daily-double.css) — keep the two in
    // sync if either ever changes; nothing ties them together automatically.
    demoSignupTimer = setTimeout(() => {
      window.location.href = '../index.html?signup=1';
    }, 6000);
  }

  // Back-button path off the demo-signup screen: cancels the pending
  // redirect, removes the modal, and returns exactly to the screen the tap
  // came from — letting the person keep exploring instead of either being
  // dumped at signup a moment later regardless, or (from the hub, where
  // there'd otherwise be no real history entry at all to land back on)
  // exiting the app outright.
  function cancelDemoSignup() {
    if (demoSignupTimer) { clearTimeout(demoSignupTimer); demoSignupTimer = null; }
    document.querySelectorAll('.dd-modal-backdrop').forEach((m) => m.remove());
    signupHandoffStarted = false;
    const back = demoSignupPrevScreen || 'start';
    demoSignupPrevScreen = null;
    state.screen = back;
    render();
  }

  // Sends someone straight to the real app, letting its own normal
  // initAuth() flow decide what they see — the sign-in form if they're
  // not currently signed in anywhere on this device, or straight to their
  // real hub if they already have an active session here.
  function goToSignInFromDemo() {
    window.location.href = '../index.html';
  }

  // ---- Intro screen ----
  // Shown first, before any question. Deliberately hand-authored here
  // rather than reusing renderStart() (render-hub.js) for this screen —
  // renderStart() draws the whole hub (Today panel, mode picker, level
  // ring, achievements row), all of which would show meaningless
  // all-zero stats before a single question's been answered. This reuses
  // the exact same CSS classes as renderStart()'s own hero card
  // (stream-hero/format-row/fchip/hub-start-btn/etc., all already loaded
  // via hub.css/components.css) so it's visually identical to the real
  // one — just this one card, no menu button (nothing behind it would do
  // anything meaningful pre-signup anyway), and the button always reads
  // "Start Stream" rather than the real card's playedToday-dependent
  // Continue/Start toggle, since this is always someone's first-ever
  // visit here.
  function renderDemoIntro() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="screen upload-screen bg-quiz">
        <div class="wrap">
          <div class="header-row" style="justify-content: space-between;">
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="badge"></span>
              <h1>Palabra</h1>
            </div>
          </div>
          <div class="card stream-hero hub-hero-pulse">
            <div class="format-row"><span class="fchip">🔤</span><span class="fchip">🔊</span><span class="fchip">✎</span></div>
            <h2>Try 8 questions</h2>
            <p>About a minute, no account needed. Finish to see your progress and what's inside.</p>
            <button id="demo-start-btn" class="btn-primary hub-start-btn">
              <span class="hub-play-chip">▶</span>Start Stream
            </button>
          </div>
          <button id="demo-signin-link-intro" class="link-btn" type="button" style="display:block; text-align:center; width:100%; margin-top:14px;">Already have an account? Sign in</button>
        </div>
      </div>
    `;
    document.getElementById('demo-start-btn').addEventListener('click', () => {
      notifyDemoStarted();
      recordDemoEvent('start_tapped');
      state.screen = 'quiz';
      prepareQuestion();
      render();
    });
    document.getElementById('demo-signin-link-intro').addEventListener('click', goToSignInFromDemo);
  }

  // ---- render() wrapper ----
  // render-dispatch.js's render() itself is left completely untouched;
  // this wraps it rather than editing it, so every screen it already
  // knows how to draw (quiz/celebrate/result/start/game-modes/my-progress/
  // achievements/etc.) keeps working exactly as in the real app. Two extra
  // pseudo-screens are handled here, entirely outside the real dispatcher,
  // which doesn't know either name and would silently render nothing for
  // them:
  //   - 'demo-intro', handled BEFORE realRender() runs at all (it draws a
  //     whole different screen, not an addition to one of the real ones).
  //   - 'demo-signup' (see goToSignupFromDemo()'s own comment), handled
  //     AFTER realRender() — which does nothing for an unrecognized screen
  //     name, deliberately, so #app is left showing whatever screen the
  //     modal was opened over rather than being blanked or redrawn.
  // Beyond that, two small, purely additive things happen after the real
  // render() returns for an ordinary screen, both gated on isDemoMode:
  //   1. quiz screen — an "Already have an account?" link under Quit.
  //   2. result screen — replace Play again/Change settings with a single
  //      "See your progress" button (agreed: only one path forward here).
  // Which taps lead to signup vs. stay browsable (mode picker, category
  // list, My Progress, Achievements, etc.) is handled entirely by the
  // click-gate further below, not by this wrapper.
  const realRender = render;
  render = function () {
    if (state.isDemoMode && state.screen === 'demo-intro') {
      renderDemoIntro();
      return;
    }
    realRender();
    if (!state.isDemoMode) return;

    if (state.screen === 'demo-signup') {
      renderDemoSignupModal();
      return;
    }

    // ---- Telemetry taps ----
    // Run before the cosmetic DOM tweaks below so a thrown error in any of
    // those can't cost us the event. Each is logged exactly once.
    //
    // Answers are drained as a loop rather than a single check because a
    // round can end without a further render in between the last answer
    // being recorded and the celebration screen replacing the quiz screen
    // — the loop guarantees the eighth answer is logged even in that case.
    while (demoAnswersLogged < state.results.length) {
      const i = demoAnswersLogged;
      const q = state.questions[i];
      const res = state.results[i];
      recordDemoEvent('question_answered', {
        qIndex: i + 1,
        format: q ? q.format : 'unknown',
        correct: !!(res && res.correct),
      });
      demoAnswersLogged += 1;
    }

    // 'celebrate' is the screen that actually appears first at round end;
    // 'result' follows it. Either one counts as "they finished all eight",
    // and whichever arrives first is the honest timestamp for that.
    if (!demoResultsLogged && (state.screen === 'celebrate' || state.screen === 'result')) {
      demoResultsLogged = true;
      let xp = null;
      try {
        if (typeof computeXP === 'function') xp = Math.round(computeXP(state.progress));
      } catch (e) { /* xpEarned is a nice-to-have, not worth risking the event for */ }
      recordDemoEvent('results_reached', (typeof xp === 'number' && isFinite(xp)) ? { xpEarned: xp } : null);
    }

    if (!demoHubLogged && state.screen === 'start') {
      demoHubLogged = true;
      recordDemoEvent('hub_viewed');
    }

    if (state.screen === 'quiz') {
      // The top progress-tile row: render-quiz.js's own renderQuiz()
      // builds this assuming a Stream round's 20-question checkpoint
      // block (state.streamCheckpointCount), which this demo's
      // nextQuestion() override deliberately never increments (see its
      // own comment above) - so left untouched it always drew a static
      // row of 20 slots with only the first one ever lit. Replaced here
      // with an 8-slot version using the exact same fill logic
      // render-quiz.js's own fixed-length (non-Stream) branch already
      // uses elsewhere, just inlined rather than calling it, since it's
      // markup generation, not a function this file can invoke directly.
      const tilesEl = document.querySelector('.tiles');
      if (tilesEl) {
        tilesEl.style.gridTemplateColumns = `repeat(${state.questions.length}, 1fr)`;
        let tilesHtml = '';
        state.questions.forEach((_, i) => {
          let bg = 'var(--outline)';
          if (i < state.results.length) bg = state.results[i].correct ? COLORS.green : COLORS.red;
          else if (i === state.index) bg = COLORS.ochre;
          tilesHtml += `<div class="tile" style="background:${bg}"></div>`;
        });
        tilesEl.innerHTML = tilesHtml;
      }

      const quitBtn = document.getElementById('quiz-quit-btn');
      if (quitBtn && !document.getElementById('demo-signin-link')) {
        const link = document.createElement('button');
        link.id = 'demo-signin-link';
        link.className = 'link-btn';
        link.type = 'button';
        link.style.display = 'block';
        link.style.textAlign = 'center';
        link.style.width = '100%';
        link.style.marginTop = '10px';
        link.textContent = 'Already have an account? Sign in';
        link.addEventListener('click', goToSignInFromDemo);
        quitBtn.insertAdjacentElement('afterend', link);
      }
    }

    if (state.screen === 'result') {
      const again = document.getElementById('again-btn');
      if (again) again.remove();
      const settings = document.getElementById('settings-btn');
      if (settings) settings.remove();
      const body = document.querySelector('.screen-body');
      if (body && !document.getElementById('demo-continue-btn')) {
        const cta = document.createElement('button');
        cta.id = 'demo-continue-btn';
        cta.className = 'btn-primary';
        cta.style.width = '100%';
        cta.style.marginBottom = '10px';
        cta.textContent = 'See your progress →';
        cta.addEventListener('click', () => { leaveResults(goHome); });
        body.appendChild(cta);
      }
    }
  };

  // ---- "Disabled in demo mode" toast ----
  // Daily Double claims a real bonus round the same way Start does, so by
  // rights it should lead to signup too — but Rob asked for a plain,
  // non-navigating notice instead, since a first-ever visitor being told
  // to make an account just to see a returning-user bonus feature reads
  // oddly. Reuses the exact same toast markup/CSS classes as
  // achievements.js's showComingSoonToast()/showDailyGoalToast()
  // (.achievement-toast/.toast-icon/.toast-title/.toast-name, defined in
  // progress.css, already loaded) rather than introducing a new visual
  // style just for this one case.
  function showDemoDisabledToast() {
    const toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML = `<div class="toast-icon">🎁</div><div><div class="toast-title">Daily Double</div><div class="toast-name">Disabled in demo mode</div></div>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('show'); });
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, 2000);
  }

  // ---- Read-only browse / signup click-gate ----
  // Replaces the old blanket "any click on the hub redirects to signup"
  // gate. Browsing is now allowed through render-hub.js's/render-quiz.js's/
  // etc.'s own real, completely unmodified click handlers for everything
  // EXCEPT the specific actions below, agreed with Rob:
  //
  //   - #menu-btn        — hub Settings (⋯)
  //   - #start-stream-btn — hub Continue/Start Stream
  //   - #start-btn        — every mode's own Start button. Reused
  //                         verbatim by Quiz, Time Attack, Memory Match,
  //                         and category-quiz setup screens alike, so
  //                         gating this one id covers all of them
  //                         regardless of how deep in the menu tree it's
  //                         tapped from.
  //   - [data-tile="sentences"] — the Sentences tile on the mode picker.
  //                         Gated at the TILE itself, before ever opening
  //                         sentences-setup: this demo's hardcoded word
  //                         list has only one real sentence, so the setup
  //                         screen would have nothing meaningful to show.
  //   - [data-tile="verbs"]     — the Conjugate tile, same reasoning:
  //                         none of this demo's words carry the
  //                         "conjugation" category tag conjugate-setup
  //                         needs, so it would only ever show a "No verbs
  //                         found" error. Gated at the tile itself rather
  //                         than shown broken, matching the Sentences
  //                         treatment above — flagging this as an
  //                         inference from Rob's Sentences/Categories
  //                         answers, not something explicitly asked for,
  //                         in case he'd rather it behaved differently.
  //   - [data-cat]        — any individual category on the Categories
  //                         list. The list ITSELF (CATEGORIES, from
  //                         config.js) stays freely browsable — it's pure
  //                         static config, no word data involved — but
  //                         selecting one would hit the exact same "no
  //                         words tagged" problem as Conjugate, so it's
  //                         gated on selection rather than opening
  //                         category-setup to show an empty state.
  //
  // Daily Double (#dd-row) is handled separately above — a toast, not a
  // redirect, per Rob's decision.
  const SIGNUP_GATE_SELECTOR = '#menu-btn, #start-stream-btn, #start-btn, [data-tile="sentences"], [data-tile="verbs"], [data-cat]';

  document.addEventListener('click', function (e) {
    if (!state.isDemoMode) return;
    const app = document.getElementById('app');
    if (!app || !app.contains(e.target)) return;

    // Daily Double: notice, not a redirect. Checked first since #dd-row
    // would otherwise fall through to the "let it through" branch below
    // (it isn't in SIGNUP_GATE_SELECTOR) and run the real
    // handleDailyDoublePlay() handler, actually starting a round.
    if (e.target.closest('#dd-row')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state.screen === 'start') recordDemoEvent('hub_tap', { tile: demoTileLabel(e.target) });
      showDemoDisabledToast();
      return;
    }

    const gated = e.target.closest(SIGNUP_GATE_SELECTOR);
    if (!gated) {
      // Not a gated action — let the real handler run (browsing). Still
      // worth recording which hub tile someone tapped, browsing or not:
      // that's the funnel signal hub_tap exists to capture, and it's
      // arguably more useful now paired with how far they get afterward.
      if (state.screen === 'start') recordDemoEvent('hub_tap', { tile: demoTileLabel(e.target) });
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    // Logged before goToSignupFromDemo()'s own guard can swallow a
    // double-tap, so the first tap's tile is always the one recorded.
    if (state.screen === 'start') recordDemoEvent('hub_tap', { tile: demoTileLabel(e.target) });
    goToSignupFromDemo();
  }, true);

  // ---- Go ----
  // Shows the intro card first (see renderDemoIntro() above) —
  // prepareQuestion() is deferred until "Start Stream" is tapped, not run
  // here.
  render();
