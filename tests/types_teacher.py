"""The new question types on the teacher's side: Gemini schema, review prompt, checks, editor, preview,
nikud from Dicta, print sheet and answer page."""
import json, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8795
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "new-types-lesson.json")
lesson = json.load(open(FIXTURE, encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1300, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    def draft():
        page.wait_for_timeout(600)
        return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson")

    # ---------- Gemini schema ----------
    sch = page.evaluate("Gemini.LESSON_SCHEMA.properties.exercises.items.properties")
    check(sch["type"]["enum"] == ["mcq", "tf", "fill", "order", "open", "locate", "message"] and "sampleAnswer" in sch
          and set(sch["visible"]["properties"]) == {"question", "options", "answer", "sampleAnswer"} and sch["hidden"] == sch["visible"],
          "Gemini schema: the new types, sampleAnswer, and the message parts")
    # What Gemini returns (answers as strings) goes through the same checks
    gem = copy.deepcopy(lesson)
    gem["exercises"][10]["visible"]["answer"] = "1"
    gem["exercises"][10]["hidden"]["answer"] = "0"
    gem["exercises"][9]["answer"] = ""
    res = page.evaluate("(l) => { const c = Lesson.coerce(l).lesson; return [Lesson.check(c).errors, c.exercises[10].visible.answer]; }", gem)
    check(res[0] == [] and res[1] == 1, "a Gemini-style answer (answers as text) passes the checks")

    # ---------- Review prompt and nikud slots ----------
    prompt = page.evaluate("(l) => Review.buildReviewPrompt(Lesson.coerce(l).lesson)", lesson)
    texts = json.loads(prompt[prompt.rindex("{", 0, prompt.rindex('"story"')) : prompt.rindex("}") + 1])
    keys = set(texts)
    check({"exercises[8].question", "exercises[8].sampleAnswer", "exercises[9].question", "exercises[9].sentence",
           "exercises[10].visible.question", "exercises[10].visible.options[1]", "exercises[10].hidden.options[0]",
           "exercises[11].visible.sampleAnswer", "exercises[11].hidden.question"} <= keys,
          "review prompt: the new fields are sent for review")
    check(not page.evaluate("(p) => Hebrew.hasNikud(p)", prompt) and "שדה sentence של תרגיל איתור מידע" in prompt and "sampleAnswer" in prompt,
          "review prompt: no nikud; locate sentence must stay as in the story; sample answers checked")
    applied = page.evaluate("""(l) => { const c = Lesson.coerce(l).lesson;
      const ok = Review.applySuggestion(c, {field: 'exercises[11].hidden.sampleAnswer', original: 'בצל', fix: 'בצילו'});
      return [ok, Hebrew.stripNikud(c.exercises[11].hidden.sampleAnswer)]; }""", lesson)
    check(applied[0] and applied[1].startswith("בצילו"), "a suggestion on a message part's sample answer is applied (%s)" % applied[1])
    slot_n = page.evaluate("(l) => Review.slots(Lesson.coerce(l).lesson, true).length", lesson)
    old_n = page.evaluate("(l) => { const c = Lesson.coerce(l).lesson; c.exercises = c.exercises.slice(0, 8); return Review.slots(c, true).length; }", lesson)
    check(slot_n - old_n == 2 + 2 + (1 + 2 + 1 + 2) + (2 + 2), "every new text is a nikud slot too (%d new)" % (slot_n - old_n))

    # ---------- Dicta: a plain lesson with the new types gets nikud everywhere ----------
    plain = page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(lesson, ensure_ascii=False))
    plain_path = os.path.join(OUT, "new-types-plain.json")
    open(plain_path, "w", encoding="utf-8").write(plain)
    page.set_input_files("#loadJsonInput", plain_path)
    page.wait_for_selector("#step4:not([hidden])")
    page.click("#makeLink")
    vocalized = page.evaluate("(l) => Review.slots(Lesson.coerce(l).lesson, true).map(s => s.get().trim()).filter(Boolean).join('\\n')", lesson)
    page.fill("#dictaText", vocalized)
    page.click("#compareNikud")
    check("הוחל על" in page.text_content("#nikudMsgs"), "Dicta's text applied (%s)" % page.text_content("#nikudMsgs"))
    D = draft()
    want = page.evaluate("(l) => Lesson.coerce(l).lesson.exercises", lesson)
    check(D["exercises"][8:] == want[8:], "open, locate and message texts are vocalized from Dicta's text")
    check(page.evaluate("(l) => Lesson.unvocalizedWords(l).length", D) == 0, "no word left without nikud")

    # ---------- Editor ----------
    page.click("#steps li[data-step='1']")
    page.set_input_files("#loadJsonInput", FIXTURE)
    page.wait_for_selector("#step4:not([hidden])")
    items = page.locator("#editor .ex-item")
    check(items.count() == 12, "editor: every exercise (%d)" % items.count())
    open_box, loc_box, msg_box, msg2_box = items.nth(8), items.nth(9), items.nth(10), items.nth(11)
    check("שאלה פתוחה" in open_box.text_content() and open_box.locator("textarea").count() == 1, "editor: open question with a sample-answer box")
    opts = loc_box.locator("select option")
    check(opts.count() >= 12 and "בחירה מתוך הסיפור" in opts.first.text_content() and "המשפט נמצא בסיפור ✓" in loc_box.text_content(),
          "editor: locate with a sentence picker from the story and a 'found' status")
    loc_box.locator("select").select_option(index=2)
    D = draft()
    picked = page.evaluate("(s) => Lesson.sentencesOf(s)[1]", D["story"])
    check(D["exercises"][9]["sentence"] == picked, "editor: picking a sentence sets the answer (%s)" % picked)
    page.locator("#editor .ex-item").nth(9).locator("input[type=text]").nth(1).fill("דני טס לירח.")
    page.wait_for_timeout(400)
    check("לא נמצא בסיפור" in page.locator("#editor .ex-item").nth(9).text_content() and "לא נמצא בסיפור" in page.text_content("#checkMsgs")
          and page.is_disabled("#makeLink"), "editor: a sentence not in the story → flagged, error, no link")
    page.locator("#editor .ex-item").nth(9).locator("select").select_option(index=5)
    page.wait_for_timeout(400)
    check(not page.is_disabled("#makeLink") and draft()["exercises"][9]["sentence"] == page.evaluate("(s) => Lesson.sentencesOf(s)[4]", lesson["story"]),
          "picking from the story right after typing → that sentence, OK (a removed field does not undo it)")
    msg_box = page.locator("#editor .ex-item").nth(10)
    check(msg_box.locator(".part-edit").count() == 2 and msg_box.locator(".part-edit").nth(0).locator(".opt-row").count() == 2,
          "editor: message with two parts; the multiple-choice part has its options")
    msg_box.locator(".part-edit").nth(0).locator("label:has-text('פתוחה') input").check()
    D = draft()
    v = D["exercises"][10]["visible"]
    check("options" not in v and v.get("sampleAnswer") == "" and v["question"] == lesson["exercises"][10]["visible"]["question"],
          "editor: switching a part to open keeps the question, asks for a sample answer")
    check("חסרה תשובה לדוגמה" in page.text_content("#checkMsgs"), "…and the check asks for it")
    page.locator("#editor .ex-item").nth(10).locator(".part-edit").nth(0).locator("textarea").fill("בּוֹנִי.")
    page.wait_for_timeout(400)
    adds = page.eval_on_selector_all("#editor .row button", "els => els.map(e => e.textContent)")
    check(all(("+ " + n) in adds for n in ["שאלה פתוחה", "איתור מידע", "מסר גלוי וסמוי"]), "editor: '+' buttons for the new types")
    page.click("#editor .row button:has-text('+ מסר גלוי וסמוי')")
    D = draft()
    check(D["exercises"][-1]["type"] == "message" and "options" in D["exercises"][-1]["visible"], "a new message follows the level (סוף א׳–ב׳: multiple choice)")
    page.locator("#editor .ex-item").last.locator("button[title='מחיקת תרגיל']").click()

    # ---------- Preview ----------
    pv = page.text_content("#preview")
    check("תשובה לדוגמה:" in pv and "הילד לוחץ בסיפור על:" in pv and "גלוי:" in pv and "סמוי:" in pv, "preview: sample answers, the locate sentence, both message parts")
    page.screenshot(path=os.path.join(OUT, "types-editor.png"), full_page=True)

    # ---------- Print sheet and answers ----------
    sheet = page.evaluate("""(l) => { const s = Print.build(Lesson.coerce(l).lesson, {answers: true}); document.body.appendChild(s);
      const q = t => [...s.querySelectorAll('.p-q[data-type=' + t + ']')];
      const r = { open: q('open').map(e => [e.querySelectorAll('.p-wline').length, Hebrew.stripNikud(e.textContent)]),
                  locate: q('locate').map(e => Hebrew.stripNikud(e.textContent)),
                  message: q('message').map(e => [e.querySelectorAll('.p-part').length, e.querySelectorAll('.p-part .p-circle').length,
                                                  e.querySelectorAll('.p-part .p-wline').length, Hebrew.stripNikud(e.textContent)]),
                  answers: Hebrew.stripNikud(s.querySelector('.p-answers').textContent) };
      s.remove(); return r; }""", lesson)
    check(sheet["open"] and sheet["open"][0][0] == 3 and "כתבו תשובה במשפט שלם" in sheet["open"][0][1], "print: open question with writing lines")
    check(sheet["locate"] and "מתחו קו מתחת למשפט בסיפור" in sheet["locate"][0], "print: locate says to underline the sentence in the story")
    plain_instr = page.evaluate("""() => { const l = Lesson.coerce(JSON.parse(localStorage.getItem('readingApp.draft')).lesson).lesson;
      l.nikudMode = 'none'; const s = Print.build(l, {}); return [...s.querySelectorAll('.p-instr')].map(e => e.textContent).join(' '); }""")
    check("בסיפור" in plain_instr and "המילה" in plain_instr and "בספור" not in plain_instr and "המלה" not in plain_instr,
          "print instructions without nikud are spelled in ktiv male (בסיפור, המילה)")
    check(sheet["message"][0][:3] == [2, 4, 0] and "המסר הגלוי" in sheet["message"][0][3] and "המסר הסמוי" in sheet["message"][0][3]
          and sheet["message"][1][:3] == [2, 0, 4], "print: message parts (circles for multiple choice, lines for open)")
    a = sheet["answers"]
    check("תשובה לדוגמה: בצל של העץ" in a and "המשפט: דני זורק כדור אדם" in a and "גלוי: בוני" in a and "סמוי: כדור" in a,
          "answer page: sample answers, the locate sentence, the message answers")
    page.evaluate("(l) => { const s = Print.build(Lesson.coerce(l).lesson, {answers: true}); document.getElementById('printArea').replaceChildren(s); }", lesson)
    page.emulate_media(media="print")
    page.pdf(path=os.path.join(OUT, "types-print.pdf"), format="A4")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
