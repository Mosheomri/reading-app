"""Emoji: the prompt asks for common, old emoji only; an emoji the device cannot show (measured on a canvas) is
replaced by its word: teacher preview, child start page, memory cards, print; the build game leaves it out."""
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
    ctx.close()
    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
