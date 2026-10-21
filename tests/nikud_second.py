"""Second opinion on Dicta's nikud from Gemini (automatic mode), against a mock API (Playwright routing: nothing
goes to the network). After Dicta: the same lines sent to Gemini (structured output, split into several calls for
a long text), word-by-word comparison, orange marks in the preview, the choice window (Dicta / Gemini / manual),
"הבאה" and "סמן הכול כבדוק", marks dropped on edited words, the failure message with "נסה שוב", nothing without a
key, and the new line of the review prompt."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
SITE = "https://mosheomri.github.io/reading-app/"
API = "https://generativelanguage.googleapis.com/"
KEY = "AIzaTEST-key-1234"

sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []
console = []
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}

def serve_file(route):
    path = unquote(urlparse(route.request.url).path)[len("/reading-app/"):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, path))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def sse(text):
    return "data: " + json.dumps({"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]},
                                 ensure_ascii=False) + "\r\n\r\n"

def kind_of(body):
    props = body["generationConfig"]["responseSchema"].get("properties", {})
    if body["generationConfig"]["responseSchema"]["type"] == "ARRAY": return "review"
    if "lines" in props: return "nikud"
    return "write" if "story" in props else "exercises"

class MockApi:
    """story / exercises / review: fixed answers. nikud: each line sent is answered from self.nikud_map
    (plain line → vocalized line), or from queue (an HTTP error) first. With hold, nikud requests wait for release()."""
    def __init__(self, story_json, exercises_json):
        self.answers = {"write": story_json, "exercises": exercises_json, "review": "[]"}
        self.nikud_map = {}
        self.queue = []
        self.log = []
        self.hold = False
        self.held = []

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS); return
        if req.method == "GET":
            route.fulfill(status=200, body='{"name": "models/x"}', headers=dict(CORS, **{"Content-Type": "application/json"})); return
        body = json.loads(req.post_data)
        kind = kind_of(body)
        prompt = body["contents"][0]["parts"][0]["text"]
        self.log.append({"kind": kind, "body": body, "prompt": prompt})
        if kind == "nikud" and self.hold:
            self.held.append(route); return
        self.answer(route, kind, prompt)

    def answer(self, route, kind, prompt):
        if kind == "nikud" and self.queue:
            status, err = self.queue.pop(0)
            route.fulfill(status=status, body=json.dumps({"error": err}), headers=dict(CORS, **{"Content-Type": "application/json"})); return
        if kind == "nikud":
            lines = json.loads(prompt.split("השורות:\n", 1)[1])
            text = json.dumps({"lines": [self.nikud_map.get(l, l) for l in lines]}, ensure_ascii=False)
        else:
            text = self.answers[kind]
        route.fulfill(status=200, body=sse(text), headers=dict(CORS, **{"Content-Type": "text/event-stream"}))

    def release(self):
        held, self.held = self.held, []
        for route in held:
            prompt = json.loads(route.request.post_data)["contents"][0]["parts"][0]["text"]
            self.answer(route, "nikud", prompt)

    def count(self, kind): return sum(1 for x in self.log if x["kind"] == kind)

def new_context(browser, mock):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    ctx.route(API + "**", mock.handle)
    ctx.on("page", lambda pg: (pg.on("pageerror", lambda e: errors.append(str(e))),
                                pg.on("console", lambda m: console.append(m.type + ": " + m.text))))
    return ctx

def open_teacher(ctx, key=KEY):
    page = ctx.new_page()
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    if key: page.evaluate("(k) => localStorage.setItem('readingApp.geminiKey', k)", key)
    page.reload()
    page.evaluate("Gemini.config.retryDelay = 200")
    return page

def fill_form(page, nikud="full"):
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", str(STORY_WORDS))
    page.check("input[name=wordsMode][value=number]")
    page.fill("#wordCount", str(len(sample["targetWords"])))
    page.check("input[name=nikud][value=%s]" % nikud)
    page.evaluate("""() => { const c = {mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 0, message: 0};
      for (const k in c) { const i = document.querySelector('[data-count="' + k + '"]'); i.value = c[k]; i.dispatchEvent(new Event('input')); } }""")

def stage_class(page, sid):
    return page.evaluate("(s) => (document.querySelector('#autoStages li[data-stage=\"' + s + '\"]') || {}).className", sid)

def lesson_from_draft(page):
    page.wait_for_timeout(600)
    return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")

def to_dicta_wait(page):
    """The automatic flow up to the nikud stage, which waits for the teacher (no bridge here)."""
    fill_form(page)
    page.click("#autoCreate")
    page.wait_for_function("() => { const li = document.querySelector('#autoStages li[data-stage=\"nikud\"]'); return li && li.className === 'wait'; }", timeout=15000)

def paste_dicta(page):
    page.fill("#dictaText", DICTA_TEXT)
    page.click("#compareNikud")

def marks(page):
    return page.eval_on_selector_all("#preview .nikud-check", "els => els.map(e => e.dataset.mark)")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")

    tmp = browser.new_page()
    tmp.route("**/*", lambda r: serve_file(r) if r.request.url.startswith(SITE) else r.abort())
    tmp.goto(SITE + "index.html")
    plain = json.loads(tmp.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    STORY_WORDS = tmp.evaluate("(s) => Hebrew.countWords(s)", plain["story"])
    # The lines Dicta gets, with Dicta's nikud (the sample lesson's): [plain, vocalized, key]
    LINES = tmp.evaluate("""(lesson) => { const out = [];
      Review.slots(lesson, true).forEach(s => s.get().split('\\n').forEach(line => {
        const p = Hebrew.stripNikud(line).trim();
        if (p && Review.words(line).length) out.push([p, Hebrew.normalize(line).trim(), s.key]); }));
      return out; }""", sample)
    # Unit checks of the comparison rules
    unit = tmp.evaluate("""() => {
      const R = Review;
      return {
        meteg: R.sameReading('קָטָן', 'קָ\\u05BDטָן'),
        holamVav: R.sameReading('קוֹל', 'קו\\u05BAל'),
        qamatsQatan: R.sameReading('כָּל', 'כ\\u05BC\\u05C7ל'),
        order: R.sameReading('שָׁ', 'ש\\u05B8\\u05C1'),
        differ: R.sameReading('יֵשׁ', 'יַשׁ'),
        chunks: R.nikudChunks([{text: 'א'.repeat(40)}, {text: 'ב'.repeat(40)}, {text: 'ג'.repeat(200)}, {text: 'ד'.repeat(10)}], 100).map(c => c.length)
      }; }""")
    check(unit["meteg"] and unit["holamVav"] and unit["qamatsQatan"] and unit["order"] and not unit["differ"],
          "normalization: meteg, holam for vav, qamats qatan and mark order ignored; a different vowel is a disagreement (%s)" % unit)
    check(unit["chunks"] == [2, 1, 1], "a long text is split into calls of up to N characters (a longer line on its own) (%s)" % unit["chunks"])
    # Only differences that change the reading are marked; every difference gets its kinds (for the report)
    reading = tmp.evaluate("""(pairs) => pairs.map(([a, b]) => Review.sameReading(a, b))""", [
        ["הַגִּנָּה", "הַגִנָה"],        # dagesh in ג / נ: not read
        ["כַּדּוּר", "כַּדוּר"],          # dagesh in ד
        ["אָכַל", "אַכַל"],              # qamats / patah: both a
        ["יֵלֵךְ", "יֶלֵךְ"],             # tsere / segol: both e
        ["לְדָנִי", "לֶדָנִי"],           # sheva / segol: e
        ["עֲנָנִים", "עַנָנִים"],         # hataf patah / patah
        ["לוֹ", "לֹו"],                  # holam on the vav or on the letter before
        ["שָׁלוֹם", "שָלוֹם"],           # no shin dot: fits shin
        ["בַּיִת", "בַיִת"],              # b / v: read differently
        ["כֶּלֶב", "כֶלֶב"],             # k / kh
        ["שָׂם", "שָׁם"],                # sin / shin
        ["יֵשׁ", "יִשׁ"],                # e / i
        ["אֲנִי", "אְנִי"],              # hataf patah / sheva: a / nothing
        ["סוּס", "סוֹס"],                # u / o
    ])
    check(reading[:8] == [True] * 8, "read the same: dagesh outside בכ״פ, qamats/patah, tsere/segol, sheva/e, hataf/its vowel, holam placement, no dot (%s)" % reading[:8])
    check(reading[8:] == [False] * 6, "read differently: dagesh in ב/כ, shin/sin, other vowels, hataf/sheva, shuruk/holam (%s)" % reading[8:])
    kinds = tmp.evaluate("""(pairs) => pairs.map(([a, b]) => Review.diffKinds(a, b))""", [
        ["הַגִּנָּה", "הַגִנָה"], ["בַּיִת", "בַיִת"], ["אָכַל", "אַכַל"], ["יֵלֵךְ", "יֶלֵךְ"], ["אֲנִי", "אְנִי"],
        ["כָּל", "כ\u05BC\u05C7ל"], ["לוֹ", "לֹו"], ["שָׂם", "שָׁם"], ["קָטָן", "קָ\u05BDטָן"], ["לְדָנִי", "לָדָנִי"]])
    check(kinds == [["דגש (באות אחרת)"], ["דגש בבכ״פ"], ["פתח / קמץ"], ["צירה / סגול"], ["שווא / חטף"], ["קמץ קטן"],
                    ["חולם / שורוק"], ["שי״ן / שׂי״ן"], ["מתג / טעמים"], ["שווא / תנועה"]],
          "kinds of difference for the report (%s)" % kinds)
    review_prompt = tmp.evaluate("(l) => Review.buildReviewPrompt(l)", plain)
    check("ארבעה קירות ביתם" in review_prompt and "לא הגיוני או מוזר" in review_prompt and "מסוג style" in review_prompt,
          "review prompt: checks sentences that make no sense or are odd, as a style suggestion with a reason")
    tmp.close()

    for ex in plain["exercises"]:
        if "answer" in ex: ex["answer"] = str(ex["answer"]).lower()
    STORY_JSON = json.dumps({k: plain[k] for k in ("title", "topic", "targetWords", "story")}, ensure_ascii=False)
    EX_JSON = json.dumps({"exercises": plain["exercises"]}, ensure_ascii=False)
    DICTA_TEXT = "\n".join(l[1] for l in LINES)

    # Gemini's nikud: Dicta's, except for four words of the first story line and the first question
    first_story = next(l for l in LINES if l[2] == "story")
    question = next(l for l in LINES if l[2] == "exercises[0].question")
    w = first_story[1].split(" ")
    w[1] = "יַשׁ"                     # יַשׁ instead of יֵשׁ: a different reading → marked
    w[3] = w[3][0] + "ֽ" + w[3][1:]         # a meteg only → not marked
    w[4] = w[4].replace("\u05B7", "\u05B8", 1)  # qamats for patah, read the same: listed, not marked
    w[6] = w[6][:-1] + "א" + w[6][-1]            # other letters (בּוֹנִיא) → not compared
    q = question[1].split(" ")
    q[0] = "אַיךְ"               # אַיךְ instead of אֵיךְ → marked
    GEMINI = {first_story[0]: " ".join(w), question[0]: " ".join(q)}

    # ---------- The second opinion runs after Dicta, in the background ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    mock.nikud_map = GEMINI
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    to_dicta_wait(page)
    check(mock.count("nikud") == 0, "no second opinion before Dicta")
    mock.hold = True
    paste_dicta(page)
    page.wait_for_timeout(300)
    check(mock.count("nikud") == 1, "after Dicta: one nikud-check call (a short lesson)")
    req = mock.log[-1]
    gc = req["body"]["generationConfig"]
    sent = json.loads(req["prompt"].split("השורות:\n", 1)[1])
    check(sent == [l[0] for l in LINES], "the lines sent are the ones Dicta got, without nikud, in the same order (%d lines)" % len(sent))
    check(gc["responseMimeType"] == "application/json" and gc["responseSchema"]["properties"]["lines"]["type"] == "ARRAY"
          and "אל תשנה אף אות, אף סימן פיסוק" in req["prompt"] and ("%d שורות בדיוק" % len(sent)) in req["prompt"],
          "structured output: an array of lines; the prompt asks for nikud only, no change to letters, punctuation or words")
    check("בדיקה כפולה של הניקוד" in page.text_content("#secondMsgs") and stage_class(page, "nikud") == "done",
          "while Gemini works: a status line, and the nikud stage is done (not blocked)")
    page.click("#toLink")
    check(page.is_visible("#step6"), "a link can be made while the second opinion runs")
    page.click("#steps li[data-step='4']")
    check("בדיקה כפולה של הניקוד" in page.text_content("#preview"), "the preview shows that the check is running")
    mock.release()
    page.wait_for_function("() => document.querySelectorAll('#preview .nikud-check').length > 0", timeout=10000)
    m = marks(page)
    check(sorted(m) == sorted(["story#1", "exercises[0].question#0"]),
          "two words marked: a different vowel; not the meteg-only word or the word with other letters (%s)" % m)
    check(page.locator("#preview .second-status button:has-text('פירוט כל ההבדלים')").count() == 1,
          "a button downloads the report of every difference")
    with page.expect_download() as dl:
        page.click("#preview .second-status button:has-text('פירוט כל ההבדלים')")
    rep_data = json.load(open(dl.value.path(), encoding="utf-8"))
    by_field = {(d["field"], d["index"]): d for d in rep_data["diffs"]}
    check(by_field.get(("story", 4), {}).get("kinds") == ["פתח / קמץ"] and by_field[("story", 4)]["marked"] is False
          and by_field.get(("story", 3), {}).get("kinds") == ["מתג / טעמים"] and by_field[("story", 1)]["marked"] is True
          and rep_data["summary"]["פתח / קמץ"]["count"] == 1 and rep_data["compared"] >= 4,
          "report: every difference with its kinds and whether it is marked, and a summary by kind")
    bar = page.text_content("#preview .second-status")
    check("2 מילים לבדיקה" in bar and page.locator("#preview .second-status button:has-text('הבאה')").count() == 1
          and page.locator("#preview .second-status button:has-text('סמן הכול כבדוק')").count() == 1,
          "above the story: '2 מילים לבדיקה' with 'הבאה' and 'סמן הכול כבדוק'")
    order = page.evaluate("""() => { const s = document.querySelector('#preview .second-status'), st = document.querySelector('#preview .story');
      return !!(s.compareDocumentPosition(st) & Node.DOCUMENT_POSITION_FOLLOWING); }""")
    check(order, "the bar is right above the story")
    deco = page.evaluate("getComputedStyle(document.querySelector('#preview .nikud-check')).textDecorationLine + ' ' + getComputedStyle(document.querySelector('#preview .nikud-check')).textDecorationColor")
    check("underline" in deco and "232, 89, 12" in deco, "marked words: orange underline (%s)" % deco)
    page.screenshot(path=os.path.join(OUT, "n1-marks.png"))

    # The choice window: Dicta's version is the default; pick Gemini's
    story_before = lesson_from_draft(page)["lesson"]["story"]
    page.click("#preview .story .nikud-check")
    dlg = page.locator("#nikudCheckDialog")
    check(dlg.is_visible() and "דיקטה" in dlg.text_content() and "Gemini" in dlg.text_content() and dlg.locator("input.nikud-input").count() == 1
          and dlg.locator(".pick.selected .pick-label").text_content() == "דיקטה",
          "click on a marked word: a window with Dicta's version (selected), Gemini's, and manual editing")
    page.screenshot(path=os.path.join(OUT, "n2-dialog.png"))
    dlg.locator("input.nikud-input").fill("ישנו")
    dlg.locator("button:has-text('שמירה')").click()
    check(dlg.is_visible() and "בלי לשנות אותיות" in dlg.text_content(), "manual edit with other letters: refused with a message")
    dlg.locator(".pick:has-text('Gemini')").click()
    check(page.locator("#nikudCheckDialog").count() == 0, "a choice closes the window")
    d = lesson_from_draft(page)
    check(d["lesson"]["story"] != story_before and "יַשׁ" in page.evaluate("(s) => s.normalize('NFC')", d["lesson"]["story"])
          and d["nikudVerified"] is not None, "Gemini's version replaces the word; the lesson stays Dicta-checked")
    check("מילה אחת לבדיקה" in page.text_content("#preview .second-status") and marks(page) == ["exercises[0].question#0"],
          "the chosen word is no longer marked: 'מילה אחת לבדיקה'")
    page.click("#steps li[data-step='6']")
    check(page.is_visible("#step6"), "after the choice a link can still be made")
    page.click("#steps li[data-step='4']")

    # "הבאה" opens the next marked word; manual nikud with the same letters is accepted
    page.click("#preview .second-status button:has-text('הבאה')")
    dlg = page.locator("#nikudCheckDialog")
    check(dlg.is_visible() and "תרגיל 1" in dlg.text_content(), "'הבאה' opens the next marked word (in the exercises)")
    dlg.locator("input.nikud-input").fill("אֵיךְ")
    dlg.locator("button:has-text('שמירה')").click()
    check(page.locator("#nikudCheckDialog").count() == 0 and "כל המילים נבדקו" in page.text_content("#preview .second-status"),
          "manual nikud saved; all words checked")
    ctx.close()

    # ---------- "סמן הכול כבדוק"; marks dropped on edited words; stored in the draft ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    mock.nikud_map = GEMINI
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    to_dicta_wait(page)
    paste_dicta(page)
    page.wait_for_function("() => document.querySelector('#secondMsgs').textContent.includes('2 מילים לבדיקה')", timeout=10000)
    check(page.locator("#secondMsgs button:has-text('לתצוגה המקדימה')").count() == 1, "step 5: the count with a button to the preview")
    page.click("#secondMsgs button:has-text('לתצוגה המקדימה')")
    check(page.is_visible("#step4") and len(marks(page)) == 2, "the button opens the preview with the marks")
    d = lesson_from_draft(page)
    check(d.get("second") and len(d["second"]["marks"]) == 2, "the marks are kept in the draft")
    page.reload()
    page.click("#resumeDraft")
    page.wait_for_timeout(300)
    check(page.is_visible("#step4") and len(marks(page)) == 2, "after a reload, back to the draft: the marks are still there")
    # Edit the story: the marked word changes → its mark goes; the question's mark stays
    page.evaluate("""() => { const ta = [...document.querySelectorAll('#step4 textarea')].find(t => t.value.length > 100);
      ta.value = ta.value.replace(/^(\\S+) (\\S+)/, '$1 יש'); ta.dispatchEvent(new Event('input')); }""")
    page.wait_for_timeout(500)
    check(marks(page) == ["exercises[0].question#0"] and "מילה אחת לבדיקה" in page.text_content("#preview .second-status"),
          "the edited word lost its mark, the others stay (%s)" % marks(page))
    page.click("#preview .second-status button:has-text('סמן הכול כבדוק')")
    check(marks(page) == [] and "כל המילים נבדקו" in page.text_content("#preview .second-status"), "'סמן הכול כבדוק': no marks left")
    ctx.close()

    # ---------- Failure: a small message with "נסה שוב"; the lesson goes on ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    mock.nikud_map = GEMINI
    mock.queue = [(500, {"code": 500, "message": "internal", "status": "INTERNAL"})] * 2
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    to_dicta_wait(page)
    paste_dicta(page)
    page.wait_for_function("() => document.querySelector('#secondMsgs').textContent.includes('הבדיקה הכפולה לא רצה')", timeout=15000)
    check(mock.count("nikud") == 2 and stage_class(page, "nikud") == "done" and "השיעור מוכן" in page.text_content("#autoFlowMsgs"),
          "Gemini failed (after one retry): 'הבדיקה הכפולה לא רצה', the lesson is ready as usual")
    page.click("#secondMsgs button:has-text('נסה שוב')")
    page.wait_for_function("() => document.querySelector('#secondMsgs').textContent.includes('2 מילים לבדיקה')", timeout=10000)
    check(mock.count("nikud") == 3, "'נסה שוב' runs the check again")
    ctx.close()

    # ---------- A long text: several calls; Gemini agrees: no marks ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    mock.nikud_map = {l[0]: l[1] for l in LINES}
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    page.evaluate("Gemini.config.nikudChunkChars = 120")
    to_dicta_wait(page)
    paste_dicta(page)
    page.wait_for_function("() => document.querySelector('#secondMsgs').textContent.includes('Gemini ניקד כמו דיקטה')", timeout=15000)
    sent = [json.loads(x["prompt"].split("השורות:\n", 1)[1]) for x in mock.log if x["kind"] == "nikud"]
    check(len(sent) > 2 and sum(sent, []) == [l[0] for l in LINES] and all(sum(len(t) for t in c) <= 120 or len(c) == 1 for c in sent),
          "long text: %d calls of up to 120 characters, all the lines once, in order" % len(sent))
    page.click("#steps li[data-step='4']")
    check(marks(page) == [] and "Gemini ניקד כמו דיקטה" in page.text_content("#preview"), "same nikud: no marks, a short note")
    ctx.close()

    # ---------- Partial nikud: only words the child sees with nikud are compared ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    mock.nikud_map = GEMINI
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    fill_form(page, nikud="partial")
    page.click("#autoCreate")
    page.wait_for_function("() => { const li = document.querySelector('#autoStages li[data-stage=\"nikud\"]'); return li && li.className === 'wait'; }", timeout=15000)
    paste_dicta(page)
    page.wait_for_function("() => /ניקד כמו דיקטה|לבדיקה/.test(document.querySelector('#secondMsgs').textContent)", timeout=10000)
    check("ניקד כמו דיקטה" in page.text_content("#secondMsgs"), "partial nikud: the marked words are not target words, so nothing to check")
    ctx.close()

    # ---------- No key (copy-paste): no change ----------
    mock = MockApi(STORY_JSON, EX_JSON)
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=None)
    fill_form(page)
    page.click("#makePrompt")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(plain, ensure_ascii=False))
    page.click("#parseBtn")
    page.click("#makeLink")
    paste_dicta(page)
    page.wait_for_timeout(500)
    check(mock.count("nikud") == 0 and page.text_content("#secondMsgs").strip() == "" and "הניקוד של דיקטה הוחל" in page.text_content("#nikudMsgs"),
          "without a key: Dicta as before, no Gemini call, no second-opinion line")
    ctx.close()

    check(not [c for c in console if KEY in c], "the key never appears in the console")
    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
