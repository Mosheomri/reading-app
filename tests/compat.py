"""Old lessons and links keep working after the new question types, reading levels and question choice:
a link in the old format, an old draft, an old lesson file, an old settings entry, an unknown type,
and the same print sheet as before."""
import json, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8801
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

# The sample lesson's print shuffle, checked equal to the code before the new types (commit 99b7c0b).
OLD_PRINT_ORDER = [[2, 1, 0], [1, 0, 2], [1, 0, 2], [], [], [0, 2, 1], [0, 2, 1], [1, 3, 2, 0]]

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

# A lesson as the first versions stored it: no "level", only the four first exercise types.
old_lesson = {k: v for k, v in sample.items() if k != "level"}
old_lesson["version"] = 1

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/assets/audio/*", lambda r: r.fulfill(status=404, body=""))
    ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(str(e))))

    # ---------- A link in the old format (made by an old version: LZString of the JSON, no level) ----------
    page = ctx.new_page()
    page.goto(BASE + "play.html")
    h = page.evaluate("(l) => LZString.compressToEncodedURIComponent(JSON.stringify(l))", old_lesson)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    check("הַכֶּלֶב" in page.text_content("#stage h1"), "old link: start screen with the title")
    page.click("text=מתחילים ▶")
    seen = 0
    for _ in range(20):
        if page.locator(".stars").count(): break
        if "מתוך 8" in (page.text_content("#stage") or ""): seen += 1
        page.click("#navNext")
    check(seen == 8 and page.locator(".stars").count() == 1, "old link: all 8 questions, then the finish screen")
    check(page.text_content(".stars") == "⭐", "old link: skipped questions count as before (1 star)")
    page.close()

    # An exercise type this version does not know (a newer lesson) is left out, the rest plays
    future = copy.deepcopy(old_lesson)
    future["exercises"].insert(1, {"type": "crossword", "grid": []})
    page = ctx.new_page()
    page.goto(BASE + "play.html")
    h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", future)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    page.click("text=מתחילים ▶")
    for _ in range(6):
        if "שאלה 1 מתוך" in (page.text_content("#stage") or ""): break
        page.click("#navNext")
    check("שאלה 1 מתוך 8" in page.text_content("#stage"), "unknown exercise type: left out, 8 questions remain")
    page.close()

    # ---------- An old draft (no level, a request without question counts) resumes, still vocalized ----------
    page = ctx.new_page()
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    draft = page.evaluate("""(l) => { const c = Lesson.coerce(l).lesson; delete c.level;
      return { lesson: c, request: { topic: 'כלב בגינה', length: 55, wordsMode: 'number', wordCount: 4, words: [] },
               nikudVerified: Review.signature(c) }; }""", old_lesson)
    page.evaluate("(d) => localStorage.setItem('readingApp.draft', JSON.stringify(d))", draft)
    page.evaluate("""() => localStorage.setItem('readingApp.settings', JSON.stringify(
      { topic: 'כלב בגינה', length: 55, wordsMode: 'number', wordCount: 4, wordListText: '', nikud: 'full' }))""")
    page.reload()
    check(page.is_visible("#resumeDraft"), "old draft: offered to resume")
    check(page.input_value("[data-count=mcq]") == str(page.evaluate("Levels.exerciseDefaults(Levels.DEFAULT).mcq")),
          "old settings (no level, no question counts): the default level's counts")
    page.click("#resumeDraft")
    check(page.is_visible("#step4") and page.locator("#editor .ex-item").count() == 8, "old draft: editor with its 8 exercises")
    warn = page.text_content("#checkMsgs")
    names = page.evaluate("Object.values(Lesson.TYPE_NAMES)")
    check(not any((n + ": התבקשו") in warn for n in names), "old draft: no question-count warnings (its request has none)")
    page.click("#makeLink")
    check("הטקסט מנוקד" in page.text_content("#nikudMsgs"), "old draft: still counted as vocalized (same nikud signature)")
    page.click("#toLink")
    check(page.is_visible("#step6"), "old draft: link without redoing Dicta")
    link = page.text_content("#linkBox")
    check(page.evaluate("(h) => Lesson.decode(h.split('#')[1]).exercises.length", link) == 8, "its new link holds the same lesson")

    # ---------- An old lesson file loads; its print sheet is the same as before ----------
    old_path = os.path.join(OUT, "old-lesson.json")
    open(old_path, "w", encoding="utf-8").write(json.dumps(old_lesson, ensure_ascii=False))
    page.click("#steps li[data-step='1']")
    page.set_input_files("#loadJsonInput", old_path)
    page.wait_for_selector("#step4:not([hidden])")
    check("הכל תקין" in page.text_content("#checkMsgs") or "ייתכן כתיב חסר" in page.text_content("#checkMsgs"), "old lesson file: loads with no errors")
    order = page.evaluate("(l) => Print.layout(Lesson.coerce(l).lesson).map(i => i.order)", old_lesson)
    check(order == OLD_PRINT_ORDER, "old lesson: the print sheet shuffles exactly as before")
    check(page.evaluate("(l) => Lesson.coerce(l).lesson.exercises.every(Lesson.counts)", old_lesson), "old lesson: every question counts for the stars, as before")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
