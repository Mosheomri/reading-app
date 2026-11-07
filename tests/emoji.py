"""Emoji: the prompt asks for common, old emoji only; an emoji the device cannot show (measured on a canvas) is
replaced by its word: teacher preview, child start page, memory cards, print; the build game leaves it out.
An emoji only if it shows exactly the word, else the field is empty: no error; memory is a word-word pair; the start
page and the build game show no picture and no empty place; the teacher preview marks it "אין ציור"."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
MISSING = "\U0001FAFF"  # not an emoji (unassigned): no font has it

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

def serve_file(route):
    url = route.request.url
    if not url.startswith(SITE): route.abort(); return
    full = os.path.normpath(os.path.join(ROOT, unquote(urlparse(url).path)[len("/reading-app/"):] or "index.html"))
    if not full.startswith(ROOT) or not os.path.isfile(full): route.fulfill(status=404, body="not found"); return
    ctype = "application/javascript" if full.endswith(".js") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 1200, "height": 900})
    ctx.route("**/*", serve_file)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SITE + "index.html")

    common = "🐶 🐱 🌳 ⚽ 🏠 🍎 ☀️ ❤️ ✏️ 🚗 📖 🎈 🐕 🦋 🌈 ⭐".split()
    r = page.evaluate("(l) => l.map(e => Util.emojiShown(e))", common)
    check(all(r), "common emoji are shown (%s)" % [e for e, ok in zip(common, r) if not ok])
    bad = page.evaluate("(l) => l.map(e => Util.emojiShown(e))", [MISSING, "\U000EFFFD", "🐶‍🍕", "\U0001F1FF\U0001F1FF", ""])
    check(bad == [False] * 5, "not shown: an unassigned code point, an unknown sequence, an unknown flag, empty (%s)" % bad)

    prompt = page.evaluate("buildPrompt({topic: 'x', length: 100, level: '1-2', wordsMode: 'number', wordCount: 4, words: []})")
    check("רק אימוג׳י נפוץ וותיק שמוצג בכל מכשיר" in prompt and "בלי גווני עור ובלי דגלים" in prompt,
          "prompt: common, old emoji only, shown on every device")

    # A lesson with one emoji the device cannot show
    lesson = json.loads(json.dumps(sample))
    lesson["targetWords"][0]["emoji"] = MISSING
    word0 = lesson["targetWords"][0]["word"]
    page.evaluate("(l) => localStorage.setItem('readingApp.draft', JSON.stringify({lesson: l, request: null, nikudVerified: null}))", lesson)
    page.reload()
    page.click("#resumeDraft")
    chips = page.eval_on_selector_all("#preview .chip", "els => els.map(e => e.textContent.trim())")
    check(MISSING not in chips[0] and chips[0] == page.evaluate("(w) => Render.text({nikudMode: 'full', targetWords: []}, w)", word0)
          and chips[1].startswith(lesson["targetWords"][1]["emoji"]), "teacher preview: the word alone for that emoji, the others as before (%s)" % chips[:2])

    # Child page
    page.goto(SITE + "play.html#" + page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", lesson))
    page.wait_for_timeout(500)
    start = page.text_content(".big-emoji") or ""
    check(MISSING not in start and page.locator(".big-emoji .emoji-word").count() == 1 and lesson["targetWords"][1]["emoji"] in start,
          "child start page: the word in place of the missing emoji (%s)" % start)

    # ---------- No exact emoji: the field stays empty ----------
    page.goto(SITE + "index.html")
    EXACT = "- אימוג׳י רק אם הוא מראה בדיוק את המילה. אם אין אימוג׳י מדויק, השאר את השדה emoji ריק."
    PREFER = "- כשאתה בוחר את מילות היעד בעצמך, העדף מילים שיש להן אימוג׳י מדויק."
    S = {"topic": "x", "length": 200, "level": "3-4", "genre": "story", "wordsMode": "number", "wordCount": 4, "words": []}
    SL = dict(S, wordsMode="list", words=["שולחן", "ציור"])
    for label, js, arg in [("copy-paste", "(s) => buildPrompt(s)", S), ("plan", "(s) => buildPlanPrompt(s, {own: 'רעיון'})", S)]:
        t = page.evaluate(js, arg)
        check(EXACT in t and PREFER in t, label + " prompt: an exact emoji or an empty field; prefer words with an exact emoji")
    t = page.evaluate("(s) => buildIdeasPrompt(s, [])", S)
    check(PREFER in t, "ideas prompt: prefer words with an exact emoji")
    for label, js in [("copy-paste", "(s) => buildPrompt(s)"), ("plan", "(s) => buildPlanPrompt(s, {own: 'רעיון'})")]:
        t = page.evaluate(js, SL)
        check(EXACT in t and PREFER not in t, label + " prompt with the teacher's words: exact emoji or empty, no 'prefer' line")

    noemo = json.loads(json.dumps(sample))
    noemo["targetWords"][0]["emoji"] = ""
    w0 = noemo["targetWords"][0]["word"]
    res = page.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson)", noemo)
    check(not [e for e in res["errors"] if "אימוג" in e], "check: a word with no emoji is not an error (%s)" % res["errors"])
    page.goto(SITE + "index.html")
    page.evaluate("(l) => localStorage.setItem('readingApp.draft', JSON.stringify({lesson: l, request: null, nikudVerified: null}))", noemo)
    page.reload()
    page.click("#resumeDraft")
    check(page.locator("#preview .chip").nth(0).locator(".no-pic").text_content() == "אין ציור"
          and page.locator("#preview .chip .no-pic").count() == 1, "teacher preview: a small 'אין ציור' mark on the word with no emoji only")

    page.goto(SITE + "play.html#" + page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", noemo))
    page.wait_for_selector(".stage-actions .btn")
    start = page.text_content(".big-emoji") or ""
    shown0 = page.evaluate("(w) => Render.text(Lesson.decode(location.hash), w)", w0)
    check(page.locator(".big-emoji .emoji-word").count() == 0 and shown0 not in start and noemo["targetWords"][1]["emoji"] in start,
          "child start page: the word with no emoji is left out, no empty place (%s)" % start)
    page.click(".stage-actions .btn")
    page.wait_for_selector(".mcard")
    faces = page.eval_on_selector_all(".mcard .face", "els => els.map(e => e.textContent)")
    words = page.eval_on_selector_all(".mcard.word .face", "els => els.map(e => e.textContent)")
    check(faces.count(shown0) == 2 and words.count(shown0) == 2 and "" not in faces,
          "memory: the word with no emoji is a word-word pair (%s)" % faces)
    idx = [i for i, f in enumerate(faces) if f == shown0]
    cards = page.locator(".mcard")
    cards.nth(idx[0]).click(); cards.nth(idx[1]).click()
    page.wait_for_timeout(300)
    check(page.locator(".mcard.matched").count() == 2, "memory: the two word cards match")

    one = json.loads(json.dumps(sample))
    for t in one["targetWords"]: t["emoji"] = ""
    page.goto(SITE + "play.html#" + page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", one))
    page.wait_for_selector(".stage-actions .btn")
    check(page.locator(".big-emoji").count() == 0, "child start page: no emoji at all → no emoji row")
    page.click(".stage-actions .btn")
    page.wait_for_selector(".mcard")
    page.click("#navNext")
    page.wait_for_timeout(300)
    check(page.text_content("#stage h1") == "הרכבת מילה" and page.locator("#stage .big-emoji").count() == 0,
          "build game: no picture for a word with no emoji")

    ctx.close()
    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
