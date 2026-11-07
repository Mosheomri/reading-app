"""Text-quality rules, second round: the character solves the problem herself, one meaning per target word, no
clichés or professional terms, no abbreviations, exercise sentences copied word for word (in the copy-paste prompt
and in every prompt of the automatic flow); the code checks (a fill sentence not in the story, abbreviations); the
model tip in step 2; the question-type buttons on one line, all the same size."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

def serve_file(route):
    path = unquote(urlparse(route.request.url).path)[len("/reading-app/"):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, path))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def new_page(browser, width=1300):
    ctx = browser.new_context(viewport={"width": width, "height": 900})
    ctx.route("**/*", lambda r: serve_file(r) if r.request.url.startswith(SITE) else r.abort())
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()
    return ctx, page

SOLVE = "- הדמות פותרת את הבעיה בעצמה, במעשה או ברעיון שלה, ולא מבוגר שפותר בשבילה או מזל."
ONE = '- כל מילת יעד במשמעות אחת בלבד לאורך כל הטקסט (למשל "שער" רק כשער בכדורגל, לא גם כשער כניסה).'
CLICHE = '- בלי קלישאות וביטויים שחוקים (כמו "מחריש אוזניים", "אווירה של חג באוויר").'
TERMS = '- בלי מונחים מקצועיים (כמו "חלוץ", "מחצית", "גול").'
ABBR = '- בלי קיצורים: כתוב מילים מלאות (אחר הצהריים, לא אחה"צ).'
FILL = "משפט מהסיפור, מילה במילה, שבו מילה אחת הוחלפה ב-___."
ORDER = "כל משפט מועתק מהסיפור מילה במילה, ולא סיכום."

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx, page = new_page(browser)
    plain = json.loads(page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))

    # ---------- 1. The prompts ----------
    pr = page.evaluate("""() => {
      const s = {topic: 'משחק כדורגל', length: 200, level: '3-4', genre: 'story', wordsMode: 'number', wordCount: 4, words: [],
                 exercises: {mcq: 1, tf: 0, fill: 1, order: 1, open: 0, locate: 0, message: 0}};
      const plan = {title: 't', idea: 'i', targetWords: [{word: 'כדור', emoji: '⚽'}], scenes: [{what: 'w', feeling: 'f', words: [], length: 50}]};
      const story = {title: 't', targetWords: [{word: 'כדור'}], story: 'סיפור.'};
      return {paste: buildPrompt(s), ideas: buildIdeasPrompt(s, []), plan: buildPlanPrompt(s, {own: 'רעיון'}), write: buildStoryPrompt(s, plan),
              edit: buildEditPrompt(s, story), exercises: buildExercisesPrompt(s, story),
              info: buildPrompt(Object.assign({}, s, {genre: 'info'}))};
    }""")
    want = {
        "paste": [SOLVE, ONE, CLICHE, TERMS, ABBR, FILL, ORDER],
        "ideas": [SOLVE, ABBR],
        "plan": [SOLVE, ONE, ABBR],
        "write": [ONE, CLICHE, TERMS, ABBR],
        "edit": [CLICHE, TERMS, ABBR],
        "exercises": [FILL, ORDER, ABBR],
    }
    for name, lines in want.items():
        missing = [l[:30] for l in lines if l not in pr[name]]
        check(not missing, "%s prompt: the new rules (missing: %s)" % (name, missing))
    check(SOLVE not in pr["write"], "writing prompt: the story's structure stays in the plan")
    check("וכו׳" not in pr["paste"] and 'אחה"צ' not in pr["paste"].replace(ABBR, ""), "the prompt itself has no abbreviations")
    check(SOLVE not in pr["info"] and "מילה במילה, שבו מילה אחת הוחלפה ב-___" in pr["info"] and "משפט מהטקסט" in pr["info"],
          "informational text: no story structure line; the exercise lines speak of the text")

    # ---------- 2. Code checks ----------
    fill_i = next(i for i, e in enumerate(plain["exercises"]) if e["type"] == "fill")
    lesson = dict(plain, genre="story")
    ok = page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null).warnings", lesson)
    check(not any("לא נמצא בסיפור" in w for w in ok), "fill sentence copied from the story: no warning")
    bad = json.loads(json.dumps(lesson, ensure_ascii=False))
    bad["exercises"][fill_i]["sentence"] = "הילד ראה ___ גדול מאוד בשמיים."
    w = page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null).warnings", bad)
    answer = bad["exercises"][fill_i]["options"][bad["exercises"][fill_i]["answer"]]
    check(any(('המשפט "הילד ראה %s גדול מאוד בשמיים." לא נמצא בסיפור' % answer) in x for x in w),
          "fill sentence not in the story (with the right word back in): a warning, like order (%s)" % w)
    voc = json.loads(json.dumps(sample, ensure_ascii=False))
    check(not any("לא נמצא בסיפור" in x for x in page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null).warnings", voc)),
          "fill check compares without nikud and punctuation (the vocalized sample)")

    abbr = page.evaluate("""() => [
      Lesson.abbreviations('אחרי בית הספר, אחה"צ, הלכנו לביה\\u05F4ס.'),
      Lesson.abbreviations('הם נפגשו אחהצ וגם ואחהצ, ראו כנל.'),
      Lesson.abbreviations('הוא אמר: "שלום" וצחק. "כן," היא ענתה.'),
      Lesson.abbreviations('אַחֲהַ"צ')]""")
    check(abbr[0] == ['אחה"צ', 'לביה״ס'], "abbreviation: a gershayim inside a word (\" or ״) (%s)" % abbr[0])
    check(abbr[1] == ["אחהצ", "ואחהצ", "כנל"], "abbreviation: known ones written without the gershayim, also with a prefix (%s)" % abbr[1])
    check(abbr[2] == [], "quotation marks of dialogue are not abbreviations")
    check(abbr[3] == ['אחה"צ'], "abbreviation found also with nikud")
    ab = json.loads(json.dumps(lesson, ensure_ascii=False))
    ab["story"] = ab["story"] + " אחה\"צ הם חזרו."
    ab["exercises"][0]["question"] = "מה קרה בביה\"ס?"
    w = page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null).warnings", ab)
    check('קיצור: כדאי לכתוב מילה מלאה (אחה"צ, בביה"ס).' in w, "lesson check: one warning listing the abbreviations in the story and exercises (%s)" % w[-2:])
    check(not any(x.startswith("קיצור") for x in ok), "no abbreviations: no warning")

    # ---------- 3. Step 2: the model tip ----------
    page.fill("#topic", "כלב")
    page.click("#makePrompt")
    tip = page.text_content("#modelTip").strip()
    tip_y = page.evaluate("document.getElementById('modelTip').getBoundingClientRect().top")
    copy_y = page.evaluate("document.getElementById('copyPrompt').getBoundingClientRect().bottom")
    check(page.is_visible("#modelTip") and tip == "לתוצאה הטובה ביותר, בחרו בצ׳אט את המודל החזק ביותר שיש לכם (למשל Pro ב-Gemini), ולא מצב מהיר או בחירה אוטומטית."
          and tip_y >= copy_y and page.locator("#modelTip strong").count() == 1, "step 2: the model tip, bold, under the copy button")
    ctx.close()

    # ---------- 4. Question types: one line each, all the same size ----------
    for width in (1300, 900, 390):
        ctx, page = new_page(browser, width)
        m = page.eval_on_selector_all("#exTypes .ex-type", """els => els.map(e => {
          const l = e.querySelector('.choice'), r = l.getBoundingClientRect(), n = e.querySelector('input[type=number]').getBoundingClientRect();
          return {h: Math.round(r.height), w: Math.round(r.width), over: l.scrollWidth > l.clientWidth + 1, ny: Math.round(n.top), ly: Math.round(r.top),
                  page: document.documentElement.scrollWidth > window.innerWidth}; })""")
        check(len(m) == 7 and len({x["h"] for x in m}) == 1 and len({x["w"] for x in m}) == 1 and not any(x["over"] for x in m)
              and all(abs(x["ny"] - x["ly"]) < 12 for x in m) and m[0]["h"] < 60 and not m[0]["page"],
              "width %d: all 7 type buttons on one line, the same size, no horizontal scroll (%s)" % (width, [(x["w"], x["h"]) for x in m]))
        if width == 1300: page.locator("#exTypes").screenshot(path=os.path.join(ROOT, "tests", "out", "ex-types.png"))
        ctx.close()

    check(not errors, "no page errors (%s)" % errors[:3])
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
