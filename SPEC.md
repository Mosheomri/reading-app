# Reading App – Specification (v1)

A free web app for adapted reading instruction in Hebrew.
A teacher builds a lesson using **her own** AI chat (ChatGPT / Gemini / any) via copy-paste,
then sends the child a link. The child plays, reads and answers – **no AI, no login, no server**.

---

## 1. Architecture

- **Static site only**: plain HTML + CSS + vanilla JavaScript. No build step, no framework, no backend.
- Hosted on **GitHub Pages**.
- Two pages:
  - `index.html` – Teacher: lesson builder.
  - `play.html` – Child: lesson player.
- **The lesson lives inside the link**: lesson JSON → compressed with LZ-String
  (`compressToEncodedURIComponent`) → placed in the URL **hash**: `play.html#<data>`.
  The hash is never sent to any server, so no data about the child or lesson is stored anywhere.
- Vendor LZ-String locally (`js/lz-string.min.js`), do not rely on a CDN.
- No analytics, no cookies, no tracking. `localStorage` only for conveniences: the teacher's last form values
  and draft, and the child's last reading pace.
- Local scripts and CSS are linked with a version query (`js/builder.js?v=2`). Bump the number in `index.html`
  and `play.html` on every release, so browsers do not run an old cached copy.
- Automated tests: Playwright (Python) suites in `tests/`, run with `python tests/run_all.py`.

Suggested structure:
```
/index.html
/play.html
/css/style.css
/js/builder.js      teacher flow
/js/player.js       child flow
/js/games/*.js      one file per game
/js/exercises.js
/js/reading.js      paced reading modes on the child's reading screen
/js/levels.js       reading levels (prompt guidelines, words per sentence)
/js/print.js        printable worksheet and answer page
/js/hebrew.js       nikud helpers (strip, normalize, word matching)
/js/lesson.js       schema validation, encode/decode link
/js/dicta.js        automatic nikud: opens Dicta and talks with the userscript
/js/gemini.js       Gemini API: model constant, key, structured output, errors and retry
/gemini-setup.html  how to get a Gemini API key (teacher)
/js/lz-string.min.js
/dicta-setup.html   setup instructions for the Dicta bridge (teacher)
/userscripts/dicta-bridge.user.js   Tampermonkey script that runs on Dicta's site
```
- The Dicta bridge (section 3, step 5) is optional: without the userscript everything works by copy-paste.
- The Gemini mode (section 3.0) is optional too: the teacher's own key, requests go straight from the browser
  to Google. Copy-paste with any chat stays available at all times.

---

## 2. General UI requirements

- Hebrew, `dir="rtl"`, `lang="he"` everywhere.
- Font with good nikud rendering (e.g. Noto Sans Hebrew via Google Fonts, with system fallback).
- Child page: large text (story ≥ 28px, adjustable), big touch targets (≥ 48px), minimal text on buttons, calm colors, no time pressure.
- Mobile-first: must work on phone, tablet and desktop.
- Positive feedback only (no "wrong!" sounds). On mistake: gentle hint, allow retry.

---

## 3. Teacher page – `index.html`

### Step 1: Settings form
| Field | Type | Notes |
|---|---|---|
| Topic (נושא) | free text | required |
| Reading level (רמת קריאה) | גן–תחילת א׳ / סוף א׳–ב׳ / ג׳–ד׳ / ה׳–ו׳ | default סוף א׳–ב׳; see below |
| Story length (אורך) | number of words | e.g. 100; range 20–400 |
| Target words (מילות יעד) | either a number (AI chooses) or a list typed by teacher | 2–10 words |
| Nikud (ניקוד) | full / partial / none | partial = only target words vocalized |

#### Reading levels – `js/levels.js`
All level settings live in one file, so they are easy to tune. Each level has an id (stored in the lesson
as `level`), a label, an average number of words per sentence (turns the requested length into paragraphs and
sentences, section 6), prompt lines about sentence length, vocabulary and syntax, and a line about the kind of
comprehension questions:

| Level | id | Words / sentence | Language | Questions |
|---|---|---|---|---|
| גן–תחילת א׳ | `k-1` | 4 (3–5) | everyday words, simple sentences, mostly present tense | only direct: the answer is written in the story |
| סוף א׳–ב׳ | `1-2` | 5.5 (4–7) | joining with ו / כי, few descriptions | direct, plus one simple comprehension question |
| ג׳–ד׳ | `3-4` | 8 (6–10) | simple complex sentences (ש, כאשר), wider vocabulary | one inference question |
| ה׳–ו׳ | `5-6` | 11 (8–14) | longer sentences, connectives (אבל, לכן, למרות ש…), expressions | two inference questions |

The settings form and the editor list the levels from this file. The chosen level is saved with the teacher's
settings and in the lesson (`level`); the editor can change it. The review prompt (step 5) asks the second AI to
check that the text fits the lesson's level, and to report mismatches as `style` suggestions with the reason
"לא מתאים לרמה". Lessons made before levels have `level: ""`, and their review prompt has no level check.

### 3.0 Automatic mode with Gemini (optional)
- **Key** (step 1, a collapsible box "✨ יצירה אוטומטית עם Gemini"): a password field to paste a Google AI Studio
  key, "בדוק מפתח" and "מחק מפתח", and a note not to keep a key on a shared computer. "בדוק מפתח" reads the
  model's details (`GET v1beta/models/{MODEL}`, no tokens); only a valid key is saved, in `localStorage`
  (`readingApp.geminiKey`) only. Instructions page: `gemini-setup.html` (create a key in AI Studio step by step;
  optional: restrict it to the website `mosheomri.github.io/*` and to the Gemini API; privacy note: on the free
  tier Google may use the content, so no identifying details about a child).
- **API**: `POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:streamGenerateContent?alt=sse`
  from the browser (streamed, server-sent events), key in the `x-goog-api-key` header (never in the URL).
  The text of every chunk is joined (parts marked `thought` are left out); an `error` event inside the stream
  counts like an HTTP error. While it streams, the stage shows "כותב סיפור… (נכתבו כבר X תווים)".
- **Thinking**: `generationConfig.thinkingConfig.thinkingLevel = 'low'`, the lowest level of
  `gemini-3.8-flash` (it has low / medium / high, default medium; ai.google.dev/gemini-api/docs/thinking),
  for shorter answers. A constant (`THINKING_LEVEL`) next to `MODEL`. If the API rejects the setting (400
  mentioning thinking), the request is sent once more without it.
- **Timeouts**: a streamed answer times out only after **45 s with no data at all** (`config.idleTimeout`; the
  timer starts again on every chunk, so a long answer that keeps coming is never cut). Plain requests
  (checking the key): 120 s (`config.timeout`).
- **Console**: one line per request, `[Gemini] <call> (<model>): HTTP <status>, <seconds> s, <chars> chars,
  finish <reason>[, retry][ – <error and Google's message>]` (`console.info`, `console.warn` on errors).
  Calls: `check-key`, `write-lesson`, `review-text`. The key is never logged.
- **Model and output**: `MODEL` is one constant at the top of `js/gemini.js`: `gemini-3.8-flash` (stable, has a free tier; checked in the official pricing and models pages,
  October 2026). Structured output: `generationConfig.responseMimeType = 'application/json'` and a
  `responseSchema` (OpenAPI subset): the lesson schema mirrors the prompt's example (section 5), with `answer` as
  a string for all exercise types ("0", "true"), which `Lesson.coerce` already accepts; the review schema is the
  list the review prompt asks for.
- **Flow** after "✨ צור שיעור" (shown next to "יצירת פרומפט" once a key is saved), with a stage list on top of
  the page (⏳ active, ✓ done, ✕ failed, 👆 the teacher's turn, – skipped):
  1. **כותב סיפור…**: the same prompt as copy-paste (`buildPrompt`). The JSON goes into the step 3 box.
  2. **בודק את השיעור…**: the same checks as a paste (`analyzeResponse`: extract, coerce, sort order exercises,
     `Lesson.check`). Errors stop the flow; warnings only go on (they show in the preview).
  3. **בודק טקסט…**: a separate call with the existing review prompt (`Review.buildReviewPrompt`). The check
     step opens and the suggestions are shown for approval exactly as after a paste.
  4. **מחכה לאישור ההצעות**: when the last suggestion is approved or rejected, the flow goes on. That last
     decision is a click, so Dicta may open in a new window then (popups need a user gesture).
  5. **מנקד בדיקטה…**: if the Dicta bridge answered before in this browser (`readingApp.dictaBridge`, set on its
     "ready", cleared when it does not answer), automatic nikud starts. Otherwise (or with no suggestions, when
     there is no click to open a window from) it is the teacher's turn: the auto-nikud button is highlighted and
     the manual steps are there. No nikud mode: skipped.
  6. "השיעור מוכן ✓" with a button to the link.
- **Errors** (clear Hebrew message, the copy-paste flow with the prompt ready in step 2, and "↻ לנסות שוב"):
  invalid key (400 `API_KEY_INVALID`, 401, 403), quota (429), no network, no data for 45 s, blocked
  (`promptFeedback.blockReason`, safety finish), cut (`MAX_TOKENS`), empty answer, a lesson that fails the checks
  (its problems listed, and "לראות את התשובה ולתקן" opens it in step 3 with the usual fix message).
  **One automatic retry** (after 4 s) for temporary errors only: network, timeout, 5xx. Not for 429 or a bad key.
  A review error does not stop the flow: message, manual review offered, then nikud.
- Leaving the flow (new lesson, loading a file, pasting a response, "יצירת פרומפט") cancels it; late answers
  from a cancelled run are ignored.
- **Tests**: `tests/gemini.py`, against a mock API (Playwright routing).

### Step 2: Prompt
- Generate the prompt (section 6) from the form values.
- Big "העתק" button. Short instruction: "הדביקו בצ׳אט של הבינה שלכם ושלחו".

### Step 3: Paste response
- Textarea for the AI's answer.
- Parse robustly: strip ```json fences and any text before the first `{` / after the last `}`.
- Validate (section 5). Show clear Hebrew errors; when possible, offer a short "fix" message the teacher can send back to her AI.

### Step 4: Preview & edit
- Show the full lesson exactly as the child will see it.
- Everything editable: story text (including nikud), target words, emojis, questions, options, answers.
- Highlight target words in the story.
- The lesson usually has no nikud yet at this point (section 7). The preview says so as an info message
  (not a warning) when the nikud mode is full or partial. Words without nikud are marked in red only once
  the lesson has some nikud (e.g. a word added after Dicta).
- Non-blocking warning "ייתכן כתיב חסר": words with holam or qubuts on a letter other than ו, with no ו or א
  after it (exceptions: פה, כה, איפה, משה, also with prefixes). Works once the text has nikud.

### Step 5: Check and nikud
1. **Text review (optional)**: a prompt for a second AI with all lesson texts **without nikud**, so ktiv haser
   stands out. The AI returns JSON suggestions `{field, type: error|style, original, fix, reason}` (fix without
   nikud); the teacher approves or rejects each one. `original` is matched as whole words, ignoring nikud.
2. **Nikud with Dicta**: **required** before a link when the nikud mode is full or partial; hidden (and skipped)
   when it is none.
   - Copy all lesson text without nikud (title, target words, story, exercises; one field per line),
     vocalize it in Dicta Nakdan (modern style, ktiv male), paste the result back. Dicta vocalizes as you type
     (there is no "נקד" button).
   - Or automatically, with the button "✨ נקד אוטומטית בדיקטה" (section 3.1). The result goes into the paste
     box and runs the same comparison, so everything below applies to both ways.
   - The pasted text must have the same number of words. Words that have no nikud in the lesson take Dicta's
     word as is, after checking the letters are identical. A lesson without nikud is therefore vocalized with
     no comparison at all.
   - Words that already have nikud (e.g. a lesson file made before, or a teacher's own vocalization) are
     compared: only differing words are listed, and the teacher picks the lesson's version or Dicta's
     (ו/י-only spelling differences are allowed for these words and tagged "כתיב שונה").
   - The nikud step is tied to the text it was applied to. Any text change afterwards requires Dicta again
     before a link (the progress bar cannot skip it either). The state is kept in the saved draft; a loaded
     lesson file in which every word has nikud counts as vocalized.

#### 3.1 Automatic nikud: the Dicta bridge
A Tampermonkey userscript, `userscripts/dicta-bridge.user.js`, runs on `https://nakdan.dicta.org.il/*` and
talks with the teacher page (`js/dicta.js`) through `window.postMessage`.
- **Script header**: `@match https://nakdan.dicta.org.il/*`, `@updateURL` and `@downloadURL` =
  `https://mosheomri.github.io/reading-app/userscripts/dicta-bridge.user.js`, so Tampermonkey updates it
  (bump `@version` on every change). `@grant none`.
- **Dicta's page** (checked against the live site, October 2026): a Vue app. The text box is
  `#input-textarea` (maxlength 5000); the vocalized text is shown in `#nikud-text`. Settings are in a menu
  behind the gear button; its radios (`value="modern"` / `"rabbinic"`, `value="haser"` / `"maleh"`) exist in
  the DOM only while the menu is open, and the choice is not remembered between visits. All selectors are in
  the `SEL` block at the top of the script.
- **Flow**:
  1. The button opens Dicta with `window.open` (window name `dicta-bridge`, so a second click reuses it).
  2. The script runs only when the page has a `window.opener`. Once the text box exists it sends
     `{type: 'ready', version}` every second until a request comes.
  3. The page sends `{type: 'nikud', id, text}`: the same text as "העתק טקסט בלי ניקוד".
  4. The script opens the settings menu, picks **מודרני** and **ניקוד בכתיב מלא** (and checks they are
     selected), closes the menu, sets the text with the native value setter plus `input`/`change` events, and
     clicks `SEL.nikudButton` if one is set (none today: Dicta vocalizes on input).
  5. It waits for the result with a `MutationObserver` (plus a 250 ms poll as a backup). The result is
     accepted when its letters match the text sent (ignoring nikud and ו/י), at least 90% of the Hebrew words
     have nikud (an update on the way is not taken), and it has not changed for 800 ms. 30 s per part at most.
  6. Text longer than 5000 characters is split into parts at line ends (a longer line at a space), vocalized
     one part at a time (`{type: 'progress', part, parts}`), and joined back the same way.
  7. `{type: 'result', id, text}`, then the script closes the window. The page puts the text into the paste
     box and runs the manual comparison.
- **Security**: the page accepts messages only with `origin === 'https://nakdan.dicta.org.il'` and
  `source ===` the window it opened, and sends only to that origin. The script accepts messages only from its
  opener and from `https://mosheomri.github.io` or `http://localhost:8000`; it sends `ready` only to those
  two origins and the rest only to the origin of the request.
- **Fallback** (the manual steps stay below the button in every case):
  - no `ready` within 10 s: "the add-on is not installed or not enabled" with a link to `dicta-setup.html`;
    the Dicta window stays open for manual use;
  - popup blocked; Dicta window closed before the result; no result in time (30 s + 30 s per 5000
    characters); an error from the script (element not found, settings not applied, no nikud in time): a
    clear message and "אפשר לנקד ידנית". On a script error the Dicta window stays open.
  - If the lesson text changed while Dicta was working, the result is not applied.
- **Setup page** `dicta-setup.html` (linked "איך מתקינים?" next to the button), in Hebrew, in steps:
  install Tampermonkey (Chrome Web Store / Edge Add-ons); turn on **Allow User Scripts** in the extension's
  details (`chrome://extensions` / `edge://extensions`, or developer mode in older versions); click the
  install link and confirm; try the button. Plus troubleshooting and privacy notes.
- **Tests**: `tests/dicta_bridge.py` runs the script against `tests/fixtures/dicta-mock.html` served at
  Dicta's address (Playwright routing, nothing goes to the network). `--live` runs one short check against
  the real site.

### Step 6: Link
- Build the link, show it, "העתק קישור" button and "שלח בוואטסאפ" button (`https://wa.me/?text=...`).
- "פתח לבדיקה" button that opens `play.html` with the lesson.
- Button to download the lesson JSON (backup) and to load a JSON file back for editing.
- **"🖨️ הדפסה"** button and a checkbox **"לכלול דף תשובות"**. The button builds a worksheet (`js/print.js`)
  into a hidden `#printArea` on the teacher page and calls `window.print()`. A print stylesheet shows only that
  area: A4 (`@page`), large font (text 16pt, story 18pt, line height 2 for nikud), black borders instead of
  backgrounds (browsers skip backgrounds when printing).
  - Content: a "שם: ___ תאריך: ___" line, the title, the target words with their emoji, the story (target words
    bold and underlined), then the exercises, numbered, each with a short instruction:
    `mcq` – options with a circle to mark; `tf` – "נכון" / "לא נכון" with squares; `fill` – the sentence with a
    blank line and a word bank (dashed frame) of its options; `order` – the sentences shuffled, with a box for
    the number next to each.
  - Everything follows the lesson's nikud mode (section 7), including the instructions.
  - Options, word banks and order sentences are shuffled once with a PRNG seeded from the lesson content
    (FNV-1a hash of the lesson JSON + mulberry32), so the same lesson always prints the same sheet and the answer
    page matches it. A shuffle that keeps the original order is retried.
  - A question never splits across pages (`break-inside: avoid`).
  - With the checkbox, a separate page (`break-before: page`) lists the correct answers: the option text, נכון /
    לא נכון, the missing word, and for `order` each printed sentence with the number that belongs next to it.

---

## 4. Child page – `play.html`

Fixed order: **Games → Reading → Exercises → Finish**. Progress bar on top.

### 4.0 Navigation bar
- From the first game to the finish, every screen has a bar fixed to the bottom of the screen with two big
  buttons: **"→ הקודם"** (right) and **"הבא ←"** (left). The start screen has no bar (its "מתחילים ▶" button
  opens the first screen).
- The screens, in order: each game, the reading screen, **each question** on its own, the finish screen.
  "הקודם" on question 1 goes back to the reading screen.
- Both buttons are always active, except "הקודם" on the first screen and "הבא" on the finish screen
  (disabled). "הבא" never waits for the screen to be done; when a game ends or a question is answered right
  it pops once and takes focus.
- The bar has a fixed height (`--nav-h`: 84px + the bottom safe area). On a phone the two buttons share the
  width (thumb size, at least 56px high); on wider screens each is at least 180px wide. The page leaves room
  below its content so nothing ends up hidden behind the bar.
- Going back to a game starts it again. Coming back to the reading screen starts it fresh (mode "רגיל").

### 4.1 Games (learn the target words)
All games use only the lesson's target words (+ their emojis).
1. **זוגות (Memory)** – cards: word ↔ emoji. Flip two, match pairs.
2. **הרכבת מילה** – letters of a target word shuffled (with nikud attached to each letter as written); child taps letters in order.
3. **שומעים ובוחרים** – the word is read aloud (Web Speech API, `he-IL`); child picks it from 3–4 target words.
   If no Hebrew voice is available on the device, skip this game silently.

Child can replay a game ("↻ שוב", after it ends) or move on with "הבא" at any time.

### 4.2 Reading
- Story displayed per the nikud mode (section 7).
- Target words highlighted (background color).
- Optional: tap a word to hear it (if a Hebrew voice exists).
- Text size +/- buttons.
- Three reading modes (`js/reading.js`), chosen with big buttons above the story:
  - **רגיל** – the story as is (default). No pace or playback controls.
  - **סימון מתקדם** – the current word is marked (light blue background + outline, distinct from the yellow
    target-word highlight) and the mark moves on at the chosen pace. If the current word leaves the screen
    (between the sticky top bar and the playback bar), the page scrolls it to the center
    (instantly with `prefers-reduced-motion`).
  - **מילים נעלמות** – words disappear in order from the start of the story (`visibility: hidden`,
    so the text never moves).
  - Marks change only background / box-shadow / visibility, never size or spacing, so text sizing keeps working
    during playback. Works in all nikud modes (words are counted without nikud).
  - Punctuation touching a word is part of it: it is marked with the word and vanishes with it. That covers
    punctuation after the word (`קָטָן.`, `טוֹב!"`, a maqaf) and before it (an opening quote: `"כֶּלֶב`).
    `Render.story` wraps each word with its punctuation in a `<span class="unit">` (the inner
    `<span class="word">` keeps the target highlight and tap-to-speak); text between two words is split at
    its whitespace. Punctuation standing alone between spaces (a dash) is not attached to any word.
- **Pace**: words per minute, 20–120. Three big buttons 🐢 🐇 🚀 (30 / 60 / 90) and a slider (step 5),
  with the value shown ("60 מילים בדקה"). Default 60. The last pace is saved in `localStorage`
  (`readingApp.pace`); a change applies from the next word.
- **Timing per word**: base = 60000 / pace ms, times a length factor from the number of letters without nikud:
  `1 + (letters − 5) × 0.1`, clamped to 0.7–1.6 (a 5-letter word takes exactly the base time).
  Extra stop after the last word of a sentence (`.` `!` `?` `…` in the text after it): +1 base;
  after the last word of a paragraph: +2 base (instead of the sentence stop).
  Where the stop falls depends on the mode (the total time is the same):
  - סימון מתקדם: the mark stays on the sentence's last word for its time plus the stop.
  - מילים נעלמות: the last word (with its punctuation) vanishes after its own time; the stop runs after it is
    gone, before the next word's time starts. So nothing is still shown that belongs to the finished sentence.
- **Playback controls** (sticky at the bottom of the screen while reading, right above the navigation bar,
  never under it): התחל / עצור, מילה אחורה, מההתחלה. Switching mode stops and resets to the start. At the end
  of the story playback stops and offers "עוד פעם" (restart) or "הלאה" (to the exercises). Leaving the
  screen (any way, including the navigation bar) stops the timer.

### 4.3 Exercises
Types (rendered one at a time):
- `mcq` – question + 3–4 options.
- `tf` – true / false (נכון / לא נכון).
- `fill` – sentence with a blank, choose the missing word from options.
- `order` – sentences from the story shuffled; child drags or taps them into order.

A question counts as **right** only when it was answered right on the first try. Skipping a question
("הבא" before answering) counts as not right, but the child can come back and answer it; a first-try answer
then counts. A wrong try counts even if the child leaves the question and comes back before answering right.
Coming back to a question already answered right shows it solved (right option marked, blank filled, sentences
in order, "כבר עניתם נכון ✓"); it takes no clicks and the score does not change.

### 4.4 Finish
- "כל הכבוד!" screen with stars: right questions / all questions ≥ 0.8 → 3, ≥ 0.5 → 2, else 1.
  Button to start again ("↻ מתחילים מחדש" → start screen, all answers cleared).
- Nothing is saved or sent anywhere.

---

## 5. Lesson data format (JSON)

```json
{
  "version": 1,
  "title": "כֶּלֶב בַּגִּנָּה",
  "topic": "כלבים",
  "nikudMode": "full",
  "level": "1-2",
  "targetWords": [
    { "word": "כֶּלֶב", "emoji": "🐕" },
    { "word": "גִּנָּה", "emoji": "🌳" }
  ],
  "story": "full story text, fully vocalized, paragraphs separated by \n",
  "exercises": [
    { "type": "mcq",  "question": "...", "options": ["...", "...", "..."], "answer": 0 },
    { "type": "tf",   "statement": "...", "answer": true },
    { "type": "fill", "sentence": "הַ___ רָץ בַּגִּנָּה", "options": ["כֶּלֶב", "חָתוּל", "סוּס"], "answer": 0 },
    { "type": "order", "sentences": ["first", "second", "third"] }
  ]
}
```

Rules:
- With nikud mode full or partial, `story`, `title`, words, questions and options are **stored fully vocalized**
  (by Dicta, step 5). The display mode is applied at render time (section 7). With mode none they may be stored
  without nikud.
- `order.sentences` is stored in the correct order; the player shuffles.

### Validation (teacher page, before creating link)
- Valid JSON, all required fields, correct types, `answer` indices in range.
- Story word count within ±15% of the requested length (show the actual count; warning, not blocking).
- Every target word appears in the story at least once – compare after stripping nikud, and allow Hebrew prefixes (ו, ה, ב, כ, ל, מ, ש, and combinations like וה, שב).
- Number of target words matches the request (warning).
- Nikud is not validated here: it is added in step 5. Messages about nikud are never sent back to the AI.

---

## 6. Prompt template (generated by the teacher page)

Written in Hebrew. Placeholders in `{}`.

```
אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.

כתוב סיפור קצר בעברית בנושא: {topic}
רמת קריאה: {level label}.
אורך הסיפור: {P} פסקאות, בכל פסקה {S} משפטים, סך הכול בערך {length} מילים.
{IF words given} מילות היעד: {words}. כל מילת יעד חייבת להופיע בסיפור לפחות פעמיים.
{IF number given} בחר {n} מילות יעד פשוטות ומוחשיות שקשורות לנושא. כל מילה חייבת להופיע בסיפור לפחות פעמיים.

הנחיות לסיפור:
- שפה של ילדים, מותאמת לרמת הקריאה.
- {level sentence line}
- {level language lines, one per line}
- כתוב את כל הטקסט בלי ניקוד בכלל: הכותרת, הסיפור, המילים, השאלות והתשובות.
- כתוב בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר).
- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה.
- אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד.

תרגילים:
- 3 שאלות הבנה אמריקאיות (3 אפשרויות כל אחת). {level questions line}
- 2 משפטי נכון/לא נכון.
- 2 משפטים להשלמת מילה חסרה (סמן את החסר ב-___), עם 3 אפשרויות.
- תרגיל סידור אחד: 4 משפטים מהסיפור, בסדר הנכון.
- בשדה answer: מספר האפשרות הנכונה, כשהאפשרות הראשונה היא 0.

החזר את ה-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה:
{schema example from section 5, without nikud and without nikudMode}
```

- The length is given as paragraphs and sentences (the level's words per sentence, 4 sentences per paragraph),
  because AIs follow those better than a word count, plus the total word count.
- The AI writes **without nikud**: its nikud is unreliable. Nikud comes from Dicta in step 5.
- The template lives in `js/prompt.js` so it is easy to tune.

---

## 7. Nikud handling – `js/hebrew.js`

- `stripNikud(s)`: remove Hebrew points and cantillation (U+0591–U+05C7, except letters), keep letters and punctuation.
- `normalize(s)`: Unicode NFC + consistent mark ordering, so identical vocalization from different sources compares equal.
- `matchesWord(token, target)`: compare stripped forms, allow leading prefixes (section 5).
- Render modes:
  - `full` – show as stored.
  - `none` – `stripNikud` on everything.
  - `partial` – vocalize only target-word occurrences in the story; strip all other words. Questions follow the same rule.

---

Source of nikud: Dicta Nakdan, by copy-paste in step 5 (no API call, so the site stays static).

## 8. Out of scope for v1 (planned)

- Nikud verification layer: verified word dictionary (JSON) + deterministic comparison, coloring words green / red / gray; homographs flagged for review, not as errors.
- Direct (API) integration with Dicta Nakdan instead of copy-paste.
- Word-search game, printable worksheet, custom GPT / Gemini Gem for teachers.

---

## 9. Definition of done for v1

- Teacher can go form → prompt → paste → preview/edit → check and nikud → link, on phone and desktop.
- Child link opens and runs the full flow with no network calls except loading fonts.
- Works on GitHub Pages.
- A sample lesson file `samples/sample-lesson.json` and a README (Hebrew) explaining how a teacher uses the site.
