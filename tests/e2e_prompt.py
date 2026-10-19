import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8768
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

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    # Prompt contents
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "55")
    # The question types of the sample lesson (pasted below), so the counts match.
    page.evaluate("""() => { const c = {mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 0, message: 0};
      for (const k in c) { const i = document.querySelector('[data-count="' + k + '"]'); i.value = c[k]; i.dispatchEvent(new Event('input')); } }""")
    page.click("button[type=submit]")
    prompt = page.text_content("#promptText")
    check("בתוך בלוק קוד אחד (```json)" in prompt, "prompt asks for a ```json code block")
    check("אל תכניס אימוג׳י לסיפור, לכותרת או לתרגילים. אימוג׳י מופיעים רק בשדה emoji של מילות היעד." in prompt, "prompt: no emoji outside emoji field")
    check("כתוב את כל הטקסט בלי ניקוד בכלל" in prompt, "prompt: no nikud at all")
    check("כתוב בכתיב מלא תקני" in prompt and "ועליו הוסף ניקוד" not in prompt and "בניקוד מלא" not in prompt, "prompt: ktiv male, no nikud instructions")
    check(not page.evaluate("(p) => Hebrew.hasNikud(p)", prompt), "prompt (schema example included) has no nikud characters")
    check("העתיקו את התשובה בכפתור ההעתקה שמעל בלוק הקוד" in page.text_content("#step2"), "step 2 hint shown")
    page.screenshot(path=os.path.join(OUT, "v2-step2.png"), full_page=True)

    # Emoji in story: removed + warning, story text cleaned
    lesson = dict(sample)
    lesson["story"] = sample["story"].replace("כֶּלֶב קָטָן.", "כֶּלֶב קָטָן 🐕.").replace("לַגִּנָּה.", "לַגִּנָּה 🌳🌞!") \
        .replace("דָּנִי זוֹרֵק", "👨‍👩‍👧 דָּנִי זוֹרֵק").replace("טוֹב!", "טוֹב! 👍🏽")
    page.click("#step2 [data-go='3']")
    page.fill("#response", "```json\n" + json.dumps(lesson, ensure_ascii=False) + "\n```")
    page.click("#parseBtn")
    msgs = page.text_content("#parseMsgs")
    check("הוסרו אימוג׳י מתוך הסיפור" in msgs, "emoji removal warning shown")
    check(page.is_hidden("#fixBox"), "no fix message when the only issue was auto-fixed")
    check(page.text_content("#continueAnyway") == "להמשיך לעריכה ←", "continue button label without errors")
    page.screenshot(path=os.path.join(OUT, "v2-step3.png"), full_page=True)
    page.click("#continueAnyway")
    story = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft') || 'null')") or {}
    page.wait_for_timeout(600)
    story = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.story")
    check(story == sample["story"].replace("לַגִּנָּה.", "לַגִּנָּה!"), "story cleaned exactly (only emoji + their spaces removed)")
    check("כֶּלֶב קָטָן." in story and "לַגִּנָּה!" in story and "\nדָּנִי זוֹרֵק" in story, "spacing/punctuation tidied")

    # Clean story → no warning, goes straight to the editor
    page.click("#step4 [data-go='3']")
    page.fill("#response", json.dumps(sample, ensure_ascii=False))
    page.click("#parseBtn")
    check(page.is_visible("#step4"), "clean response goes straight to editor")

    # Step-3 file load runs the same checks
    path = os.path.join(OUT, "ai-file.json")
    json.dump(lesson, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    page.click("#step4 [data-go='3']")
    page.fill("#response", "")
    page.set_input_files("#responseFileInput", path)
    page.wait_for_selector("#parseMsgs .msg")
    check("הוסרו אימוג׳י" in page.text_content("#parseMsgs"), "step-3 file load is validated")
    check(page.input_value("#response").startswith("{"), "file content placed in textarea")

    # Emoji regex leaves Hebrew/nikud/punctuation untouched
    r = page.evaluate("""() => Lesson.coerce({story: 'שָׁלוֹם, "חֲבֵרִים"! 1-2 ©', targetWords: [], exercises: []})""")
    check(r["notes"] == ["הוסרו אימוג׳י מתוך הסיפור."] and r["lesson"]["story"] == 'שָׁלוֹם, "חֲבֵרִים"! 1-2', "© counts as emoji; Hebrew untouched: " + r["lesson"]["story"])
    r = page.evaluate("""() => Lesson.coerce({story: 'שָׁלוֹם, "חֲבֵרִים"! 1-2.', targetWords: [], exercises: []})""")
    check(r["notes"] == [], "plain Hebrew story: no notes")

    cases = {
        "כֶּלֶב 🐕 רָץ.": "כֶּלֶב רָץ.",
        "כֶּלֶב🐕רָץ.": "כֶּלֶב רָץ.",
        "רָץ 🐕.": "רָץ.",
        '"טוֹב! 👍🏽" אָמַר': '"טוֹב!" אָמַר',
        'אָמַר 🐕 "שָׁלוֹם"': 'אָמַר "שָׁלוֹם"',
        "🌞 בֹּקֶר טוֹב" + chr(10) + "🐕 כֶּלֶב": "בֹּקֶר טוֹב" + chr(10) + "כֶּלֶב",
        "דֶּגֶל 🇮🇱 כָּחֹל": "דֶּגֶל כָּחֹל",
    }
    for src, want in cases.items():
        got = page.evaluate("(s) => Lesson.coerce({story: s, targetWords: [], exercises: []}).lesson.story", src)
        check(got == want, "emoji spacing: %r -> %r" % (src, got))

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
