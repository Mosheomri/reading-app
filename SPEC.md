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
- **Logo**: `assets/logo.png` is the original (1824 × 862, ~900 KB, white background), not loaded by the site.
  `assets/logo-web.png` is made from it (margins trimmed, white made transparent, 720 px wide, 128 colors,
  ~20 KB) and shown at the top of the teacher page and both setup pages (there it links to the teacher page;
  up to 300 px wide, 72vw on phones), at the top of the print sheet (48 mm; printing waits until it is
  decoded, at most 1.5 s), and small (up to 160 px) under the buttons of the child's finish screen.
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
/js/praise.js       encouragement sentences, their sound (recording / voice / text), mute
/js/reading.js      paced reading modes on the child's reading screen
/js/levels.js       reading levels (prompt guidelines, default question counts) and kinds of text
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
| Kind of text (סוג הטקסט) | סיפור / טקסט מידעי | default סיפור; stored in the lesson (`genre`); changes the prompts and the default question types |
| Reading level (רמת קריאה) | גן–תחילת א׳ / סוף א׳–ב׳ / ג׳–ד׳ / ה׳–ו׳ | default סוף א׳–ב׳; see below |
| Story length (אורך) | number of words | e.g. 100; range 20–2000 (`MAX_STORY_WORDS` in `js/builder.js`) |
| Target words (מילות יעד) | either a number (AI chooses) or a list typed by teacher | 2–10 words |
| Nikud (ניקוד) | full / partial / none | partial = only target words vocalized |
| Question types (סוגי שאלות) | a checkbox and a count (0–5) per type | defaults per level; at least one type |

#### Question types
- Seven rows, in this order (also the order asked for in the prompt): אמריקאית, נכון / לא נכון, השלמה, סידור,
  פתוחה, איתור מידע, מסר גלוי וסמוי (`Levels.TYPES`). Count 0 = not included; unchecking sets 0, checking
  gives the level's count (or 1).
- Defaults per level, in `js/levels.js` (`exercises`), applied when the level changes and by "חזרה לברירת
  המחדל":

  | level | mcq | tf | fill | order | open | locate | message | message parts |
  |---|---|---|---|---|---|---|---|---|
  | גן–תחילת א׳ | 3 | 2 | 1 | 1 | 0 | 1 | 0 | multiple choice |
  | סוף א׳–ב׳ | 3 | 2 | 2 | 1 | 0 | 1 | 1 | multiple choice |
  | ג׳–ד׳ | 3 | 1 | 2 | 1 | 1 | 1 | 1 | open |
  | ה׳–ו׳ | 3 | 1 | 1 | 1 | 2 | 1 | 1 | open |

- **Informational text** (`genre: 'info'`, `Levels.exerciseDefaults(level, genre)`): no sequence of events and no
  hidden message, so `order` and `message` default to 0 and their counts go to `locate` (e.g. ג׳–ד׳: 3 mcq, 1 tf,
  2 fill, 1 open, 3 locate). The teacher can still choose them. Changing the kind of text, like the level, applies
  its defaults.
- Saved with the other settings; settings saved before this field get the level's defaults.
- The prompt lists only the chosen types with their counts, and its JSON example shows one exercise of each
  chosen type (the message example in the level's style). The "answer = option number" line only when some
  type has options. The request keeps the counts; `Lesson.check` warns per type when the answer has a
  different number (old drafts have no counts: no warning).

#### Reading levels – `js/levels.js`
All level settings live in one file, so they are easy to tune. Each level has an id (stored in the lesson
as `level`), a label, and prompt lines used by the writing, editing and review prompts: `sentence` (sentence
length), `language` (vocabulary and style, every kind of text), `story` (characters and dialogue, stories only),
`avoid` (what not to write at this level), and `questions` (the kind of comprehension questions).
`Levels.textLines(level, genre)` gives `language` plus, for a story, `story`.

| Level | id | Sentences | Language | Avoid | Questions |
|---|---|---|---|---|---|
| גן–תחילת א׳ | `k-1` | 3–6 words, joined with ו / אז / כי | words from the young child's world; deliberate repetition of a phrase; one tense; 1–2 characters with short names, one-line dialogue | abstract words, multi-part sentences, jumps in time or place | only direct |
| סוף א׳–ב׳ | `1-2` | 4–8 words, varied | familiar words; joined with ו, כי, אבל, אז, כש-; few descriptions; some repetition; clear dialogue | abstract or rare words, more than two clauses, jumps | direct + one simple comprehension question |
| ג׳–ד׳ | `3-4` | 6–12 words, varied | wider vocabulary explained by context; ש, כש, כי, אבל, לכן; more description; dialogue that moves the plot | jargon, high literary language, an explicit moral | one inference question |
| ה׳–ו׳ | `5-6` | 8–15 words, with short ones | rich vocabulary but a children's book; connectives; vivid description (show, don't tell); complex feelings | high or archaic language, jargon, an explicit moral | two inference questions |

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
  counts like an HTTP error. While it streams, the stage shows "כותב סיפור… (נכתבו כבר X תווים)"; before the
  first answer text, while only thought summaries come, "כותב סיפור: חושב…".
- **Thinking**: `generationConfig.thinkingConfig.thinkingLevel` per call (`Gemini.THINKING`, by console name):
  **medium** for writing and editing the story (`write-story`, `edit-story`; also `write-lesson`), where the
  quality of the text matters most; **low** (`THINKING_LEVEL`) for the exercises, the review and the nikud check
  (`gemini-3.8-flash` has low / medium / high; ai.google.dev/gemini-api/docs/thinking). `includeThoughts: true` too: thought
  summaries stream while the model thinks, so the timer is reset and the teacher sees "חושב…" (they are not
  part of the answer). If the API rejects the setting (400 mentioning thinking), the request is sent once more
  without it.
- **Timeouts**: a streamed answer may take **120 s to its first data** (`config.firstDataTimeout`: the model
  may think first); after that it times out only after **45 s with no new data** (`config.idleTimeout`; the
  timer starts again on every chunk, so a long answer that keeps coming is never cut). Plain requests
  (checking the key): 120 s (`config.timeout`).
- **Console**: one line per request, `[Gemini] <call> (<model>): HTTP <status>, <seconds> s (first data after
  <seconds> s), <chars> chars, finish <reason>[, retry][ – <error and Google's message>]` (`console.info`,
  `console.warn` on errors). Calls: `check-key`, `write-story`, `edit-story`, `write-exercises`, `review-text`, `nikud-check` (section 3.2; `write-lesson`:
  the whole lesson in one call, `Gemini.writeLesson`, not used by the flow). The key is never logged.
- **Model and output**: `MODEL` is one constant at the top of `js/gemini.js`: `gemini-3.8-flash` (stable, has a free tier; checked in the official pricing and models pages,
  October 2026). Structured output: `generationConfig.responseMimeType = 'application/json'` and a
  `responseSchema` (OpenAPI subset): `STORY_SCHEMA` (title, topic, targetWords, story) and `EXERCISES_SCHEMA`
  (`{exercises}`) are the two halves of the lesson schema, `EDIT_SCHEMA` is `{story}` (the editor's rewrite), which mirrors the prompt's example (section 5), with
  `answer` as a string for all exercise types ("0", "true"), which `Lesson.coerce` already accepts; the review
  schema is the list the review prompt asks for.
- **Flow** after "✨ צור שיעור" (shown next to "יצירת פרומפט" once a key is saved), with a stage list on top of
  the page (⏳ active, ✓ done, ✕ failed, 👆 the teacher's turn, – skipped):
  1. **כותב סיפור…**: the story part of the copy-paste prompt (`buildStoryPrompt`: the same lines as
     `buildPrompt` up to the exercises), with the small story schema. Separate calls instead of one: each answer
     is smaller, so it comes faster, and a failed exercises call does not lose the story.
  2. **עורך את הסיפור…** (automatic mode only): `buildEditPrompt(settings, draft)`, with the role "עורך ספרי ילדים
     מנוסה", rewrites the draft for flow and natural language without changing the plot (for an informational
     text: the facts), the target words, the kind of text or the level; the length may change by up to 20%.
     Answer `{story}` (`Gemini.editStory`, `edit-story`). **Guard**: the edit replaces the draft only if every
     target word is still in it (`Hebrew.matchesWord`, prefixes allowed) and its word count is within 30% of the
     draft's; otherwise the stage says "העריכה לא נשמרה (…); ממשיכים עם הטיוטה". A failed edit call never stops
     the flow either ("העריכה לא הצליחה…"): the exercises are written on the draft.
  3. **כותב תרגילים…**: `buildExercisesPrompt(settings, story)`: the (edited) story, its title and target
     words, the same exercise lines as the copy-paste prompt and the text rules. Story and exercises are joined
     into one lesson JSON, which goes into the step 3 box. If this call fails, the story is kept: "↻ לנסות שוב
     את התרגילים" sends only this call again ("שיעור חדש" starts over).
  4. **בודק את השיעור…**: the same checks as a paste (`analyzeResponse`: extract, coerce, sort order exercises,
     `Lesson.check`). Errors stop the flow; warnings only go on (they show in the preview).
  5. **בודק טקסט…**: a separate call with the existing review prompt (`Review.buildReviewPrompt`). The check
     step opens and the suggestions are shown for approval exactly as after a paste.
  6. **מחכה לאישור ההצעות**: when the last suggestion is approved or rejected, the flow goes on. That last
     decision is a click, so Dicta may open in a new window then (popups need a user gesture).
  7. **מנקד בדיקטה…**: if the Dicta bridge answered before in this browser (`readingApp.dictaBridge`, set on its
     "ready", cleared when it does not answer), automatic nikud starts. Otherwise (or with no suggestions, when
     there is no click to open a window from) it is the teacher's turn: the auto-nikud button is highlighted and
     the manual steps are there. No nikud mode: skipped.
  8. "השיעור מוכן ✓" with a button to the link.
- **Errors** (clear Hebrew message, the copy-paste flow with the prompt ready in step 2, and "↻ לנסות שוב"):
  invalid key (400 `API_KEY_INVALID`, 401, 403), quota (429), no network, no data for 120 s / 45 s, blocked
  (`promptFeedback.blockReason`, safety finish), cut (`MAX_TOKENS`), empty answer, a lesson that fails the checks
  (its problems listed, and "לראות את התשובה ולתקן" opens it in step 3 with the usual fix message).
  **Retries**: server overloaded (**503** / `UNAVAILABLE`, also as an error event inside the stream): up to **3
  more tries**, waiting **2, 5 and 10 s** (`config.busyDelays`); the stage shows "השרת של גוגל עמוס, מנסה שוב…
  (ניסיון N מתוך 4)". Other temporary errors (network, no data, other 5xx): one more try after 4 s. None for 429
  or a bad key.
  **Fallback model**: if the main model is still overloaded after its tries, the call switches to
  `FALLBACK_MODEL` (a constant at the top of `js/gemini.js`: `gemini-3.5-flash-lite`, stable, free tier,
  structured outputs and thinking), one thinking level lower than the call asks (`FALLBACK_THINKING`: medium →
  low, low → minimal), with the same retries. The stage shows "ממשיכים עם מודל קל יותר (…)" and the story is marked as written with the
  fallback. The rest of that run (the edit, the exercises, the review) stays on the fallback; the next "צור שיעור" starts with the main
  model again (`Gemini.resetModel()`). Both models overloaded: "השרת של Google עמוס כרגע…" and copy-paste.
  **A review error** does not stop the flow: a clear message with **"↻ נסה ביקורת שוב"** at the top and in the
  review part (the manual review is offered too). Nikud is offered meanwhile, without scrolling away from the
  message; a successful retry shows the suggestions and nikud waits for the approvals again. In no-nikud mode
  "ready for a link" is shown together with the failure and its button.
- Leaving the flow (new lesson, loading a file, pasting a response, "יצירת פרומפט") cancels it; late answers
  from a cancelled run are ignored.
- **Tests**: `tests/gemini.py`, against a mock API (Playwright routing); the editor's call, its guard and the
  thinking levels also in `tests/text_quality.py`, with the kind of text, the new prompts, the review's editing
  checks, letters of another script and lines instead of paragraphs. **Real timing**: `tests/gemini_bench.py`
  (not in `run_all.py`; the key from the `GEMINI_API_KEY` environment variable only) writes lessons the way the
  flow does with both models and reports the time to the first data, the total time and the failures.

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
- **Lines instead of paragraphs** (`Lesson.lineBroken`): when the story has 3 or more paragraphs and most of
  them are a single sentence, the warning "הטקסט מחולק לשורות במקום לפסקאות…" (also in step 3 and in the
  automatic flow's notes). In the preview it has a button **"אחד לפסקאות"** (`Lesson.joinParagraphs`): runs of
  one-sentence lines become paragraphs of about 4 sentences (10 lines → 3, 4, 3); longer paragraphs stay.
- Non-blocking warning "ייתכן כתיב חסר": words with holam or qubuts on a letter other than ו, with no ו or א
  after it (exceptions: פה, כה, איפה, משה, also with prefixes). Works once the text has nikud.

### Step 5: Check and nikud
1. **Text review (optional)**: a prompt for a second AI ("עורך לשון ועורך ספרי ילדים") with all lesson texts
   **without nikud**, so ktiv haser stands out. Besides spelling, grammar and the level (the level's lines,
   including what to avoid), it has **editing checks**, each finding a suggestion with a reason, `error` for a real
   mistake and `style` for better wording: flow and connectives, filler sentences (suggest merging with the next or
   previous sentence: original = both, fix = the merged wording), logic and consistency in the plot, time and
   place (a contradiction is an error), jargon and high language, phrases that sound translated, target words in
   a wrong sense (error) or forced in (style), and mixing kinds of text (a story inside an informational text or
   the other way round). The lesson's kind of text and target words are named. A fix may be a sentence or two. The texts are the lesson's slots (`Review.slots`), which include every text of the new types:
   `exercises[i].sampleAnswer`, a locate `sentence`, and a message's `visible.question` / `.options[j]` /
   `.sampleAnswer` (same for `hidden`). The prompt adds that a locate sentence must stay identical to the story
   (a fix to one is suggested for both), and that sample answers must be right and short. It also asks to check
   that every sentence makes sense: a sentence that is illogical or odd in meaning (e.g. "אנשים שמחים ועצובים
   בתוך ארבעה קירות ביתם") gets a clearer wording as a `style` suggestion, with the reason. The same slots are
   the text sent to Dicta, so the new texts get nikud like all the others. The AI returns JSON suggestions `{field, type: error|style, original, fix, reason}` (fix without
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
   - **After the first Dicta run** (`state.nikudOnce`, kept in the draft), only the lines that need it go to
     Dicta again (`Review.linesToNikud`): lines that changed since Dicta's nikud was last valid (compared with
     `state.nikudLines`, the vocalized lines then, kept in the draft; choosing a version of a word updates it),
     and lines with Hebrew words that have no nikud (text that came in later, such as an approved suggestion,
     whose fix has no nikud; words Dicta left without nikud). In those lines words without nikud take Dicta's
     word (`Review.lineFills`, same letters required), and vocalized words that differ are listed for a choice,
     as in the full comparison. An edit undone leaves nothing to send. The button with nothing to send, and a
     pasted whole text, run the full comparison as before.
   - With the bridge known, this happens by itself inside the next click (`window.open` needs one;
     `navigator.userActivation`): after the last decision on the suggestions, on going to the check step, on
     "יצירת קישור". Without the bridge: "נוסף טקסט בלי ניקוד אחרי הניקוד (N שורות)…" with what to do; "העתק
     טקסט בלי ניקוד" copies only those lines and the paste box takes only them. Messages that fit the stage:
     the suggestion's note ("השורה שלו תנוקד שוב בדיקטה"), the preview ("שנוספו אחרי הניקוד… ינוקדו במעבר לשלב
     הבדיקה"), and after Dicta "דיקטה ניקדה את השורות שהשתנו (N מילים)".
   - Words still without nikud after Dicta (full mode) are listed ("דיקטה לא ניקדה N מילים"); the button then
     sends only their lines.

#### 3.2 Second opinion on the nikud (Gemini; automatic mode only)
Only when a Gemini key is saved; with copy-paste (no key) nothing changes. It never blocks the lesson.
- **When**: every time Dicta's nikud is applied (`compareNikud` succeeded, automatic or pasted by hand), in the
  background. The teacher can approve suggestions, edit, view the preview or make a link meanwhile; the auto
  flow's nikud stage is done as usual.
- **Request**: the same lines that went to Dicta (`Review.nikudLines`: every slot, split at its newlines,
  empty lines left out, without nikud), in order, as a JSON array in the prompt (`Review.buildNikudPrompt`):
  full nikud only, in ktiv male, no change to any letter, punctuation, space or word, no cantillation or meteg,
  exactly N lines back. Structured output `Gemini.NIKUD_SCHEMA` = `{lines: [string]}`; call
  `Gemini.checkNikud`, console name `nikud-check`, the usual retries and fallback model. A long lesson is split
  into calls of up to `Gemini.config.nikudChunkChars` (2500) characters (`Review.nikudChunks`, whole lines; a
  longer line alone), sent one after another. A part whose answer does not have the same number of lines is
  not compared (a console warning); if no part could be compared, it counts as a failure.
- **Comparison** (`Review.compareSecond`), word by word with the lesson's words as they are when the answer
  comes (Dicta's nikud, or the teacher's choice): not compared when the letters differ at Gemini's (or the word
  changed here meanwhile), when Gemini's word has no nikud, or when the child sees the word without nikud
  (partial mode: only target words count). Only a difference in the **reading** is marked
  (`Review.sameReading`, by `Review.pronunciation`: one consonant and one vowel sound per letter): dagesh counts
  only in ב כ פ (b/v, k/kh, p/f) and in ו (shuruk); shin / sin dot (a ש without a dot fits both); vowels by
  their sound in modern Hebrew: patah = qamats = hataf patah, tsere = segol = hataf segol, holam on the letter
  or on the ו, qubuts/shuruk = u, qamats qatan = qamats (the same sign on the page); sheva fits no vowel or e;
  a ו / י that only carries the vowel before it is silent; cantillation, meteg and rafe are ignored.
- **Report**: every difference (also those not marked) with its kinds (`Review.diffKinds`: דגש בבכ״פ, דגש באות
  אחרת, שווא / חטף, שווא / בלי סימן, שווא / תנועה, קמץ קטן, פתח / קמץ, צירה / סגול, חולם / שורוק, שי״ן / שׂי״ן,
  תנועה חסרה, תנועה אחרת, מתג / טעמים). A console summary per run (`console.table`), and the link "פירוט כל
  ההבדלים (קובץ)" downloads it as JSON; `tests/nikud_diff_report.py` sums up several files by kind.
- **Display**: words that read differently get an orange underline (`.nikud-check`) everywhere in the preview
  (title, target words, story, exercises, also fill sentences). Above the story: "X מילים לבדיקה" with
  "הבאה ←" (scrolls to the next marked word and opens it) and "סמן הכול כבדוק". Clicking a marked word (or
  Enter) opens a small window (`<dialog id="nikudCheckDialog">`): the word in context, Dicta's version
  (selected by default), Gemini's version, and manual editing (nikud only: the letters must stay the same, or
  a message). A choice replaces the word (`Review.setWord`), keeps the Dicta check valid (only nikud changed),
  and removes the mark. Until the teacher chooses, Dicta's nikud stays. Step 5 shows the same count with
  "לתצוגה המקדימה". While it runs: "בדיקה כפולה של הניקוד עם Gemini…"; no difference: "Gemini ניקד כמו דיקטה ✓";
  all checked: "כל המילים נבדקו ✓".
- **Failure**: a small message "הבדיקה הכפולה לא רצה" with "↻ נסה שוב" (and the reason); the lesson goes on.
- **Edits**: a mark stays only while its word is unchanged (`Review.liveMarks`, by field and word index); an
  edited word loses its mark for good. Dicta again starts a new second opinion (after a run on some lines
  only, only those lines, and the marks elsewhere stay); a new lesson drops it. The marks are kept in the saved
  draft (`second`).
- **Tests**: `tests/nikud_second.py`, against a mock API; `tests/renikud.py` (only the changed lines, with
  the Dicta bridge mock); `tests/emoji.py`.

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
     have nikud (an update on the way is not taken), and it has not changed for 800 ms (4 s when some Hebrew
     words still have no nikud: Dicta may not be done; script 1.1.0). 30 s per part at most.
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

#### Editing the new types (step 4)
- `open`: question + sample answer. `locate`: question + the answer sentence, typed or picked from a list of
  the story's sentences (`Lesson.sentencesOf`), with "המשפט נמצא בסיפור ✓" or a warning when it is not in the
  story (also a blocking check). `message`: both parts, each with a choice "אמריקאית / פתוחה" (switching keeps
  the question), and its options or sample answer. "+" buttons for all seven types; a new message follows the
  lesson's level. The preview shows sample answers, the locate sentence (✓ / ⚠️) and both message parts.
- A field removed by a re-render no longer writes its old value back (`textInput` ignores a `change` from a
  detached field; the sentence picker blurs the focused field first).

### Step 6: Link
- Link length (measured, `tests/long_story.py`): a 2000-word lesson with full nikud gives a link of about
  6,500–13,000 characters (more repeated wording compresses better; random text would reach ~16,600). Above
  8,000 characters (`LONG_LINK`) the link step says so, and advises sending it to yourself first: WhatsApp has no
  documented URL limit, but very long links are reported to be cut or not clickable on some phones.
  Long stories need no other change: Dicta's bridge splits the text into parts of up to 5,000 characters
  (a 2000-word lesson ≈ 10,000 characters, 3 parts; the page waits 30 s + 30 s per part, the script 30 s per
  part), Gemini streams (no total time limit), and the child page renders 2000 words without delay.
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
    the number next to each; `open` – the question and 3 lines to write on; `locate` – the question and
    "מתחו קו מתחת למשפט בסיפור שעונה על השאלה"; `message` – the two parts, "המסר הגלוי" and "המסר הסמוי"
    (underlined), each with circles (multiple choice) or 2 lines (open).
  - Everything follows the lesson's nikud mode (section 7), including the instructions. The instructions are
    vocalized in ktiv male (בַּסִּיפּוּר, הַמִּילָּה, קוֹדֶם), like Dicta's nikud, so without nikud they are still
    spelled right.
  - Options, word banks, order sentences and the options of each multiple-choice message part are shuffled
    once with a PRNG seeded from the lesson content
    (FNV-1a hash of the lesson JSON + mulberry32), so the same lesson always prints the same sheet and the answer
    page matches it. A shuffle that keeps the original order is retried.
  - A question never splits across pages (`break-inside: avoid`).
  - With the checkbox, a separate page (`break-before: page`) lists the correct answers: the option text, נכון /
    לא נכון, the missing word, for `order` each printed sentence with the number that belongs next to it, for
    `open` the sample answer, for `locate` the sentence, and for `message` both parts (the right option or the
    sample answer). Lessons without the new types print exactly as before (same shuffle).

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
All games use only the lesson's target words (+ their emojis). An emoji this device cannot show
(`Util.emojiShown`: measured on a canvas; a missing emoji is drawn like a character no font has, an unknown
sequence or flag falls apart into wider parts) is replaced by its word: in the teacher preview and print (the
word alone), on the start page and on its memory card; the build game leaves it out (the word is the answer).
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
- `open` – the question, a box to write in (not required) and "סיימתי ✓"; then the sample answer, praise and the
  next question. What the child wrote is kept while the lesson is open (seen again: read only).
- `locate` – the question and the story, every sentence clickable (`Render.storySentences`). The right sentence
  (any sentence overlapping the answer) turns green, with praise; a wrong one turns pale red, with a gentle hint.
- `message` – the visible part first ("המסר הגלוי: מה כתוב בסיפור במפורש?"), then the hidden part ("המסר הסמוי:
  מה הסיפור מלמד אותנו?"), each as a multiple-choice or an open question. Praise and the next question after both.
- **Stars** count only exercises with a right answer: open questions, and messages with open parts, do not count
  (`Lesson.counts`). The summary still counts every question.

**Encouragement** (`js/praise.js`):
- After a right answer: a praise sentence, picked at random but never the same as the one before, is shown and
  heard; when the sound ends (+0.3 s), or after **2 s** when nothing is heard, the next screen comes by itself
  (the last question leads to the finish screen). "הבא" before that moves on at once; leaving the screen in any
  way cancels the automatic move and stops the sound. A question already answered right, seen again, does not
  move on by itself.
- After a wrong answer: a gentle "try again" sentence (`TRY`, all with "נסו"), shown and heard, plus what is
  right so far (order exercise) or "אפשר להציץ בסיפור"; the child stays on the question.
- Each sentence: `{text, audio}` (`assets/audio/praise-NN.mp3`, `try-NN.mp3`), optional `say` to speak other
  words than the text. Sound: the recording if it loads; else the browser's Hebrew voice (`Util.speak`, the
  text without emoji); else nothing (text only). A recording that fails is not asked for again during the
  visit; one that never reports its end is not waited for beyond its length + 1.5 s (10 s at most).
- **Mute** 🔊/🔇 at the top of every screen (next to the progress bar, 44 px), `localStorage`
  `readingApp.muted`. Muted: no praise / try-again sound; the automatic move still waits 2 s. Words the child
  taps to hear (story, games) still speak: the child asked for them.
- A game's delayed speech (e.g. the listen game's word after 400 ms) is dropped once its screen is left.

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
    { "type": "order", "sentences": ["first", "second", "third"] },
    { "type": "open", "question": "...", "sampleAnswer": "..." },
    { "type": "locate", "question": "...", "sentence": "a sentence of the story, as written in it" },
    { "type": "message",
      "visible": { "question": "...", "options": ["...", "..."], "answer": 0 },
      "hidden":  { "question": "...", "sampleAnswer": "..." } }
  ]
}
```

Rules:
- With nikud mode full or partial, `story`, `title`, words, questions and options are **stored fully vocalized**
  (by Dicta, step 5). The display mode is applied at render time (section 7). With mode none they may be stored
  without nikud.
- `genre`: `"story"` or `"info"` (an informational text). Missing or anything else (lessons made before it):
  a story. `Lesson.clean` (links, JSON files, the print sheet's seed) writes it only for `"info"`, so a story's
  data is exactly as before. The child page does not use it.
- `order.sentences` is stored in the correct order; the player shuffles.
- `open`: a question and a sample answer (`sampleAnswer`). There is no right or wrong.
- `locate`: a question and the sentence of the story that answers it (`sentence`, matched without nikud and
  punctuation, as the order exercise does).
- `message`: two parts, `visible` (what the story says) and `hidden` (what it teaches). **A part with
  `options` is a multiple-choice question** (`question`, `options`, `answer` index); **a part without them is
  open** (`question`, `sampleAnswer`). The data says which, so a lesson keeps working if its level changes;
  the level only decides which kind is asked for when the lesson is written: גן–תחילת א׳ and סוף א׳–ב׳ →
  multiple choice, ג׳–ד׳ and ה׳–ו׳ → open (section 3, step 1).
- Lessons made before these types simply do not have them; nothing else changed, so old lessons and links
  work as before. A type a player does not know is left out (`unknown`).

### Backward compatibility (`tests/compat.py`)
- Links in the old format (LZString of the JSON, no `level`, the four first types) play as before, with the
  same stars.
- Old drafts (no `level`, a request without question counts) resume; no question-count warnings; a lesson
  vocalized before is still vocalized: `Review.signature` and the text sent to Dicta are unchanged for lessons
  without the new types (checked against the code before them).
- Old settings without question counts get the level's defaults (no level: the default level). Old settings
  and lessons without `genre` are stories.
- An old lesson's print sheet shuffles exactly as before (a snapshot of the old code's order). Only the
  instructions' spelling changed: בַּסִּיפּוּר, הַמִּילָּה, קוֹדֶם (ktiv male).
- The review prompt for an old lesson has two more guideline lines (locate sentences, sample answers);
  everything else in it is the same.

### Validation (teacher page, before creating link)
- Valid JSON, all required fields, correct types, `answer` indices in range.
- Story word count within ±20% of the requested length, as the prompt allows (show the actual count; warning,
  not blocking).
- **Letters of another script inside a Hebrew word** (Arabic, Greek, Cyrillic, Latin…), in any text of the
  lesson: an **error** ("המילה "…" כוללת אות ביוונית (ω). כתבו אותה מחדש באותיות עבריות."). Arabic letters that
  stand for the same Hebrew letter (ة / ه → ה, ل → ל, …: `LOOKALIKE` in `js/lesson.js`) are fixed automatically
  when the answer is read (`Lesson.coerce`), with the note "תוקנו אותיות ממערכת כתב אחרת…". A word written
  entirely in another script is not checked.
- Lines instead of paragraphs: warning (step 4).
- Every target word appears in the story at least once – compare after stripping nikud, and allow Hebrew prefixes (ו, ה, ב, כ, ל, מ, ש, and combinations like וה, שב).
- Number of target words matches the request (warning).
- `open`: question and sample answer required. `locate`: question required; the answer sentence must be found
  in the story (error: the child could not tap it). `message`: each part needs a question; a multiple-choice
  part is checked like `mcq` (options, answer in range), an open part needs a sample answer.
- Accepted spellings from an AI: `open-ended` / `openQuestion` → open, `find` / `find sentence` → locate,
  `explicit` / `implicit` for the parts, `answer` for `sampleAnswer` / `sentence`, an answer given as the option's text.
- Nikud is not validated here: it is added in step 5. Messages about nikud are never sent back to the AI.

---

## 6. Prompt template (generated by the teacher page)

Written in Hebrew, in `js/prompt.js` so it is easy to tune. The principle: the text should read as if a
professional children's author wrote it; when quality conflicts with a number (length, how often a word appears),
quality wins. The same story lines are used by the copy-paste prompt (`buildPrompt`) and by the automatic flow's
first call (`buildStoryPrompt`). Placeholders in `{}`:

```
אתה סופר ישראלי מנוסה לילדים, שכותב ספרים לקוראים מתחילים.
כתוב {סיפור קצר | טקסט מידעי קצר} בעברית לילד שלומד לקרוא, בהוראה מותאמת.
העיקרון: … כשיש התנגשות בין איכות לבין דרישה מספרית (אורך, מספר הופעות של מילה), האיכות קובעת.

נושא: {topic}
סוג הטקסט: {סיפור | טקסט מידעי}.
רמת קריאה: {level label}.
אורך: בערך {length} מילים. סטייה של עד 20% (בין {0.8·length} ל-{1.2·length} מילים) מותרת.

{מבנה הסיפור: a named main character with a wish or problem; attempts, climax, resolution; beginning, middle
 and end; consistent place and time; every sentence moves the plot; short dialogue welcome; a story only
| מבנה הטקסט המידעי: one topic; an opening sentence; a paragraph per subtopic; a closing sentence; no plot and
 no fictional characters; informational only}

מילות יעד:
- {the teacher's words | choose n simple, concrete words that fit the text naturally (e.g. in a story about
  football the object is "כדור", not "כדורגל")}
- only in their right meaning, where they fit naturally; at least once, preferably 2–3 times if natural;
  never invent a sentence or character just to fit a word; one common emoji each.

שפה:
- natural Hebrew of Israeli children's books; varied sentence length, connectives (ו, אבל, כי, אז, פתאום, כש-,
  ש-) and commas; no high literary language, no jargon, no translated-sounding phrases, no filler sentences.
- {level sentence line} {level language lines} {level story lines, stories only}
- מה לא לכתוב ברמה הזו: {level avoid lines}
- paragraphs of 3 to 6 sentences; a line break only between paragraphs.
- no nikud; ktiv male; no emoji in the text.

לפני שאתה מחזיר את התשובה: קרא את הטקסט כאילו אתה מקריא אותו לילד, ותקן כל משפט שנשמע לא טבעי.

תרגילים (בסדר הזה): {the chosen types; for an informational text "הסיפור" → "הטקסט"}
החזר את ה-JSON …: {schema example from section 5, without nikud and without nikudMode}
```

- The length is asked for as "about N words" with the 20% range; the older paragraph × sentence count is gone.
- **The editor's prompt** (automatic mode, `buildEditPrompt`): the role "אתה עורך ספרי ילדים מנוסה.", what does
  not change (plot / facts, target words with their spelling, kind of text, level, length within 20% of the
  draft's word count), what to improve (flow, filler, logic and consistency, translated phrases / jargon / high
  language, a forced target word), the same language lines, the read-aloud line, the title and the draft; answer
  `{story}`.
- The exercises prompt (`buildExercisesPrompt`) keeps its role ("אתה כותב תוכן ללימוד קריאה…") and speaks of
  "הטקסט" for an informational text.
- The AI writes **without nikud**: its nikud is unreliable. Nikud comes from Dicta in step 5.

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
