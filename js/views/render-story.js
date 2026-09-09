// Renders the Story Mode library, reader, end-of-story quiz and results.
//
// Loads before render-dispatch.js (which calls these by name) and after
// render-quiz.js, whose renderCelebrate() the story flow reuses for its
// celebration screen.
//
// Every screen here renders a #back-btn. That is not decoration: navigation.js
// has no story-specific branch at all — its generic fallback finds #back-btn
// and clicks it, so hardware back behaves identically to tapping the arrow.
// Remove one and hardware back silently stops working on that screen.


  const STORY_LEVEL_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Harder' };

  // ---- Library ---------------------------------------------------------

  function renderStoryLibrary() {
    const app = document.getElementById('app');

    let bodyHtml;
    if (state.storyLoading) {
      bodyHtml = `<div class="status-line" style="justify-content:center;"><div class="spinner"></div> Loading stories…</div>`;
    } else if (state.storyError) {
      bodyHtml = `
        <div class="msg-error">${esc(state.storyError)}</div>
        <button id="story-retry-btn" class="btn-secondary" style="width:100%;">Try again</button>
      `;
    } else if (state.storyIndex.length === 0) {
      bodyHtml = `<p class="sub">No stories yet — check back soon.</p>`;
    } else {
      bodyHtml = state.storyIndex.map(s => {
        const readAt = (state.progress.storiesRead || {})[s.id];
        const levelClass = s.level === 'hard' ? 'hard' : s.level === 'medium' ? 'med' : 'easy';
        const levelLabel = STORY_LEVEL_LABELS[s.level] || 'Easy';
        return `
          <button class="story-card" data-story="${esc(s.id)}">
            <div class="story-card-title">${esc(s.title.es)}</div>
            <div class="story-card-en">${esc(s.title.en)}</div>
            <div class="story-card-meta">
              <span class="story-pill ${levelClass}">${esc(levelLabel)}</span>
              ${readAt ? `<span class="story-pill read">✓ Read</span>` : ''}
              <span class="story-card-dur">${s.wordCount} words · ${s.minutes} min</span>
            </div>
          </button>
        `;
      }).join('');
    }

    app.innerHTML = `
      <div class="screen bg-story">
        <div class="wrap">
          <div class="screen-header">
            <button id="back-btn" class="back-btn">←</button>
            <div class="screen-title">📖 Story Mode</div>
          </div>
          <p class="story-intro">Short stories in simple Spanish, in the present tense. Tap any word for its meaning, or reveal a paragraph in English when you're stuck.</p>
          ${bodyHtml}
        </div>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', goHome);
    const retry = document.getElementById('story-retry-btn');
    if (retry) retry.addEventListener('click', retryStoryLibrary);
    document.querySelectorAll('.story-card').forEach(card => {
      card.addEventListener('click', () => openStory(card.dataset.story));
    });
  }

  // ---- Reader ----------------------------------------------------------

  // Splits a paragraph into word and non-word runs, wrapping each word in a
  // tappable span. `counts` is carried across paragraphs so each word knows
  // which occurrence in the whole story it is — that is what makes
  // per-occurrence gloss overrides addressable (see storyGlossFor()).
  const STORY_WORD_RE = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)/;

  function storyParagraphHtml(text, counts, targetSet) {
    return text.split(STORY_WORD_RE).map(tok => {
      if (!STORY_WORD_RE.test(tok) || !tok) return esc(tok);
      const key = tok.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
      const isTarget = targetSet.has(key);
      const isOpen = state.storyPopover && state.storyPopover.token === key && state.storyPopover.occurrence === counts[key];
      return `<span class="sw${isTarget ? ' target' : ''}${isOpen ? ' tapped' : ''}" data-w="${esc(key)}" data-n="${counts[key]}">${esc(tok)}</span>`;
    }).join('');
  }

  function renderStoryRead() {
    const app = document.getElementById('app');

    if (state.storyLoading || (!state.activeStory && !state.storyError)) {
      app.innerHTML = `
        <div class="screen bg-story">
          <div class="wrap">
            <div class="screen-header"><button id="back-btn" class="back-btn">←</button></div>
            <div class="status-line" style="justify-content:center;"><div class="spinner"></div> Loading…</div>
          </div>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', leaveStoryRead);
      return;
    }

    if (state.storyError || !state.activeStory) {
      app.innerHTML = `
        <div class="screen bg-story">
          <div class="wrap">
            <div class="screen-header"><button id="back-btn" class="back-btn">←</button></div>
            <div class="msg-error">${esc(state.storyError || 'That story could not be opened.')}</div>
          </div>
        </div>
      `;
      document.getElementById('back-btn').addEventListener('click', leaveStoryRead);
      return;
    }

    const story = state.activeStory;
    const targetSet = new Set((story.targetWords || []).map(w => w.toLowerCase()));
    const counts = {};
    const levelClass = story.level === 'hard' ? 'hard' : story.level === 'medium' ? 'med' : 'easy';
    const levelLabel = STORY_LEVEL_LABELS[story.level] || 'Easy';

    const parasHtml = (story.paragraphs || []).map((p, i) => {
      const open = state.storyAllRevealed || !!state.storyOpenParas[i];
      return `
        <div class="story-para${p.dialogue ? ' dlg' : ''}${open ? ' open' : ''}">
          <button class="story-tr" data-para="${i}" type="button" aria-label="Show this paragraph in English">ES</button>
          <p>${storyParagraphHtml(p.es, counts, targetSet)}</p>
          <div class="story-en">${esc(p.en)}</div>
        </div>
      `;
    }).join('');

    // The gloss popover. Positioned in JS after layout (see below) rather
    // than in the markup, since it has to be measured against the tapped
    // word's real position.
    let popHtml = '';
    if (state.storyPopover) {
      const g = storyGlossFor(state.storyPopover.token, state.storyPopover.occurrence);
      if (g) {
        popHtml = `
          <div class="story-pop" id="story-pop">
            <i class="story-pop-arrow"></i>
            <div class="story-pop-es">${esc(state.storyPopover.token)}</div>
            <div class="story-pop-en">${esc(g.en)}</div>
            ${g.base ? `<div class="story-pop-base">${esc(g.base)}</div>` : ''}
          </div>
        `;
      }
    }

    app.innerHTML = `
      <div class="screen bg-story">
        <div class="wrap">
          <div class="screen-header">
            <button id="back-btn" class="back-btn">←</button>
            <div class="story-head-title">${esc(story.title.es)}</div>
          </div>
          <div class="story-body" id="story-body">
            <h1 class="story-title">${esc(story.title.es)}</h1>
            <div class="story-sub">
              <span class="story-pill ${levelClass}">${esc(levelLabel)}</span>
              <span>${story.wordCount} palabras · ${story.minutes} min</span>
            </div>
            ${parasHtml}
            ${popHtml}
            <button id="story-finish-btn" class="btn-primary" style="margin-top:18px;">Finish story</button>
          </div>
          <div class="story-tools">
            <button id="story-reveal-btn" class="story-tool" type="button" aria-pressed="${state.storyAllRevealed}">
              ${state.storyAllRevealed ? 'Hide English' : 'Show all English'}
            </button>
            <span class="story-tapcount">${Object.keys(state.storyTapped).length} ${Object.keys(state.storyTapped).length === 1 ? 'word' : 'words'} tapped</span>
          </div>
        </div>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', leaveStoryRead);
    document.getElementById('story-finish-btn').addEventListener('click', finishStoryRead);
    document.getElementById('story-reveal-btn').addEventListener('click', toggleStoryRevealAll);

    document.querySelectorAll('.story-tr').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStoryParagraph(parseInt(btn.dataset.para, 10));
      });
    });

    // Word taps. Paragraph reveal lives on the ES marker in the margin
    // precisely so these two gestures never overlap — if tapping the prose
    // meant both, every word tap would also toggle its paragraph.
    document.querySelectorAll('.sw').forEach(span => {
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStoryWord(span.dataset.w, parseInt(span.dataset.n, 10), span.getBoundingClientRect());
      });
    });

    // Tapping anywhere else closes the popover. Bound to the story body
    // rather than document so it dies with this render.
    const body = document.getElementById('story-body');
    if (body) body.addEventListener('click', closeStoryPopover);

    positionStoryPopover();
  }

  // Places the popover above the tapped word, flipping below when there
  // isn't room, and clamping horizontally so it never hangs off the screen.
  // The arrow tracks the word independently of the clamped body.
  function positionStoryPopover() {
    const pop = document.getElementById('story-pop');
    const body = document.getElementById('story-body');
    if (!pop || !body || !state.storyPopover || !state.storyPopover.rect) return;

    const bodyRect = body.getBoundingClientRect();
    const r = state.storyPopover.rect;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;

    let left = (r.left - bodyRect.left) + r.width / 2 - pw / 2;
    left = Math.max(6, Math.min(left, bodyRect.width - pw - 6));

    let top = (r.top - bodyRect.top) - ph - 8;
    if ((r.top - bodyRect.top) < ph + 14) {
      top = (r.bottom - bodyRect.top) + 8;
      pop.classList.add('below');
    }

    pop.style.left = left + 'px';
    pop.style.top = top + 'px';

    const arrow = pop.querySelector('.story-pop-arrow');
    if (arrow) {
      const arrowX = (r.left - bodyRect.left) + r.width / 2 - left - 5;
      arrow.style.left = Math.max(8, Math.min(arrowX, pw - 18)) + 'px';
    }
  }

  // ---- End-of-story quiz -----------------------------------------------

  function renderStoryQuiz() {
    const app = document.getElementById('app');
    const current = state.storyQuestions[state.storyQIndex];
    if (!current) return;

    const total = state.storyQuestions.length;
    const dotsHtml = state.storyQuestions.map((_, i) => {
      let cls = 'story-dot';
      if (i < state.storyResults.length) cls += state.storyResults[i].correct ? ' done' : ' missed';
      else if (i === state.storyQIndex) cls += ' now';
      return `<div class="${cls}"></div>`;
    }).join('');

    const acceptable = splitAnswers(current.en).map(normalize);
    const optionsHtml = current.options.map(opt => {
      let cls = 'option-btn';
      if (state.storyChecked) {
        if (acceptable.includes(normalize(opt))) cls += ' correct-choice pop-anim';
        else if (opt === state.storySelectedOption) cls += ' wrong-choice shake-anim';
      }
      return `<button class="${cls}" ${state.storyChecked ? 'disabled' : ''}>${esc(opt)}</button>`;
    }).join('');

    let feedbackHtml = '';
    if (state.storyChecked) {
      feedbackHtml = state.storyWasCorrect
        ? `<div class="feedback correct"><div class="title">✅ Correct</div></div>`
        : `
          <div class="feedback wrong">
            <div class="title">❌ Not quite</div>
            <div class="answer">Correct answer: <strong>${esc(primaryText(current.en))}</strong></div>
          </div>
          <button id="story-next-btn" class="btn-primary">Next word</button>
        `;
    }

    app.innerHTML = `
      <div class="screen bg-story">
        <div class="wrap">
          <div class="screen-header">
            <button id="back-btn" class="back-btn">←</button>
            <div class="story-head-title">Words from the story</div>
          </div>
          <div class="story-quiz-head">
            <span>Question ${state.storyQIndex + 1} of ${total}</span>
            <span>+${XP_PER_STORY_CORRECT} XP each</span>
          </div>
          <div class="story-dots">${dotsHtml}</div>
          <div class="story-qword">${esc(primaryText(current.es))}</div>
          ${current.note ? `<div class="story-qnote">${esc(current.note)}</div>` : ''}
          <div class="option-list" id="story-options">${optionsHtml}</div>
          ${feedbackHtml}
        </div>
      </div>
    `;

    document.getElementById('back-btn').addEventListener('click', leaveStoryQuiz);
    if (!state.storyChecked) {
      document.querySelectorAll('#story-options .option-btn').forEach((btn, i) => {
        btn.addEventListener('click', () => selectStoryOption(current.options[i]));
      });
    }
    const nextBtn = document.getElementById('story-next-btn');
    if (nextBtn) nextBtn.addEventListener('click', nextStoryQuestion);
  }

  // ---- Results ---------------------------------------------------------

  function renderStoryResult() {
    const app = document.getElementById('app');
    const story = state.activeStory;
    const score = state.storyResults.filter(r => r.correct).length;
    const total = state.storyResults.length;
    const counted = state.storyReadMs >= MIN_STORY_READ_MS;
    const answerXP = score * XP_PER_STORY_CORRECT;
    const completionXP = counted ? XP_STORY_COMPLETED : 0;

    const tapped = Object.keys(state.storyTapped);
    let tappedHtml = '';
    if (story && tapped.length > 0) {
      const chips = tapped.map(t => {
        const g = (story.gloss || {})[t];
        return `<span class="story-chip"><b>${esc(t)}</b> ${esc(g ? g.en : '')}</span>`;
      }).join('');
      tappedHtml = `
        <div class="story-tapped">
          <div class="story-tapped-label">Words you tapped</div>
          <div class="story-chips">${chips}</div>
        </div>
      `;
    }

    let missedHtml = '';
    const missed = state.storyResults.filter(r => !r.correct);
    if (missed.length > 0) {
      missedHtml = `
        <div class="card" style="margin-bottom:20px;">
          <div class="review-title">Words to review</div>
          ${missed.map(r => `
            <div class="review-item">
              <span class="from">${esc(r.prompt)}</span> → <span class="to">${esc(r.correctAnswer)}</span>
              ${r.userAnswer ? `<div class="yours">You chose: ${esc(r.userAnswer)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }

    app.innerHTML = `
      <div class="screen bg-story">
        <div class="wrap wrap-centered">
          <div class="screen-header">
            <button id="back-btn" class="back-btn">←</button>
          </div>
          <div class="screen-body">
            <div class="eyebrow" style="margin-bottom:4px;">Historia</div>
            <div class="story-res-xp">+${answerXP + completionXP}<small> XP</small></div>
            <div class="story-res-title">${esc(story ? story.title.es : 'Story')}</div>
            <div class="story-res-sub">
              ${story ? `You read ${story.wordCount} words in Spanish` : ''}${tapped.length ? ` and tapped ${tapped.length} of them.` : '.'}
            </div>

            <div class="story-breakdown">
              <div class="story-brow"><span>Words correct · ${score} of ${total}</span><b>+${answerXP}</b></div>
              <div class="story-brow"><span>${counted ? 'Story finished' : 'Story finished (too quick to count)'}</span><b>+${completionXP}</b></div>
              <div class="story-brow total"><span>Total</span><b>+${answerXP + completionXP} XP</b></div>
            </div>

            <div class="story-srs-note">
              Story Mode never changes your review schedule. Your boxes are exactly where you left them.
            </div>

            ${missedHtml}
            ${tappedHtml}

            <button id="story-again-btn" class="btn-primary" style="width:100%; margin-bottom:10px; margin-top:18px;">Read it again</button>
            <button id="story-library-btn" class="btn-secondary" style="width:100%;">Back to stories</button>
          </div>
        </div>
      </div>
    `;

    // Every exit routes through leaveResults(). That is what defers the Level
    // Up screen when a round crosses a threshold — a story is worth up to 16
    // XP and can absolutely trigger one, and calling the destination directly
    // would swallow the celebration silently.
    document.getElementById('back-btn').addEventListener('click', () => leaveResults(goToStoryLibraryFromResult));
    document.getElementById('story-again-btn').addEventListener('click', () => leaveResults(rereadCurrentStory));
    document.getElementById('story-library-btn').addEventListener('click', () => leaveResults(goToStoryLibraryFromResult));
  }
