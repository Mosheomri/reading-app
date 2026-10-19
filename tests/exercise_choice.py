"""Choosing question types in the settings form: a row per type with a count, defaults per reading level
(js/levels.js), validation, the prompt built from the choice, and the count check on the AI's answer."""
import json, sys, threading, functools, http.server, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8793
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []
TYPES = ["mcq", "tf", "fill", "order", "open", "locate", "message"]
LABELS = ["אמריקאית", "נכון / לא נכון", "השלמה", "סידור", "פתוחה", "איתור מידע", "מסר גלוי וסמוי"]

def counts(page):
    return {t: int(page.input_value('[data-count="%s"]' % t)) for t in TYPES}

def set_counts(page, c):
    for t in TYPES:
        page.fill('[data-count="%s"]' % t, str(c.get(t, 0)))

def schema_types(prompt):
    block = prompt[prompt.index("{"):]
    return [e["type"] for e in json.loads(block)["exercises"]]

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1300, "height": 1000})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    # ---------- The field ----------
    rows = page.eval_on_selector_all("#exTypes .ex-type", "els => els.map(e => [e.dataset.type, e.querySelector('label').textContent.trim()])")
    check([r[0] for r in rows] == TYPES and [r[1] for r in rows] == LABELS, "a row per question type, in order: %s" % [r[1] for r in rows])
    defaults = page.evaluate("Object.fromEntries(Levels.LIST.map(l => [l.id, [l.exercises, l.messageStyle]]))")
    check(all(set(d[0]) == set(TYPES) for d in defaults.values()) and [defaults[k][1] for k in ["k-1", "1-2", "3-4", "5-6"]] == ["mcq", "mcq", "open", "open"],
          "levels.js: default counts for every type; message parts multiple choice up to ב׳, open from ג׳")
    check(counts(page) == defaults["1-2"][0], "form starts with the default level's counts: %s" % counts(page))
    check(all(page.is_checked('input[data-type="%s"]' % t) == (defaults["1-2"][0][t] > 0) for t in TYPES), "checkbox on for every type with a count")
    page.check("input[name=level][value='5-6']")
    check(counts(page) == defaults["5-6"][0], "another level brings its defaults (%s)" % counts(page))
    page.uncheck('input[data-type="open"]')
    check(counts(page)["open"] == 0, "unchecking a type sets 0")
    page.check('input[data-type="tf"]')
    page.fill('[data-count="tf"]', "0")
    check(not page.is_checked('input[data-type="tf"]'), "count 0 unchecks the type")
    page.check('input[data-type="tf"]')
    check(counts(page)["tf"] == defaults["5-6"][0]["tf"], "checking a type again gives the level's count")
    page.click("#exDefaults")
    check(counts(page) == defaults["5-6"][0], "'חזרה לברירת המחדל' restores the level's counts")

    # ---------- Validation ----------
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "60")
    set_counts(page, {})
    page.click("#makePrompt")
    check("בחרו לפחות סוג שאלות אחד" in page.text_content("#settingsMsgs"), "no type chosen → error")
    set_counts(page, {"mcq": 6})
    page.click("#makePrompt")
    check("בין 0 ל-5" in page.text_content("#settingsMsgs") and "אמריקאית" in page.text_content("#settingsMsgs"), "more than 5 of a type → error")

    # ---------- The prompt follows the choice ----------
    page.check("input[name=level][value='1-2']")
    set_counts(page, {"mcq": 2, "open": 2, "locate": 1, "message": 1})
    page.click("#makePrompt")
    prompt = page.text_content("#promptText")
    lines = [l for l in prompt.split("\n") if l.startswith("- ") and ("שאל" in l or "תרגיל" in l or "משפט" in l)]
    check("- 2 שאלות הבנה אמריקאיות (3 אפשרויות כל אחת)." in prompt and "- 2 שאלות פתוחות:" in prompt and "sampleAnswer" in prompt
          and "- שאלת איתור מידע אחת:" in prompt and "מילה במילה" in prompt, "prompt: the chosen types with their counts")
    check("נכון/לא נכון" not in prompt and "להשלמת מילה" not in prompt and "תרגיל סידור" not in prompt, "prompt: types not chosen are left out")
    check("מסר גלוי ומסר סמוי" in prompt and "כל חלק הוא שאלה אמריקאית" in prompt, "prompt (סוף א׳–ב׳): message parts as multiple choice")
    check(schema_types(prompt) == ["mcq", "open", "locate", "message"], "schema example shows only the chosen types (%s)" % schema_types(prompt))
    ex = json.loads(prompt[prompt.index("{"):])["exercises"]
    check("options" in ex[3]["visible"] and "options" in ex[3]["hidden"], "schema example: message parts with options")
    check(not page.evaluate("(p) => Hebrew.hasNikud(p)", prompt), "prompt still has no nikud")
    page.click("#step2 [data-go='1']")
    page.check("input[name=level][value='3-4']")
    set_counts(page, {"open": 1, "message": 1})
    page.click("#makePrompt")
    prompt = page.text_content("#promptText")
    ex = json.loads(prompt[prompt.index("{"):])["exercises"]
    check("כל חלק הוא שאלה פתוחה" in prompt and "sampleAnswer" in ex[1]["visible"] and "options" not in ex[1]["hidden"],
          "prompt (ג׳–ד׳): message parts as open questions")
    check("בשדה answer: מספר האפשרות" not in prompt, "no 'answer index' line when nothing has options")

    # ---------- Remembered with the other settings; older saved settings get the level's defaults ----------
    page.reload()
    check(counts(page) == {"mcq": 0, "tf": 0, "fill": 0, "order": 0, "open": 1, "locate": 0, "message": 1}, "counts remembered after reload")
    page.evaluate("""() => { const s = JSON.parse(localStorage.getItem('readingApp.settings')); delete s.exercises; s.level = 'k-1';
                             localStorage.setItem('readingApp.settings', JSON.stringify(s)); }""")
    page.reload()
    check(counts(page) == defaults["k-1"][0], "settings saved before this change: the level's defaults")

    # ---------- The AI's answer is checked against the counts ----------
    w = page.evaluate("""(l) => Lesson.check(Lesson.coerce(l).lesson, {exercises: {mcq: 3, tf: 2, fill: 2, order: 1, open: 1, locate: 0, message: 0}}).warnings""", sample)
    check(any(x == "שאלה פתוחה: התבקשו 1, התקבלו 0." for x in w) and not any("אמריקאית" in x for x in w), "count mismatch → warning per type (%s)" % w)
    w0 = page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, {length: 0}).warnings", sample)
    check(not any("התבקשו" in x and "התקבלו" in x and ":" in x for x in w0), "no count check for requests made before (no exercises in the request)")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
