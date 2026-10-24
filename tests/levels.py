"""Reading levels: settings field, level-specific prompt lines and story shape, level stored in the lesson,
level check in the review prompt."""
import json, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8779
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
SAMPLE = os.path.join(ROOT, "samples", "sample-lesson.json")
sample = json.load(open(SAMPLE, encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

LABELS = {"k-1": "גן–תחילת א׳", "1-2": "סוף א׳–ב׳", "3-4": "ג׳–ד׳", "5-6": "ה׳–ו׳"}

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1300, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    def draft():
        page.wait_for_timeout(600)
        return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson")

    # ---------- levels.js ----------
    levels = page.evaluate("Levels.LIST.map(l => [l.id, l.label])")
    check([tuple(l[:2]) for l in levels] == list(LABELS.items()), "four levels with their labels: %s" % [l[1] for l in levels])
    check(page.evaluate("Levels.DEFAULT") == "1-2", "default סוף א׳–ב׳")
    check(page.evaluate("[Levels.valid('3-4'), Levels.valid('x'), Levels.valid(undefined)]") == ["3-4", "", ""], "Levels.valid")

    # ---------- Settings field ----------
    radios = page.locator("#levelChoices input[name=level]")
    check(radios.count() == 4 and page.text_content("#levelChoices").count("׳") >= 4, "settings: four level choices")
    check(page.locator("#levelChoices input:checked").get_attribute("value") == "1-2", "settings: default סוף א׳–ב׳")

    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "100")

    for lid, label in LABELS.items():
        page.click("#step2 [data-go='1']") if page.is_visible("#step2") else None
        page.check("input[name=level][value='%s']" % lid)
        page.click("button[type=submit]")
        prompt = page.text_content("#promptText")
        lv = page.evaluate("(id) => Levels.get(id)", lid)
        shape = page.evaluate("storyShape(100)")
        check("רמת קריאה: %s." % label in prompt and "- " + lv["sentence"] in prompt and all("- " + l in prompt for l in lv["language"] + lv["story"]),
              "prompt (%s): level name, sentence length, language and story lines" % label)
        check(all("  - " + l in prompt for l in lv["avoid"]), "prompt (%s): what not to write at this level" % label)
        check(lv["questions"] in prompt and "אורך: %s" % shape in prompt, "prompt (%s): question kinds and length: %s" % (label, shape))
    check(page.evaluate("Levels.LIST.every(l => l.language.length >= 3 && l.avoid.length >= 3 && l.story.length >= 1)"),
          "every level has language, story and avoid lines")
    check("שאלה אחת של הסקה" in page.evaluate("Levels.get('3-4').questions") and "שתי שאלות הסקה" in page.evaluate("Levels.get('5-6').questions"),
          "inference questions: one at ג׳–ד׳, two at ה׳–ו׳")

    # Remembered with the other settings
    page.click("#step2 [data-go='1']")
    page.check("input[name=level][value='3-4']")
    page.click("button[type=submit]")
    page.reload()
    check(page.locator("#levelChoices input:checked").get_attribute("value") == "3-4", "chosen level remembered after reload")

    # ---------- Level stored in the lesson ----------
    page.click("button[type=submit]")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(sample, ensure_ascii=False))
    page.click("#parseBtn")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    check(draft()["level"] == "3-4", "lesson.level taken from the settings")
    check(page.locator("input[name=edLevel]:checked").get_attribute("value") == "3-4", "editor shows the level")
    check(page.evaluate("(l) => Lesson.clean(l).level", draft()) == "3-4", "level kept in the saved lesson / link data")
    check(page.evaluate("(l) => Lesson.coerce(Object.assign({}, l, {level: 'x'})).lesson.level", sample) == "", "unknown level → empty")

    # ---------- Review prompt checks the level ----------
    page.click("#makeLink")
    page.click("#makeReviewPrompt")
    rp = page.text_content("#reviewPromptText")
    lv = page.evaluate("Levels.get('3-4')")
    check("רמת הקריאה של השיעור: ג׳–ד׳" in rp and lv["sentence"] in rp and all(l in rp for l in lv["language"]) and lv["questions"] in rp,
          "review prompt: level name and its criteria")
    check('"לא מתאים לרמה"' in rp and "style" in rp, "review prompt: level mismatches as style suggestions")
    # Change the level in the editor → the review prompt follows
    page.click("#step5 [data-go='4']")
    page.check("input[name=edLevel][value='k-1']")
    page.wait_for_timeout(300)
    page.click("#makeLink")
    page.click("#makeReviewPrompt")
    check("רמת הקריאה של השיעור: גן–תחילת א׳" in page.text_content("#reviewPromptText"), "review prompt follows the level changed in the editor")

    # A lesson file without a level (made before levels): no level check, general rule instead
    page.click("#step5 [data-go='4']")
    page.click("#steps li[data-step='1']")
    page.set_input_files("#loadJsonInput", SAMPLE)
    page.wait_for_selector("#step4:not([hidden])")
    check(draft()["level"] == "" and page.locator("input[name=edLevel]:checked").count() == 0, "old lesson file: no level")
    page.click("#makeLink")
    page.click("#makeReviewPrompt")
    rp = page.text_content("#reviewPromptText")
    check("רמת הקריאה של השיעור" not in rp and "שמור על שפה פשוטה וקצרה שמתאימה לילדים" in rp, "old lesson: review prompt without a level check")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
