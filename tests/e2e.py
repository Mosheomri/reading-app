import json, sys, threading, functools, http.server, socketserver, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8765

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Quiet(Handler.func):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"

sample = open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8").read()
fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ---------- hebrew.js unit checks ----------
    page.goto(BASE + "index.html")
    r = page.evaluate("""() => {
      const H = Hebrew;
      return {
        strip: H.stripNikud('כֶּלֶב־גָּדוֹל'),
        m1: H.matchesWord('וְהַכֶּלֶב', 'כֶּלֶב'),
        m2: H.matchesWord('שֶׁבַּגִּנָּה', 'גִּנָּה'),
        m3: H.matchesWord('כְּלָבִים', 'כֶּלֶב'),
        m4: H.matchesWord('בַּגִּנָּה', 'הַגִּנָּה'),
        m5: H.matchesWord('אכלב', 'כלב'),
        partial: H.displayText('וְהַכֶּלֶב רָץ.', 'partial', ['כֶּלֶב']),
        none: H.displayText('כֶּלֶב רָץ', 'none', []),
        graph: H.graphemes('שָׁלוֹם'),
        count: H.countWords('דָּנִי זוֹרֵק כַּדּוּר. "כֶּלֶב טוֹב!" אוֹמֵר'),
        norm: H.normalize('\\uFB2A') === H.normalize('\\u05E9\\u05C1')
      };
    }""")
    check(r["strip"] == "כלב־גדול", "stripNikud keeps maqaf: " + r["strip"])
    check(r["m1"] and r["m2"] and r["m4"], "prefix matching (וה, שב, article)")
    check(not r["m3"] and not r["m5"], "no false matches (plural, non-prefix letter)")
    check(r["partial"] == "וְהַכֶּלֶב רץ.", "partial mode: " + r["partial"])
    check(r["none"] == "כלב רץ", "none mode")
    check(r["graph"] == ["שָׁ", "ל", "וֹ", "ם"], "graphemes: " + json.dumps(r["graph"], ensure_ascii=False))
    check(r["count"] == 6, "countWords = %d" % r["count"])
    check(r["norm"], "normalize presentation form")

    # ---------- Teacher flow ----------
    page.evaluate("localStorage.clear()")
    page.reload()
    page.click("button[type=submit]")
    check(page.is_visible("#settingsMsgs .msg.error"), "empty topic is rejected")
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "80")
    page.check("input[name=wordsMode][value=list]")
    page.fill("#wordList", "כלב, כדור, גינה, עץ")
    page.check("input[name=nikud][value=partial]")
    page.click("button[type=submit]")
    prompt = page.text_content("#promptText")
    check(page.is_visible("#step2") and "כלב בגינה" in prompt and "מילות היעד: כלב, כדור, גינה, עץ" in prompt, "prompt generated")
    check('nikudMode' not in prompt and not page.evaluate("(p) => Hebrew.hasNikud(p)", prompt), "prompt and schema without nikud or nikudMode")
    page.screenshot(path=os.path.join(OUT, "t2-prompt.png"), full_page=True)

    page.click("#step2 [data-go='3']")
    # Broken JSON → error + fix message
    page.fill("#response", 'הנה:\n```json\n{"title": "x", "story": "abc"\n```')
    page.click("#parseBtn")
    check(page.is_visible("#parseMsgs .msg.error") and page.is_visible("#fixBox"), "broken JSON shows error + fix")
    # Missing fields → fatal
    page.fill("#response", '{"title": "x"}')
    page.click("#parseBtn")
    check("story" in page.text_content("#fixText"), "missing fields listed in fix message")
    # Target word missing → error but can continue
    bad = json.loads(sample); bad["targetWords"].append({"word": "חָתוּל", "emoji": "🐈"})
    page.fill("#response", "בטח! הנה השיעור:\n```json\n" + json.dumps(bad, ensure_ascii=False) + "\n```\nבהצלחה!")
    page.click("#parseBtn")
    check("חָתוּל" in page.text_content("#parseMsgs"), "missing target word reported")
    check(page.is_visible("#continueAnyway"), "continue-anyway offered")
    page.click("#continueAnyway")
    check(page.is_visible("#step4"), "editor shown")
    check(page.is_disabled("#makeLink"), "link blocked while errors exist")
    # Remove the bad word in the editor
    page.locator(".tw-row").nth(4).locator(".icon-btn").click()
    page.wait_for_timeout(300)
    check(not page.is_disabled("#makeLink"), "link enabled after fixing")
    nikud_mode = page.evaluate("document.querySelector('input[name=edNikud]:checked').value")
    check(nikud_mode == "partial", "nikud mode taken from settings")
    prev = page.text_content("#preview .story")
    check("לַכֶּלֶב" in prev and "קוראים" in prev, "preview applies partial nikud")
    check(page.locator("#preview .story .target").count() >= 10, "targets highlighted in preview (%d)" % page.locator("#preview .story .target").count())
    # Edit title live
    page.locator("#editor input[type=text]").first.fill("הַכֶּלֶב בּוֹנִי")
    page.wait_for_timeout(300)
    check("הַכֶּלֶב" in page.text_content("#preview h2"), "title edit reflected in preview")
    page.screenshot(path=os.path.join(OUT, "t4-editor.png"), full_page=True)
    page.set_viewport_size({"width": 1300, "height": 900})
    page.screenshot(path=os.path.join(OUT, "t4-editor-desktop.png"))
    page.set_viewport_size({"width": 390, "height": 844})

    # Partial nikud: Dicta is required before the link
    page.click("#makeLink"); page.click("#toLink")
    check(page.is_visible("#step5") and "לנקד את הטקסט בדיקטה" in page.text_content("#checkStepMsgs"), "partial mode: link blocked until Dicta")
    voc = page.evaluate("""() => Review.slots(JSON.parse(localStorage.getItem('readingApp.draft')).lesson, true)
                                  .map(s => s.get().trim()).filter(Boolean).join('\\n')""")
    page.fill("#dictaText", voc)
    page.click("#compareNikud")
    page.click("#toLink")
    link = page.text_content("#linkBox")
    check(link.startswith(BASE + "play.html#"), "link built: %d chars" % len(link))
    wa = page.get_attribute("#waLink", "href")
    check(wa.startswith("https://wa.me/?text="), "whatsapp link")
    page.screenshot(path=os.path.join(OUT, "t5-link.png"), full_page=True)

    # Draft resumes after reload
    page.wait_for_timeout(500)
    page.reload()
    check(page.is_visible("#resumeDraft"), "draft resume offered")
    check(page.input_value("#topic") == "כלב בגינה", "form values remembered")

    # ---------- Child flow ----------
    child = browser.new_page(viewport={"width": 390, "height": 844})
    child.on("console", lambda m: m.type == "error" and errors.append("child: " + m.text))
    child.on("pageerror", lambda e: errors.append("child: " + str(e)))
    external = []
    child.on("request", lambda req: (not req.url.startswith(BASE)) and external.append(req.url))
    child.goto(link)
    child.wait_for_selector(".stage-actions .btn")
    check("הַכֶּלֶב" in child.text_content("#stage h1"), "start screen title")
    child.screenshot(path=os.path.join(OUT, "c0-start.png"))
    child.click(".stage-actions .btn")

    lesson = json.loads(sample)
    lesson["title"] = "הַכֶּלֶב בּוֹנִי"
    # Memory: match by reading faces
    check(child.text_content("#stage h1") == "זוגות", "memory game first")
    child.screenshot(path=os.path.join(OUT, "c1-memory.png"))
    emoji_of = {t["word"]: t["emoji"] for t in lesson["targetWords"]}
    word_show = child.evaluate("(ws) => ws.map(w => Render.text(Lesson.decode(location.hash), w))", list(emoji_of))
    show_to_emoji = dict(zip(word_show, emoji_of.values()))
    faces = child.eval_on_selector_all(".mcard .face", "els => els.map(e => e.textContent)")
    for i, f in enumerate(faces):
        if f in show_to_emoji:
            j = faces.index(show_to_emoji[f])
            cards = child.locator(".mcard")
            cards.nth(i).click(); cards.nth(j).click()
            child.wait_for_timeout(150)
    child.wait_for_timeout(800)
    check(child.locator(".mcard.matched").count() == 8, "memory solved")
    check("primary" in child.get_attribute(".stage-actions .btn:last-child", "class"), "next button highlighted after game")
    child.click(".stage-actions .btn:last-child")

    # Build word
    check(child.text_content("#stage h1") == "הרכבת מילה", "build game second")
    child.screenshot(path=os.path.join(OUT, "c2-build.png"))
    for rnd in range(4):
        emoji = child.text_content(".big-emoji")
        word = [w for w, e in emoji_of.items() if e == emoji][0]
        letters = child.evaluate("(w) => Hebrew.graphemes(Render.text(Lesson.decode(location.hash), w))", word)
        if rnd == 0:
            # deliberate mistake → hint, no progress
            wrong = [t for t in child.eval_on_selector_all(".tile", "els => els.map(e => e.textContent)") if t != letters[0]]
            if wrong:
                child.locator(".tile", has_text=wrong[0]).first.click()
                check("נסו" in child.text_content(".feedback"), "gentle hint on wrong letter")
        for L_ in letters:
            child.locator(".tile:not(.used)").filter(has_text=L_).first.click()
        child.wait_for_timeout(1600)
    check("סיימתם" in child.text_content(".feedback"), "build game finished")
    child.click(".stage-actions .btn:last-child")

    # Listen game is skipped headless (no Hebrew voice) → reading
    h1 = child.text_content("#stage h1")
    check(h1 != "שומעים ובוחרים", "listen game skipped without voice (now: %s)" % h1)
    check(child.locator(".reader .story .target").count() >= 10, "reading: targets highlighted")
    size0 = child.evaluate("getComputedStyle(document.querySelector('.reader .story')).fontSize")
    child.click("[aria-label='הגדלת טקסט']")
    size1 = child.evaluate("getComputedStyle(document.querySelector('.reader .story')).fontSize")
    check(size0 == "30px" and size1 == "34px", "text size %s → %s" % (size0, size1))
    child.screenshot(path=os.path.join(OUT, "c3-reading.png"), full_page=True)
    child.click("text=סיימתי לקרוא ←")

    # Exercises
    dec = child.evaluate("Lesson.decode(location.hash)")
    for k, ex in enumerate(dec["exercises"]):
        if ex["type"] in ("mcq", "fill"):
            correct = child.evaluate("(o) => Render.text(Lesson.decode(location.hash), o)", ex["options"][ex["answer"]])
            if k == 0:
                wrong = [b for b in child.eval_on_selector_all(".option", "els => els.map(e => e.textContent)") if b != correct][0]
                child.locator(".option", has_text=wrong).first.click()
                check(child.is_hidden(".stage-actions .btn"), "wrong answer: no advance, retry allowed")
                child.click("text=📖 לסיפור")
                check(child.is_visible(".overlay"), "story hint overlay")
                child.click(".overlay .sheet .btn")
            child.locator(".option").filter(has_text=correct).first.click()
        elif ex["type"] == "tf":
            child.click(".option >> text=" + ("👍 נכון" if ex["answer"] else "👎 לא נכון"))
        elif ex["type"] == "order":
            child.screenshot(path=os.path.join(OUT, "c4-order.png"), full_page=True)
            for s in ex["sentences"]:
                shown = child.evaluate("(o) => Render.text(Lesson.decode(location.hash), o)", s)
                child.locator(".order-list:not(.answer) .order-item").filter(has_text=shown).first.click()
        child.wait_for_selector(".stage-actions .btn:visible")
        if k == 5:
            check(child.locator(".blank.filled").count() == 1, "fill blank filled after answer")
        child.click(".stage-actions .btn")

    check(child.text_content("#stage h1") == "כל הכבוד!", "finish screen")
    stars = child.text_content(".stars")
    check(stars == "⭐⭐⭐", "stars: " + stars + " (one mistake out of 8)")
    w = child.evaluate("document.getElementById('progressFill').style.width")
    check(w == "100%", "progress 100%")
    child.screenshot(path=os.path.join(OUT, "c5-finish.png"))
    child.click(".stage-actions .btn")
    check(child.is_visible("text=מתחילים ▶"), "restart works")

    # Broken link
    child.goto(BASE + "play.html#garbage")
    check("הקישור לא שלם" in child.text_content("#stage"), "broken link message")

    bad_ext = [u for u in external if "fonts.googleapis.com" not in u and "fonts.gstatic.com" not in u]
    check(not bad_ext, "no external requests except fonts: %s" % bad_ext)
    check(not errors, "no console errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
