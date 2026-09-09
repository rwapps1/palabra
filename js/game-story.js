// Story Mode rules and flow: the library, the reader, the reader's dwell
// timer, the end-of-story word quiz, and story achievements.
//
// MUST load after game-quiz.js — showCelebration(), advanceFromCelebration(),
// leaveResults() and goHome() all live there and are called directly below.
//
// ---------------------------------------------------------------------------
// THE ONE RULE THIS FILE EXISTS TO KEEP
//
// Nothing here may call recordAnswer(). That function is the SRS: it writes
// wordStats, moves the box, sets nextDue, updates masteredWordsCount, the
// answer streak, and lifetime.totalAnswered/totalCorrect, and it unlocks the
// Quiz achievements. Reading a story must not move a single box — tapping a
// word to see what it means is curiosity, not a failed recall, and demoting a
// word for it would poison the review schedule of anyone who reads.
//
// recordStoryAnswer() below is the deliberate, much smaller replacement. It
// touches storyLifetime and nothing else. If a future change here needs
// something recordAnswer() does, copy the specific line — do not call it.
// ---------------------------------------------------------------------------


  // ---- Library ---------------------------------------------------------

  // The manifest is fetched once per session and kept on state. Failing to
  // load it is a normal, recoverable condition (offline on a first visit),
  // not an error worth a console trace — the library screen renders the
  // message and a Try again button.
  function openStoryLibrary() {
    state.screen = 'story-library';
    state.storyError = '';
    if (state.storyIndexLoaded) { render(); return; }
    state.storyLoading = true;
    render();
    fetch(STORIES_INDEX, { cache: 'no-cache' })
      .then(res => { if (!res.ok) throw new Error('manifest ' + res.status); return res.json(); })
      .then(list => {
        state.storyIndex = Array.isArray(list) ? list : [];
        state.storyIndexLoaded = true;
        state.storyLoading = false;
        state.storyError = '';
        render();
      })
      .catch(() => {
        state.storyLoading = false;
        state.storyError = "Couldn't load the stories. Check your connection and try again.";
        render();
      });
  }

  function retryStoryLibrary() {
    state.storyIndexLoaded = false;
    openStoryLibrary();
  }

  // ---- Opening one story -----------------------------------------------

  function openStory(storyId) {
    const entry = state.storyIndex.find(s => s.id === storyId);
    if (!entry) return;
    state.storyLoading = true;
    state.storyError = '';
    state.screen = 'story-read';
    resetStoryReadState();
    render();

    fetch(STORIES_DIR + storyId + '.json', { cache: 'no-cache' })
      .then(res => { if (!res.ok) throw new Error('story ' + res.status); return res.json(); })
      .then(story => {
        state.activeStory = story;
        state.storyLoading = false;
        startStoryReadTimer();
        render();
      })
      .catch(() => {
        state.activeStory = null;
        state.storyLoading = false;
        state.storyError = "Couldn't load that story. Check your connection and try again.";
        render();
      });
  }

  // Everything about one reading session. Called when a story is opened, and
  // again when a finished story is re-opened, so a re-read starts clean.
  function resetStoryReadState() {
    stopStoryReadTimer();
    state.storyReadMs = 0;
    state.storyOpenParas = {};
    state.storyAllRevealed = false;
    state.storyTapped = {};
    state.storyPopover = null;
    state.storyQuestions = [];
    state.storyQIndex = 0;
    state.storyResults = [];
    state.storySelectedOption = null;
    state.storyChecked = false;
    state.storyWasCorrect = false;
  }

  // ---- The dwell timer -------------------------------------------------
  //
  // Accumulates FOREGROUND time only. Without the visibilitychange pause a
  // backgrounded PWA/TWA would clock up the 30 seconds while the phone sits
  // in a pocket, which defeats the point of the threshold entirely.
  //
  // Deliberately a wall-clock delta rather than a setInterval tick count:
  // background timers get throttled hard in Android WebViews, so counting
  // ticks would undercount even honest foreground reading.

  function storyTimerTick() {
    if (!state.storyReadLastTick) return;
    const now = Date.now();
    state.storyReadMs += now - state.storyReadLastTick;
    state.storyReadLastTick = now;
  }

  function startStoryReadTimer() {
    if (state.storyReadLastTick) return; // already running
    state.storyReadLastTick = Date.now();
  }

  function stopStoryReadTimer() {
    if (!state.storyReadLastTick) return;
    storyTimerTick();
    state.storyReadLastTick = 0;
  }

  // Registered once, at load. Only does anything while the reader is the
  // current screen, so it costs nothing on every other screen in the app.
  document.addEventListener('visibilitychange', () => {
    if (state.screen !== 'story-read') return;
    if (document.visibilityState === 'hidden') stopStoryReadTimer();
    else startStoryReadTimer();
  });

  function storyReadMsSoFar() {
    if (!state.storyReadLastTick) return state.storyReadMs;
    return state.storyReadMs + (Date.now() - state.storyReadLastTick);
  }

  // ---- Reader interactions ---------------------------------------------
  //
  // All three of these are in-memory only and must stay that way. They are
  // transient UI layers on top of the reader, not navigable screens — giving
  // any of them a history entry is exactly the mistake documented at length
  // in navigation.js's quit-confirm branch.

  function toggleStoryWord(token, occurrence, anchorRect) {
    if (state.storyPopover && state.storyPopover.token === token && state.storyPopover.occurrence === occurrence) {
      state.storyPopover = null;
    } else {
      state.storyPopover = { token, occurrence, rect: anchorRect };
      state.storyTapped[token] = true;
    }
    render();
  }

  function closeStoryPopover() {
    if (!state.storyPopover) return;
    state.storyPopover = null;
    render();
  }

  function toggleStoryParagraph(i) {
    if (state.storyOpenParas[i]) delete state.storyOpenParas[i];
    else state.storyOpenParas[i] = true;
    state.storyPopover = null;
    render();
  }

  function toggleStoryRevealAll() {
    state.storyAllRevealed = !state.storyAllRevealed;
    state.storyPopover = null;
    render();
  }

  // True if the reader was used with no help at all — no word tapped, no
  // paragraph opened, no full reveal. Read at finish time, for 'storyNoHelp'.
  function storyWasUnaided() {
    return Object.keys(state.storyTapped).length === 0
      && Object.keys(state.storyOpenParas).length === 0
      && !state.storyAllRevealed;
  }

  // Looks up a word's gloss, honouring per-occurrence overrides. The same
  // written form can mean different things in one story — "para" is twice
  // "for" and once "she stops" in Las llaves de Elena — so a flat lookup
  // table is not enough on its own.
  function storyGlossFor(token, occurrence) {
    const story = state.activeStory;
    if (!story) return null;
    const overrides = story.glossOverrides || {};
    const byToken = overrides[token];
    if (byToken && byToken[String(occurrence)]) return byToken[String(occurrence)];
    return (story.gloss || {})[token] || null;
  }

  // ---- Finishing the read ----------------------------------------------

  function finishStoryRead() {
    stopStoryReadTimer();
    const story = state.activeStory;
    if (!story) return;

    // The completion award is gated on real reading time (see
    // MIN_STORY_READ_MS in config.js). Per-answer XP is not — answering is
    // its own evidence — so a skipped story can still earn from the quiz.
    if (state.storyReadMs >= MIN_STORY_READ_MS) {
      if (!state.progress.storyLifetime) state.progress.storyLifetime = { storiesCompleted: 0, totalCorrect: 0 };
      state.progress.storyLifetime.storiesCompleted += 1;
      if (!state.progress.storiesRead) state.progress.storiesRead = {};
      if (!state.progress.storiesRead[story.id]) state.progress.storiesRead[story.id] = Date.now();
      // Reading is practice. Someone who reads a story on a busy day has
      // done the work, and shouldn't lose a day streak over it.
      markDailyActivity();
      saveProgress();
    }

    startStoryQuiz();
  }

  // ---- The end-of-story quiz -------------------------------------------
  //
  // Six of the story's target words, always ES→EN — that is the direction the
  // reading just rehearsed, so settings.direction is deliberately ignored
  // here. Distractors come from the shared getDistractors() rather than being
  // authored into the story file, so they are the same quality as every other
  // mode and a story never has to be re-authored when the word list grows.

  function buildStoryQuestions(story) {
    const targets = (story.targetWords || []);
    const questions = [];
    targets.forEach(target => {
      const pair = state.pairs.find(p => normalize(primaryText(p.es)) === normalize(target));
      if (!pair) return; // word not in the current list — skip rather than show a broken question
      const q = { ...pair, direction: 'es-en' };
      const correctText = splitAnswers(q.en)[0];
      const distractors = getDistractors(q, correctText, 2);
      if (distractors.length < 2) return; // list too small for a fair question
      questions.push({ ...q, correctText, options: shuffle([correctText, ...distractors]) });
    });
    return shuffle(questions);
  }

  function startStoryQuiz() {
    const story = state.activeStory;
    state.storyQuestions = buildStoryQuestions(story);
    state.storyQIndex = 0;
    state.storyResults = [];
    state.storySelectedOption = null;
    state.storyChecked = false;
    state.storyWasCorrect = false;

    // No usable questions (word list not loaded, or too small for
    // distractors) — the reading still counts, so go straight to results
    // rather than showing an empty quiz.
    if (state.storyQuestions.length === 0) {
      finishStoryQuiz();
      return;
    }
    state.screen = 'story-quiz';
    render();
  }

  // The deliberate, SRS-free replacement for recordAnswer(). See the block
  // comment at the top of this file.
  function recordStoryAnswer(current, correct, userAnswerDisplay) {
    state.storyWasCorrect = correct;
    state.storyChecked = true;
    state.storyResults.push({
      prompt: primaryText(current.es),
      correctAnswer: primaryText(current.en),
      userAnswer: userAnswerDisplay,
      correct,
    });

    if (!state.progress.storyLifetime) state.progress.storyLifetime = { storiesCompleted: 0, totalCorrect: 0 };
    if (correct) state.progress.storyLifetime.totalCorrect += 1;
    // NOT lifetime.totalCorrect — that counter feeds the Quiz achievements
    // correct50/correct200 and their hub teaser, and story answers landing
    // there would silently inflate badges earned in a different mode.
    markDailyActivity();
    saveProgress();

    if (correct) playCorrectSound(); else playWrongSound();
    if (state.progress.storyLifetime.totalCorrect >= 50) unlockAchievement('storyCorrect50');
  }

  function selectStoryOption(optionText) {
    const current = state.storyQuestions[state.storyQIndex];
    if (!current || state.storyChecked) return;
    const acceptable = splitAnswers(current.en).map(normalize);
    const correct = acceptable.includes(normalize(optionText));
    state.storySelectedOption = optionText;
    recordStoryAnswer(current, correct, optionText);
    render();
    // Same rhythm as selectOption() in game-quiz.js.
    const delay = correct ? 750 : 3000;
    state.autoAdvanceTimer = setTimeout(() => { nextStoryQuestion(); }, delay);
  }

  function nextStoryQuestion() {
    clearAutoAdvanceTimer();
    if (state.storyQIndex + 1 >= state.storyQuestions.length) {
      finishStoryQuiz();
      return;
    }
    state.storyQIndex += 1;
    state.storySelectedOption = null;
    state.storyChecked = false;
    render();
  }

  function finishStoryQuiz() {
    clearAutoAdvanceTimer();
    const score = state.storyResults.filter(r => r.correct).length;
    const total = state.storyResults.length;
    const perfect = total > 0 && score === total;

    state.resultMode = 'story';
    // Cleared so a story can never be mistaken for a quiz round by the
    // shared results/celebration machinery.
    state.lastRoundWasStream = false;
    state.lastRoundWasSentences = false;

    suppressAchievementFX = true;
    evaluateStoryAchievements(perfect, total);
    suppressAchievementFX = false;

    // Reuses the shared celebration verbatim: it already wraps its own
    // render() in runAsTimerAdvance (so the auto-advance to results uses
    // replaceState, not the untrusted pushState that caused the 2026-08
    // back-button bug), plays the right sound, fires the confetti on a
    // perfect, and flushes the queued achievement toasts on the way out.
    showCelebration(perfect ? 'perfect' : 'finished', 'result');
  }

  function evaluateStoryAchievements(perfect, totalAnswered) {
    const lifetime = state.progress.storyLifetime || { storiesCompleted: 0, totalCorrect: 0 };
    const distinct = Object.keys(state.progress.storiesRead || {}).length;

    if (lifetime.storiesCompleted >= 1) unlockAchievement('storyFirst');
    if (distinct >= 5) unlockAchievement('storyDistinct5');
    if (distinct >= 15) unlockAchievement('storyDistinct15');
    if (perfect && totalAnswered > 0) unlockAchievement('storyPerfect');
    // Only counts on a story that actually counted as read — otherwise
    // opening and immediately finishing would unlock it without reading
    // a word, which is the opposite of what it is for.
    if (storyWasUnaided() && state.storyReadMs >= MIN_STORY_READ_MS) unlockAchievement('storyNoHelp');
  }

  // ---- Leaving ---------------------------------------------------------

  // Both exits from the reader. No quit-confirm, deliberately: unlike a quiz
  // round there is nothing to lose — nothing has been scored yet, and the
  // story is still there to re-open.
  function leaveStoryRead() {
    stopStoryReadTimer();
    state.storyPopover = null;
    state.screen = 'story-library';
    render();
  }

  function leaveStoryQuiz() {
    clearAutoAdvanceTimer();
    // Score whatever was answered rather than discarding it — those answers
    // were already recorded and their XP already earned.
    finishStoryQuiz();
  }

  function goToStoryLibraryFromResult() {
    state.resultMode = 'round';
    state.activeStory = null;
    resetStoryReadState();
    state.screen = 'story-library';
    render();
  }

  function rereadCurrentStory() {
    const story = state.activeStory;
    state.resultMode = 'round';
    if (!story) { goToStoryLibraryFromResult(); return; }
    resetStoryReadState();
    state.screen = 'story-read';
    startStoryReadTimer();
    render();
  }
