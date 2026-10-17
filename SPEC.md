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
- No analytics, no cookies, no tracking. `localStorage` only for teacher conveniences (e.g. last form values).

Suggested structure:
```
/index.html
/play.html
/css/style.css
/js/builder.js      teacher flow
/js/player.js       child flow
/js/games/*.js      one file per game
/js/exercises.js
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

### Step 5: Link
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
- `story`, `title`, words, questions and options are **always stored fully vocalized**. The display mode is applied at render time (section 7).
- `order.sentences` is stored in the correct order; the player shuffles.

### Validation (teacher page, before creating link)
- Valid JSON, all required fields, correct types, `answer` indices in range.
- Story word count within ±15% of the requested length (show the actual count; warning, not blocking).
- Every target word appears in the story at least once – compare after stripping nikud, and allow Hebrew prefixes (ו, ה, ב, כ, ל, מ, ש, and combinations like וה, שב).
- Number of target words matches the request (warning).

---

## 6. Prompt template (generated by the teacher page)

Written in Hebrew. Placeholders in `{}`.

```
אתה כותב תוכן ללימוד קריאה לילד בהוראה מותאמת.

כתוב סיפור קצר בעברית בנושא: {topic}
אורך הסיפור: בערך {length} מילים.
{IF words given} מילות היעד: {words}. כל מילת יעד חייבת להופיע בסיפור לפחות פעמיים.
{IF number given} בחר {n} מילות יעד פשוטות ומוחשיות שקשורות לנושא. כל מילה חייבת להופיע בסיפור לפחות פעמיים.

הנחיות לסיפור:
- משפטים קצרים ופשוטים, שפה של ילדים.
- כתוב את כל הטקסט בניקוד מלא ומדויק: הכותרת, הסיפור, המילים, השאלות והתשובות.
- לכל מילת יעד הוסף אימוג׳י אחד שמתאר אותה.

תרגילים:
- 3 שאלות הבנה אמריקאיות (3 אפשרויות כל אחת).
- 2 משפטי נכון/לא נכון.
- 2 משפטים להשלמת מילה חסרה (סמן את החסר ב-___), עם 3 אפשרויות.
- תרגיל סידור אחד: 4 משפטים מהסיפור, בסדר הנכון.

החזר JSON בלבד, בלי שום טקסט לפניו או אחריו, בדיוק במבנה הזה:
{schema example from section 5, with nikudMode set to "full"}
```

Keep the prompt template in one place (`js/builder.js` or a separate `js/prompt.js`) so it is easy to tune.

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

## 8. Out of scope for v1 (planned)

- Nikud verification layer: verified word dictionary (JSON) + deterministic comparison, coloring words green / red / gray; homographs flagged for review, not as errors.
- Optional integration with Dicta Nakdan for vocalization.
- Word-search game, printable worksheet, custom GPT / Gemini Gem for teachers.

---

## 9. Definition of done for v1

- Teacher can go form → prompt → paste → preview/edit → link, on phone and desktop.
- Child link opens and runs the full flow with no network calls except loading fonts.
- Works on GitHub Pages.
- A sample lesson file `samples/sample-lesson.json` and a README (Hebrew) explaining how a teacher uses the site.
