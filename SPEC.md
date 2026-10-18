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
/js/hebrew.js       nikud helpers (strip, normalize, word matching)
/js/lesson.js       schema validation, encode/decode link
/js/lz-string.min.js
```

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
| Story length (אורך) | number of words | e.g. 100; range 20–400 |
| Target words (מילות יעד) | either a number (AI chooses) or a list typed by teacher | 2–10 words |
| Nikud (ניקוד) | full / partial / none | partial = only target words vocalized |

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
     vocalize it in Dicta Nakdan (modern style, ktiv male), paste the result back.
   - The pasted text must have the same number of words. Words that have no nikud in the lesson take Dicta's
     word as is, after checking the letters are identical. A lesson without nikud is therefore vocalized with
     no comparison at all.
   - Words that already have nikud (e.g. a lesson file made before, or a teacher's own vocalization) are
     compared: only differing words are listed, and the teacher picks the lesson's version or Dicta's
     (ו/י-only spelling differences are allowed for these words and tagged "כתיב שונה").
   - The nikud step is tied to the text it was applied to. Any text change afterwards requires Dicta again
     before a link (the progress bar cannot skip it either). The state is kept in the saved draft; a loaded
     lesson file in which every word has nikud counts as vocalized.

### Step 6: Link
- Build the link, show it, "העתק קישור" button and "שלח בוואטסאפ" button (`https://wa.me/?text=...`).
- "פתח לבדיקה" button that opens `play.html` with the lesson.
- Button to download the lesson JSON (backup) and to load a JSON file back for editing.

---

## 4. Child page – `play.html`

Fixed order: **Games → Reading → Exercises → Finish**. Progress bar on top.

### 4.1 Games (learn the target words)
All games use only the lesson's target words (+ their emojis).
1. **זוגות (Memory)** – cards: word ↔ emoji. Flip two, match pairs.
2. **הרכבת מילה** – letters of a target word shuffled (with nikud attached to each letter as written); child taps letters in order.
3. **שומעים ובוחרים** – the word is read aloud (Web Speech API, `he-IL`); child picks it from 3–4 target words.
   If no Hebrew voice is available on the device, skip this game silently.

Child can replay a game or press "הלאה".

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
- **Pace**: words per minute, 20–120. Three big buttons 🐢 🐇 🚀 (30 / 60 / 90) and a slider (step 5),
  with the value shown ("60 מילים בדקה"). Default 60. The last pace is saved in `localStorage`
  (`readingApp.pace`); a change applies from the next word.
- **Timing per word**: base = 60000 / pace ms, times a length factor from the number of letters without nikud:
  `1 + (letters − 5) × 0.1`, clamped to 0.7–1.6 (a 5-letter word takes exactly the base time).
  Extra stop after the last word of a sentence (`.` `!` `?` `…` in the text after it): +1 base;
  after the last word of a paragraph: +2 base (instead of the sentence stop).
- **Playback controls** (sticky at the bottom of the screen while reading): התחל / עצור, מילה אחורה,
  מההתחלה. Switching mode stops and resets to the start. At the end of the story playback stops and offers
  "עוד פעם" (restart) or "הלאה" (to the exercises). Leaving the screen stops the timer.

### 4.3 Exercises
Types (rendered one at a time):
- `mcq` – question + 3–4 options.
- `tf` – true / false (נכון / לא נכון).
- `fill` – sentence with a blank, choose the missing word from options.
- `order` – sentences from the story shuffled; child drags or taps them into order.

### 4.4 Finish
- "כל הכבוד!" screen with a simple summary (e.g. stars). Button to start again.
- Nothing is saved or sent anywhere.

---

## 5. Lesson data format (JSON)

```json
{
  "version": 1,
  "title": "כֶּלֶב בַּגִּנָּה",
  "topic": "כלבים",
  "nikudMode": "full",
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
אורך הסיפור: {P} פסקאות, בכל פסקה {S} משפטים קצרים, סך הכול בערך {length} מילים.
{IF words given} מילות היעד: {words}. כל מילת יעד חייבת להופיע בסיפור לפחות פעמיים.
{IF number given} בחר {n} מילות יעד פשוטות ומוחשיות שקשורות לנושא. כל מילה חייבת להופיע בסיפור לפחות פעמיים.

הנחיות לסיפור:
- משפטים קצרים ופשוטים, שפה של ילדים.
- כתוב את כל הטקסט בלי ניקוד בכלל: הכותרת, הסיפור, המילים, השאלות והתשובות.
- כתוב בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר).
- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה.
- אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד.

תרגילים:
- 3 שאלות הבנה אמריקאיות (3 אפשרויות כל אחת).
- 2 משפטי נכון/לא נכון.
- 2 משפטים להשלמת מילה חסרה (סמן את החסר ב-___), עם 3 אפשרויות.
- תרגיל סידור אחד: 4 משפטים מהסיפור, בסדר הנכון.
- בשדה answer: מספר האפשרות הנכונה, כשהאפשרות הראשונה היא 0.

החזר את ה-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה:
{schema example from section 5, without nikud and without nikudMode}
```

- The length is given as paragraphs and sentences (about 8 words per sentence, 4 sentences per paragraph),
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
