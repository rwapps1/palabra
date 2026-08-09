# Palabra — Spanish Vocab Learning App

A single-page Spanish–English vocabulary trainer that runs entirely from GitHub Pages — no backend server, no build step. Your word lists live in the repo as Excel files; the app fetches them, quizzes you across several different game modes, and tracks your progress. Play as a guest with progress kept on-device, or sign in to sync progress across devices.

## What's here

**Games**, all reachable from a home-screen hub:

- **Quiz** — classic recall. Choose direction (Mixed / ES→EN / EN→ES), round length (10 / 20 / 50 / All), and answer style (type it, or multiple choice).
- **Time Attack** — 60 seconds, answer as many as you can. Tracks your best score.
- **Memory Match** — a face-down grid of Spanish/English tiles; find the pairs. 6, 8, or 12 pairs, tracked by fewest moves.
- **Categories** — 15 themed word lists (see below) played through the same settings as Quiz, minus the 50-word option.
- **Conjugate** — present-tense verb practice. Shown an infinitive, its English meaning, and a required pronoun (yo/tú/él/nosotros/vosotros/ellos); type or choose the correctly conjugated form. Handles regular verbs, the main stem-change patterns (e→ie, o→ue, e→i, u→ue), reflexive verbs (answers like "me siento"), and a hand-checked table of fully irregular verbs (ser, estar, ir, oír, etc.).
- **Achievements** — 24 badges across all five games, grouped by which game they belong to. Reached via the banner below the game grid on the hub.

**Under the hood:**

- **Real spaced repetition** — every word (and, for Conjugate, every verb+pronoun combination) sits in one of six "boxes." Get it right and it won't come up again for a while (1 → 3 → 7 → 16 → 35 days); get it wrong and it's due again immediately. Selection is weighted toward whatever's actually due.
- **Typo tolerance** — typed answers allow for small mistakes (a dropped letter, a missing accent) using edit-distance matching, so close-but-not-exact answers still count.
- **Multiple accepted answers** — a word list cell can contain more than one valid translation, separated by `/` or `,`.
- **Shared vs. separate progress** — Quiz, Time Attack, and Categories all read from and write to the same word history and streak. Memory Match and Conjugate each keep their own separate streak/best-score, while Memory Match's matches and Conjugate's answers still feed their words through the same spaced-repetition scheduling as everything else.

## Accounts & progress sync

Progress is kept in the browser's `localStorage` either way — that's the fast, always-available copy, and the only copy for a guest.

Signing in (email/password or Google) adds a second copy in Firestore, keyed to that account, so progress follows you across devices:

- **Guest by default** — the login screen has a "Continue without an account" option; nothing about playing requires signing up.
- **Signing up preserves guest progress** — whatever's built up locally becomes the starting point for the new account, rather than starting at zero.
- **Sync is two-way and debounced** — local changes push to the cloud a couple of seconds after you stop playing (not on every single answer). Returning to the hub after using the app elsewhere (another tab, another device) pulls anything newer.
- **Timestamp-guarded** — every push is stamped with when it happened, and a pull is rejected if it isn't actually newer than what the device already has. A device only pushes-before-pulling when it has a genuine unsynced local change of its own — otherwise it just pulls, so a stale device can't accidentally overwrite newer progress from elsewhere just by reconnecting.
- **Username** — optional, set from the "⋯" menu once signed in (works for Google sign-ins too, who don't go through a sign-up form). Not yet used for anything in-app; it's there ahead of a possible future friends feature. **Not currently unique** — nothing stops two accounts picking the same one.
- **Firebase project**: `palabra-f8778`. Auth (email/password + Google) and Firestore are both enabled on it; the client config sits in plain sight near the top of `index.html` (this is normal — Firebase web config isn't a secret, actual access control is enforced by Firestore's security rules, not by hiding this).

**Download progress** / **Upload progress** (in the "⋯" menu) still work independently of all this — they export/import progress as a JSON file, useful as a manual backup or for a one-off transfer.

## File layout

```
your-repo/
├── index.html                ← the app itself, including the login screen and Firebase wiring
├── words.xlsx                 ← main word list
├── verbs.xlsx                 ← verb list for Conjugate
├── categories-animals.xlsx
├── categories-bodyparts.xlsx
├── categories-clothing.xlsx
├── categories-colours.xlsx
├── categories-dailyverbs.xlsx
├── categories-daysandmonths.xlsx
├── categories-emotions.xlsx
├── categories-family.xlsx
├── categories-foodanddrink.xlsx
├── categories-greetings.xlsx
├── categories-house.xlsx
├── categories-numbers.xlsx
├── categories-questionwords.xlsx
├── categories-transport.xlsx
├── categories-weather.xlsx
├── manifest.json              ← for installing as an app
├── service-worker.js          ← for offline support
├── icon-192.png
├── icon-512.png
└── icon-512-maskable.png
```

Everything needs to be **served** (GitHub Pages, or any local server) rather than opened directly as a file — the app fetches these files over HTTP, which browsers block for local files, and Firebase Authentication requires a real origin (or `localhost`) to work at all. If `words.xlsx` fails to load, the app falls back to a manual upload button; `verbs.xlsx` and category files show an inline error on their own screen instead.

## Word list format

| Column A (Spanish) | Column B (English) |
|---|---|
| perro | dog |
| grande | big / large |

- Spanish in column A, English in column B, on the first sheet.
- A header row is optional — there's a toggle in the "⋯" menu to skip it (applies to `words.xlsx`, category files, and `verbs.xlsx` alike).
- Multiple valid translations go in one cell, separated by `/`, `,`, or `;`.
- Category files follow the exact same two-column format, one file per topic.
- `verbs.xlsx` also follows this shape — column A is the **infinitive** (e.g. `hablar`, `sentarse`), column B its English meaning. No conjugated forms go in the sheet; those are generated by rules built into the app itself.

**Renaming files:** if you rename `words.xlsx` or `verbs.xlsx`, update the matching constant (`WORDS_FILE` / `VERBS_FILE`) near the top of the `<script>` block in the HTML (and `WORDS_FILE`'s counterpart in `service-worker.js`). Category files must be named `categories-{id}.xlsx` where `{id}` is the lowercase, no-spaces version of the name shown on its tile. Adding a 16th category means adding both the spreadsheet and an entry in the `CATEGORIES` list in the script.

**Adding a verb the conjugation engine doesn't already know:** most regular verbs need nothing extra — they're conjugated by rule. Known gap: consonant spelling-change verbs (e.g. `vencer`) aren't yet handled by the rule engine — worth a quick check against a real conjugation table when adding verbs like this.

## Installing as an app

The manifest, service worker, and icons let you install the page to a phone's home screen for a full-screen, app-like experience that still works offline once loaded.

There's also a native `.apk` already built, as a Trusted Web Activity (package `io.github.rwapps1.twa`) — it just loads this same live site full-screen, verified against it via a `.well-known/assetlinks.json` file hosted in the separate `rwapps1.github.io` repo (not this one — that file lives at the domain root, not inside a project repo). Rebuilding the APK after any change here needs to use the **same signing keystore** as the original build, or its certificate fingerprint won't match what `assetlinks.json` expects, and it'll fall back to showing a browser address bar instead of running full-screen.

## Caching & deployments

`service-worker.js` fetches **network-first**: it always tries the real server before falling back to its cache, so a deploy takes effect on the very next load rather than the one after it — the earlier cache-first version of this file kept everyone one deploy behind. The cache still exists purely as an offline fallback.

Practical notes:
- Routine edits to `index.html` or the `.xlsx` files need no changes to `service-worker.js` — the network-first strategy picks them up automatically on next load.
- A browser tab left open (not reloaded) won't pick up a new deploy just by sitting there — only an actual reload triggers the fresh network check.
- `service-worker.js` itself only needs redeploying if the caching *strategy* changes, not for routine content updates.

## Design

Visual identity is "Vidrio" — glass panels over an ambient gradient glow, with the glow's color shifting by mode (coral for Quiz, teal for Time Attack, magenta for Memory Match, green for Conjugate, gold for Achievements) so the color itself signals where you are in the app. One deliberate nod to Spain: a small medallion badge on the home screen (and on the login screen), banded red–gold–red. The login screen reuses the same glass-card, badge, and type styling as the rest of the app rather than introducing a separate look.

## Known gaps

- Username isn't unique — nothing stops two accounts picking the same one. Fine for now; would need addressing before a friends/social feature (add-by-username) could work.
- Friends/social feature — discussed as a future direction, not built.
- Conjugation engine doesn't yet handle consonant spelling-change verbs (e.g. `vencer`).
