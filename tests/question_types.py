"""New exercise types: open question, locate (find the sentence in the story), visible / hidden message.
The lesson model (coerce, checks), the child page, the stars, and old lessons and links."""
import json, sys, threading, functools, http.server, os, re, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8789
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
lesson = json.load(open(os.path.join(ROOT, "tests", "fixtures", "new-types-lesson.json"), encoding="utf-8"))
EXS = lesson["exercises"]

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

def shown(page, s): return page.evaluate("(o) => Render.text(Lesson.decode(location.hash), o)", s)

def pick(page, options, answer, right=True, scope=""):
    correct = shown(page, options[answer])
    labels = page.eval_on_selector_all(scope + " .option", "els => els.map(e => e.textContent)")
    target = correct if right else [b for b in labels if b != correct][0]
    page.locator(scope + " .option").filter(has_text=target).first.click()

def answer(page, ex, right=True):
    t = ex["type"]
    if t in ("mcq", "fill"): pick(page, ex["options"], ex["answer"], right)
    elif t == "tf": page.click(".option >> text=" + ("👍 נכון" if ex["answer"] == right else "👎 לא נכון"))
    elif t == "order":
        for s in ex["sentences"]:
            page.locator(".order-list:not(.answer) .order-item").filter(has_text=shown(page, s)).first.click()
    elif t == "open": page.click("button:has-text('סיימתי')")
    elif t == "locate":
        page.locator(".locate-story .sent").filter(has_text=shown(page, ex["sentence"])).first.click()
    elif t == "message":
        for key in ("visible", "hidden"):
            part = ex[key]
            scope = ".message-part[data-part=%s]" % key
            if "options" in part: pick(page, part["options"], part["answer"], right, scope)
            else: page.click(scope + " button:has-text('סיימתי')")

def qno(page):
    m = re.search(r"שאלה (\d+) מתוך", page.text_content("#stage") or "")
    return int(m.group(1)) if m else 0

def go_q(page, k):
    for _ in range(40):
        q = qno(page)
        if q == k: return
        if page.locator(".stars").count() or (q and q > k): page.click("#navPrev")
        else: page.click("#navNext")

def open_child(ctx, data):
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "play.html")
    h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", data)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    page.click("text=מתחילים ▶")
    return page

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.route("**/assets/audio/*", lambda r: r.fulfill(status=404, body=""))

    # ---------- Lesson model ----------
    page = ctx.new_page()
    page.goto(BASE + "index.html")
    co = lambda raw: page.evaluate("(r) => Lesson.coerce(r).lesson", raw)
    chk = lambda raw: page.evaluate("(r) => Lesson.check(Lesson.coerce(r).lesson)", raw)
    c = co(lesson)
    check([e["type"] for e in c["exercises"]][-4:] == ["open", "locate", "message", "message"] and not any(e.get("unknown") for e in c["exercises"]),
          "coerce keeps open, locate and message")
    check(c["exercises"][10]["visible"]["answer"] == 1 and c["exercises"][11]["visible"].get("options") is None
          and c["exercises"][11]["hidden"]["sampleAnswer"], "message parts: with options = multiple choice, without = open with a sample answer")
    res = chk(lesson)
    check(res["errors"] == [], "the test lesson passes the checks (%s)" % res["errors"][:2])
    def variant(f):
        L = copy.deepcopy(lesson); f(L); return chk(L)["errors"]
    e1 = variant(lambda L: L["exercises"][9].update(sentence="דני טס לירח."))
    check(any("לא נמצא בסיפור" in e for e in e1), "locate: answer sentence not in the story → error (%s)" % e1[:1])
    e2 = variant(lambda L: L["exercises"][9].update(sentence=page.evaluate("(s) => Hebrew.stripNikud(s)", L["exercises"][9]["sentence"])))
    check(e2 == [], "locate: the sentence is matched without nikud")
    e3 = variant(lambda L: L["exercises"][8].update(sampleAnswer=""))
    check(any("חסרה תשובה לדוגמה" in e for e in e3), "open: a sample answer is required")
    e4 = variant(lambda L: L["exercises"][10]["hidden"].update(answer=7))
    check(any("המסר הסמוי" in e and "answer" in e for e in e4), "message: a multiple-choice part needs a valid answer (%s)" % e4[:1])
    e5 = variant(lambda L: L["exercises"][11]["visible"].update(question=""))
    check(any("המסר הגלוי: חסרה שאלה" in e for e in e5), "message: each part needs a question")
    alias = co({"story": "א.", "targetWords": [], "exercises": [
        {"type": "open-ended", "question": "ש", "answer": "ת"},
        {"type": "find sentence", "question": "ש", "answer": "א."},
        {"type": "Message", "explicit": {"question": "ש", "answer": "ת"}, "implicit": {"question": "ש", "options": ["א", "ב"], "answer": "ב"}}]})
    check([e["type"] for e in alias["exercises"]] == ["open", "locate", "message"] and alias["exercises"][0]["sampleAnswer"] == "ת"
          and alias["exercises"][1]["sentence"] == "א." and alias["exercises"][2]["hidden"]["answer"] == 1,
          "aliases an AI may write (open-ended, find sentence, explicit/implicit, answer as text)")
    check(page.evaluate("(l) => Lesson.coerce(l).lesson.exercises.map(Lesson.counts)", lesson)[-4:] == [False, True, True, False],
          "stars count locate and a multiple-choice message, not open questions")
    # Old lessons: unchanged
    old = co(sample)
    check(old["exercises"] == co(json.loads(json.dumps(sample)))["exercises"] and chk(sample)["errors"] == [], "an old lesson coerces and checks as before")
    page.close()

    # ---------- Child page ----------
    page = open_child(ctx, lesson)
    total = len(EXS)
    # Open question
    go_q(page, 9)
    check(page.is_visible("textarea.open-answer") and page.is_hidden(".sample-answer"), "open: a box to write in, the sample answer hidden")
    page.fill("textarea.open-answer", "בצל של העץ")
    page.click("button:has-text('סיימתי')")
    check(page.is_visible(".sample-answer") and shown(page, EXS[8]["sampleAnswer"]) in page.text_content(".sample-answer")
          and page.get_attribute("textarea.open-answer", "readonly") is not None, "open: 'סיימתי' shows the sample answer")
    check(page.text_content(".feedback") != "", "open: praise after 'סיימתי'")
    page.wait_for_timeout(2400)
    check(qno(page) == 10, "open: moves on by itself")
    # Locate
    n_sent = page.locator(".locate-story .sent").count()
    check(n_sent >= 10, "locate: the story with every sentence clickable (%d sentences)" % n_sent)
    page.locator(".locate-story .sent").first.click()
    fb = page.text_content(".feedback")
    check(page.locator(".locate-story .sent.tried").count() == 1 and "חפשו משפט אחר" in fb and "נסו" in fb, "locate: a wrong sentence → gentle hint (%s)" % fb)
    page.wait_for_timeout(2300)
    check(qno(page) == 10, "locate: wrong sentence, no move")
    answer(page, EXS[9])
    right = page.locator(".locate-story .sent.right")
    check(right.count() == 1 and shown(page, EXS[9]["sentence"]) in right.first.text_content(), "locate: the right sentence turns green")
    vw = page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
    check(vw[0] <= vw[1], "locate: no horizontal scroll on a phone")
    page.screenshot(path=os.path.join(OUT, "types-locate.png"), full_page=True)
    page.wait_for_timeout(2400)
    check(qno(page) == 11, "locate: moves on after the right sentence")
    # Message, multiple choice
    check(page.locator(".message-part").count() == 1 and "המסר הגלוי" in page.text_content(".message-part"), "message: the visible part first")
    pick(page, EXS[10]["visible"]["options"], EXS[10]["visible"]["answer"], True, ".message-part[data-part=visible]")
    check(page.locator(".message-part").count() == 2 and "המסר הסמוי" in page.text_content(".message-part[data-part=hidden]"), "message: then the hidden part")
    page.wait_for_timeout(2300)
    check(qno(page) == 11, "message: no move after the first part")
    pick(page, EXS[10]["hidden"]["options"], EXS[10]["hidden"]["answer"], False, ".message-part[data-part=hidden]")
    pick(page, EXS[10]["hidden"]["options"], EXS[10]["hidden"]["answer"], True, ".message-part[data-part=hidden]")
    page.wait_for_timeout(2400)
    check(qno(page) == 12, "message: moves on after both parts")
    # Message, open parts
    page.click(".message-part[data-part=visible] button:has-text('סיימתי')")
    check(page.locator(".message-part").count() == 2 and page.is_visible(".message-part[data-part=visible] .sample-answer"), "open-style message: sample answer, then the hidden part")
    page.click(".message-part[data-part=hidden] button:has-text('סיימתי')")
    page.screenshot(path=os.path.join(OUT, "types-message.png"), full_page=True)
    page.wait_for_timeout(2400)
    check(page.locator(".stars").count() == 1, "open-style message: on to the finish screen")
    # Back to the open question: what was written is still there
    go_q(page, 9)
    check(page.input_value("textarea.open-answer") == "בצל של העץ" and page.is_visible(".sample-answer") and page.is_hidden("button:has-text('סיימתי')"),
          "open question seen again: the child's text and the sample answer")
    go_q(page, 10)
    check(page.locator(".locate-story .sent.right").count() == 1, "locate seen again: shown solved")
    page.close()

    # Stars: everything right on the first try except the hidden message part (one wrong try) → 9/10 = 3 stars;
    # open questions skipped do not lower it.
    page = open_child(ctx, lesson)
    for k in range(1, total + 1):
        go_q(page, k)
        ex = EXS[k - 1]
        if ex["type"] == "open" or (ex["type"] == "message" and "options" not in ex["visible"]): continue
        answer(page, ex, right=True)
        page.click("#navNext")
    for _ in range(5):
        if page.locator(".stars").count(): break
        page.click("#navNext")
    check(page.text_content(".stars") == "⭐⭐⭐", "stars: open questions skipped do not count against the child (%s)" % page.text_content(".stars"))
    check("ענית על %d שאלות" % total in page.text_content("#stage"), "summary counts every question (%d)" % total)
    page.close()

    # Old lesson link still plays
    page = open_child(ctx, sample)
    go_q(page, 1)
    check(qno(page) == 1 and page.locator(".option").count() == 3, "an old lesson (four types only) still plays")
    page.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
