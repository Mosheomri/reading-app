import json, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8771
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"

sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
ORDER = sample["exercises"][7]["sentences"]
fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

def draft(page):
    page.wait_for_timeout(600)
    return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1300, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    # ---------- 3. Length as paragraphs/sentences ----------
    shapes = page.evaluate("[20, 55, 100, 128, 200, 400].map(storyShape)")
    for n, s in zip([20, 55, 100, 128, 200, 400], shapes): print("   ", n, "→", s)
    check(shapes[3] == "4 פסקאות, בכל פסקה 4 משפטים קצרים, סך הכול בערך 128 מילים", "128 words → 4×4 + total")
    check(shapes[0] == "פסקה אחת, עם 3 משפטים קצרים, סך הכול בערך 20 מילים", "20 words → one paragraph + total")
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "128")
    page.click("button[type=submit]")
    prompt = page.text_content("#promptText")
    check("אורך הסיפור: 4 פסקאות, בכל פסקה 4 משפטים קצרים, סך הכול בערך 128 מילים." in prompt, "prompt uses paragraph/sentence shape + total words")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(sample, ensure_ascii=False))
    page.click("#parseBtn")
    check("אורך הסיפור 55 מילים (התבקשו בערך 128)" in page.text_content("#parseMsgs"), "word-count warning kept")

    # ---------- 1. Order exercise sorted by story position ----------
    lesson = copy.deepcopy(sample)
    stray = "הַחָתוּל יָשַׁן עַל הַגָּג."
    lesson["exercises"][7]["sentences"] = ["3. " + ORDER[3], ORDER[1], stray, ORDER[0], ORDER[2].replace("בּוֹנִי", "בוֹנִי")]
    page.fill("#response", "```json\n" + json.dumps(lesson, ensure_ascii=False) + "\n```")
    page.click("#parseBtn")
    msgs = page.text_content("#parseMsgs")
    check("סדר המשפטים תוקן לפי הסדר בסיפור" in msgs, "order fix note shown")
    check('המשפט "' + stray + '" לא נמצא בסיפור' in msgs, "missing sentence warning shown")
    check(stray in page.text_content("#fixText") and "סדר המשפטים תוקן" not in page.text_content("#fixText"),
          "fix message has the missing sentence, not the auto-fix")
    page.click("#continueAnyway")
    got = draft(page)["exercises"][7]["sentences"]
    want = [ORDER[0], ORDER[1], stray, ORDER[2].replace("בּוֹנִי", "בוֹנִי"), ORDER[3]]
    check(got == want, "sorted by story position, unfound kept in slot, numbering stripped")
    check(stray in page.text_content("#checkMsgs"), "missing-sentence warning stays live in editor")

    # Already in order → no note
    page.click("#step4 [data-go='3']")
    page.fill("#response", json.dumps(sample, ensure_ascii=False).replace('"order"', '"order"'))
    page.click("#parseBtn")
    check("סדר המשפטים" not in (page.text_content("#parseMsgs") or ""), "no note when already in order")

    # ---------- 2. Unvocalized words in full mode ----------
    lesson = copy.deepcopy(sample)
    lesson["story"] = lesson["story"].replace("לְדָנִי יֵשׁ כֶּלֶב קָטָן.", "לדני יש כֶּלֶב קטן.")
    lesson["exercises"][0]["question"] = "איך קוֹרְאִים לַכֶּלֶב?"
    lesson["targetWords"][3]["word"] = "עץ"
    page.goto(BASE + "index.html")
    page.click("#loadJsonBtn") if False else None
    page.evaluate("localStorage.removeItem('readingApp.draft')")
    page.fill("#topic", "כלב בגינה"); page.fill("#length", "55")
    page.check("input[name=nikud][value=full]")
    page.click("button[type=submit]")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(lesson, ensure_ascii=False))
    page.click("#parseBtn")
    msgs = page.text_content("#parseMsgs")
    check("מילים בלי ניקוד" in msgs and all(w in msgs for w in ["לדני", "יש", "קטן", "איך", "עץ"]), "unvocalized warning lists words")
    check("לדני" in page.text_content("#fixText"), "unvocalized words in fix message")
    page.click("#continueAnyway")
    marked = page.eval_on_selector_all("#preview .no-nikud", "els => els.map(e => e.textContent)")
    print("    marked:", marked)
    check(set(["לדני", "יש", "קטן", "איך", "עץ"]) <= set(marked), "preview marks story, question, chips")
    check(page.evaluate("getComputedStyle(document.querySelector('#preview .story .no-nikud')).backgroundColor") != "rgba(0, 0, 0, 0)", "marked words are colored")
    page.screenshot(path=os.path.join(OUT, "v3-nikud.png"))
    # Switch to partial → no warning, no marks
    page.check("input[name=edNikud][value=partial]")
    page.wait_for_timeout(400)
    check(page.locator("#preview .no-nikud").count() == 0 and "בלי ניקוד" not in page.text_content("#checkMsgs"),
          "partial mode: no nikud warning or marks")
    page.check("input[name=edNikud][value=full]")
    page.wait_for_timeout(400)
    # Fix one word in the editor → it disappears from the warning
    story = page.locator("#editor textarea")
    story.fill(story.input_value().replace("לדני יש כֶּלֶב קטן.", "לְדָנִי יֵשׁ כֶּלֶב קָטָן."))
    page.wait_for_timeout(400)
    msgs = page.text_content("#checkMsgs")
    check("לדני" not in msgs and "איך" in msgs, "warning updates live after editing")

    # Child page never shows marks
    page.click("#makeLink"); page.click("#toLink")
    child = browser.new_page()
    child.goto(page.text_content("#linkBox"))
    child.click("text=מתחילים ▶")
    check(child.locator(".no-nikud").count() == 0, "no marks on child page")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
