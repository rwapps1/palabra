# Palabra

A Spanish vocabulary learning Progressive Web App, built as a single-file, no-build-step web app and installable on both desktop and mobile.

**Live app:** [rwapps1.github.io/Palabra](https://rwapps1.github.io/Palabra) · [palabraword.uk](https://palabraword.uk)

---

## About

Palabra helps you learn and retain Spanish vocabulary through a spaced-repetition ("box") system, wrapped in a handful of different game modes so practice doesn't get stale. Progress is tied to your account and synced across devices.

## Features

### Games

- **Stream** — the default way to practice: a continuous, mixed-format session that cycles between multiple choice, listening, and typed answers, pulling from whichever words you most need to review. No fixed length — soft checkpoints every 20 questions let you keep going or stop, rather than a hard round that ends and dumps you back to a menu.
- **Quiz** — configurable rounds (direction, length, multiple choice or typed answers)
- **Time Attack** — a 60-second timed sprint
- **Memory Match** — tile-matching, with 6/8/12-pair grid sizes
- **Conjugate** — present-tense verb conjugation practice
- **Categories** — 15 themed word lists (animals, food, family, numbers, and more)

### Progress & learning

- **Spaced repetition** — a 6-box Leitner-style system quietly tracks how well you know each word and resurfaces it at the right interval, regardless of which game mode you're playing
- **Streaks, XP, and Levels** — progress that only ever goes up, a record of how much you've played rather than a score that can drop
- **Achievements** — dozens of unlockable badges across every mode, including dedicated tiers for Stream and for long-term vocabulary mastery
- **Daily Double** — an optional daily prompt to revisit your least-memorized words for bonus XP

### Everywhere you go

- **Installable PWA** — add it to your home screen on any platform, works offline once loaded
- **Android app** — also available as a proper installed app via a Trusted Web Activity (TWA)
- **Cross-device sync** — sign in and your progress follows you, backed by Firebase

## Tech stack

- Vanilla HTML, CSS, and JavaScript — no framework, no build step
- [Firebase](https://firebase.google.com/) (Authentication + Firestore) for accounts and progress sync
- [SheetJS](https://sheetjs.com/) for parsing the `.xlsx` word lists client-side
- Web Speech API for spoken pronunciation
- A service worker for offline support and installability
- Hosted on GitHub Pages, fronted by Cloudflare on a custom domain

## Project structure

```
index.html                  → the entire app (markup, styles, and logic)
service-worker.js           → offline caching (network-first strategy)
manifest.json                → PWA manifest
words.xlsx                    → main word list (Spanish / English)
verbs.xlsx                     → verb list for Conjugate
categories-*.xlsx                → 15 themed word lists for Categories
admin.html                        → private analytics dashboard (auth-gated)
icon-*.png                          → app icons
```

Everything is hand-written and hand-edited directly — there's no build pipeline, no bundler, and no dependencies to install. Editing `index.html` and committing is the entire deployment process.

## Status

Actively developed and in daily personal use. Built and maintained iteratively, one feature and one bug fix at a time.
