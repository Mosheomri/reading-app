import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8773
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
SAMPLE = os.path.join(ROOT, "samples", "sample-lesson.json")

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    def lesson():
        page.wait_for_timeout(600)
        return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson")

    page.set_input_files("#loadJsonInput", SAMPLE)
    page.wait_for_selector("#step4:not([hidden])")
    check(page.get_attribute("#editor textarea", "spellcheck") == "true" and page.get_attribute("#editor textarea", "lang") == "he",
          "story textarea: spellcheck + lang=he")
    check(page.get_attribute("#editor input[type=text]", "spellcheck") == "true", "editor inputs: spellcheck")
    check(page.locator("#steps li").count() == 6, "6 steps")
    pm = page.text_content("#checkMsgs")
    check("ייתכן כתיב חסר" in pm and all(w in pm for w in ["בֹּקֶר", "יָרֹק", "אָדֹם"]) and "הכל תקין" not in pm,
          "preview: haser warning lists words, no 'all ok'")
    page.click("#makeLink")
    check(page.is_visible("#step5") and "בדיקה" in page.text_content("#steps li.active"), "edit → check step")
    hm = page.text_content("#haserMsgs")
    check(page.is_visible("#haserMsgs .msg.warn") and "בֹּקֶר" in hm and "אָדֹם" in hm, "check step: haser warning shown")
    page.screenshot(path=os.path.join(OUT, "k1-check.png"), full_page=True)

    # ---------- 1. Text review ----------
    page.click("#makeReviewPrompt")
    prompt = page.text_content("#reviewPromptText")
    check('"type": "error"' in prompt and '"style"' in prompt, "review prompt asks for type")
    check('"story":' in prompt and '"exercises[0].question":' in prompt and "בלוק קוד" in prompt and "אל תשכתב את הסיפור כולו" in prompt,
          "review prompt has fields, code-block request, no-rewrite rule")
    check('targetWords' not in prompt, "review prompt excludes target words")

    sugg = [
        {"field": "story", "type": "error", "original": "כֶּלֶב קָטָן", "fix": "כֶּלֶב קָטָן וְחָמוּד", "reason": "תיאור"},
        {"field": "story", "type": "style", "original": "זורק כדור", "fix": "זוֹרֵק אֶת הַכַּדּוּר", "reason": "ניסוח (נמצא בלי ניקוד)"},
        {"field": "story", "original": "חָתוּל שָׁחֹר", "fix": "חָתוּל לָבָן", "reason": "לא קיים"},
        {"field": "exercises[0].question", "original": "אֵיךְ קוֹרְאִים לַכֶּלֶב?", "fix": "מָה הַשֵּׁם שֶׁל הַכֶּלֶב?", "reason": "ניסוח"},
        {"field": "title", "original": "בַּגִּנָּה", "fix": "בַּגִּנָּה", "reason": "same → dropped"},
        {"field": "story", "type": "error", "original": "בקר", "fix": "בוקר", "reason": "כתיב חסר"},
    ]
    page.fill("#reviewResponse", "הנה ההצעות:\n```json\n" + json.dumps(sugg, ensure_ascii=False) + "\n```")
    page.click("#parseReview")
    cards = page.locator(".review-item")
    check(cards.count() == 5, "5 suggestions shown (identical one dropped): %d" % cards.count())
    check(cards.nth(4).locator(".fix-note").is_visible() and cards.nth(0).locator(".fix-note").count() == 0, "note when fix has no nikud")
    check(cards.nth(2).locator(".msg.warn").is_visible() and cards.nth(2).locator("button:has-text('אשר')").is_disabled(),
          "not-found original: warning + approve disabled")
    check("תרגיל 1 – שאלה" in cards.nth(3).text_content() and "סיפור" in cards.nth(2).text_content() and "story" not in cards.nth(2).locator("strong").text_content(), "field labels in Hebrew, also when not found")
    check("error" in cards.nth(0).get_attribute("class") and "שגיאה" in cards.nth(0).locator(".kind").text_content(), "type=error → red card, label")
    check("style" in cards.nth(1).get_attribute("class") and "הצעת ניסוח" in cards.nth(1).locator(".kind").text_content(), "type=style → gray card, label")
    check("error" in cards.nth(3).get_attribute("class"), "missing type → error")
    bg0 = page.evaluate("getComputedStyle(document.querySelectorAll('.review-item')[0]).backgroundColor")
    bg1 = page.evaluate("getComputedStyle(document.querySelectorAll('.review-item')[1]).backgroundColor")
    check(bg0 != bg1, "different card colors: %s vs %s" % (bg0, bg1))
    page.screenshot(path=os.path.join(OUT, "k2-review.png"), full_page=True)
    cards.nth(0).locator("button:has-text('אשר')").click()
    cards.nth(1).locator("button:has-text('אשר')").click()
    cards.nth(3).locator("button:has-text('דחה')").click()
    L = lesson()
    check("כֶּלֶב קָטָן וְחָמוּד." in L["story"], "exact suggestion applied")
    check("דָּנִי זוֹרֵק אֶת הַכַּדּוּר אָדֹם" in L["story"], "nikud-insensitive suggestion applied")
    check(L["exercises"][0]["question"] == "אֵיךְ קוֹרְאִים לַכֶּלֶב?", "rejected suggestion not applied")
    check("אושר" in cards.nth(0).text_content() and "נדחה" in cards.nth(3).text_content(), "status shown on cards")

    page.fill("#reviewResponse", '{"suggestions": []}')
    page.click("#parseReview")
    check("לא מצאה מה לתקן" in page.text_content("#reviewMsgs"), "empty list → nothing to fix")
    page.fill("#reviewResponse", "סליחה, לא הבנתי")
    page.click("#parseReview")
    check(page.is_visible("#reviewMsgs .msg.error"), "garbage → error")

    # ---------- 2. Nikud check ----------
    plain = page.evaluate("Review.plainText(JSON.parse(localStorage.getItem('readingApp.draft')).lesson)")
    check("קטן וחמוד" in plain and "ֶ" not in plain, "plain text has no nikud")
    check(plain.split("\n")[0] == "הכלב בגנה" and plain.split("\n")[1] == "כלב", "one field per line, title then target words")
    page.click("#copyPlain")
    check("הועתק" in (page.text_content(".toast") or ""), "copy-plain toast")

    # Simulated Dicta output: same text, 2 nikud differences + a meteg-only difference
    voc = page.evaluate("""() => Review.slots(JSON.parse(localStorage.getItem('readingApp.draft')).lesson, true)
                                  .map(s => s.get().trim()).filter(Boolean).join('\\n')""")
    METEG = "\u05BD"
    dicta = voc.replace("קָטָן", "קְטַן", 1).replace("הַכֶּלֶב בַּגִּנָּה", "הַכֶּלֶב בְּגִנָּה", 1).replace("יוֹצְאִים", "יוֹ" + METEG + "צְאִים", 1)
    page.fill("#dictaText", dicta)
    page.click("#compareNikud")
    rows = page.locator(".nikud-row")
    check(rows.count() == 2, "only real differences shown (meteg ignored): %d" % rows.count())
    check("כותרת" in rows.nth(0).text_content() and "סיפור" in rows.nth(1).text_content(), "diff rows labeled by field")
    page.screenshot(path=os.path.join(OUT, "k3-nikud.png"), full_page=True)
    rows.nth(1).locator(".pick").nth(1).click()
    check("קְטַן וְחָמוּד" in lesson()["story"], "pick Dicta version applies it")
    rows.nth(1).locator(".pick").nth(0).click()
    check("קָטָן וְחָמוּד" in lesson()["story"], "pick back AI version")
    page.click("text=קבל את כל דיקטה")
    L = lesson()
    check(L["title"] == "הַכֶּלֶב בְּגִנָּה" and "קְטַן וְחָמוּד" in L["story"], "accept all Dicta")

    # Ktiv male from Dicta: ו/י differences are shown as "כתיב שונה", not an error
    km = dicta.replace("בֹּקֶר", "בּוֹקֶר", 1).replace("אָדֹם", "אָדוֹם", 1)
    page.fill("#dictaText", km)
    page.click("#compareNikud")
    check(not page.is_visible("#nikudMsgs .msg.error"), "ktiv male: no blocking error")
    tagged = page.locator(".nikud-row:has(.tag)")
    check(tagged.count() == 2 and "כתיב שונה" in tagged.nth(0).text_content(), "ktiv male words tagged 'כתיב שונה' (%d)" % tagged.count())
    check(page.locator(".nikud-row").count() == 2, "other words already accepted from Dicta are not shown")
    page.screenshot(path=os.path.join(OUT, "k4-ktiv.png"), full_page=True)
    tagged.nth(0).locator(".pick").nth(1).click()
    check("בְּכָל בּוֹקֶר" in lesson()["story"], "pick Dicta ktiv male word")
    check("בֹּקֶר" not in page.text_content("#haserMsgs") and "אָדֹם" in page.text_content("#haserMsgs"), "haser warning updates after a fix")
    tagged.nth(0).locator(".pick").nth(0).click()
    check("בְּכָל בֹּקֶר" in lesson()["story"], "pick back AI spelling")
    check("סגנון מודרני, ניקוד בכתיב מלא" in page.text_content("#step5"), "Dicta settings instruction shown")

    # Word count mismatch
    page.fill("#dictaText", dicta.replace("קְטַן וְחָמוּד", "קְטַן", 1))
    page.click("#compareNikud")
    m = page.text_content("#nikudMsgs")
    check("מספר המילים לא תואם" in m and "ההבדל הראשון בשורה" in m, "word-count mismatch: clear error with line")
    # Letter mismatch
    page.fill("#dictaText", dicta.replace("קְטַן", "גָּדוֹל", 1))
    page.click("#compareNikud")
    check("שונה באותיות" in page.text_content("#nikudMsgs"), "letter mismatch error")

    # Stale results after editing
    cur = page.evaluate("""() => Review.slots(JSON.parse(localStorage.getItem('readingApp.draft')).lesson, true)
                                  .map(s => s.get().trim()).filter(Boolean).join('\\n')""")
    page.fill("#dictaText", cur.replace("קְטַן", "קָטָן", 1))
    page.click("#compareNikud")
    check(page.locator(".nikud-row").count() == 1, "re-compare against current text")
    page.click("#step5 [data-go='4']")
    page.locator("#editor input[type=text]").first.fill("כּוֹתֶרֶת חֲדָשָׁה")
    page.wait_for_timeout(300)
    page.click("#makeLink")
    check(page.locator(".nikud-row").count() == 0 and "הטקסט השתנה" in page.text_content("#nikudMsgs"), "stale nikud results cleared")

    # Errors block the link from the check step
    page.click("#step5 [data-go='4']")
    page.locator(".tw-row").nth(0).locator("input.emoji").fill("")
    page.wait_for_timeout(300)
    page.click("#steps li[data-step='5']")
    page.click("#toLink")
    check(page.is_visible("#checkStepMsgs .msg.error") and page.is_visible("#step5"), "errors block link creation")
    page.click("#step5 [data-go='4']")
    page.locator(".tw-row").nth(0).locator("input.emoji").fill("🐕")
    page.wait_for_timeout(300)
    page.click("#makeLink")
    page.click("#skipCheck")
    check(page.is_visible("#step6") and page.text_content("#linkBox").startswith(BASE + "play.html#"), "skip → link")

    # Link carries the edits
    child = ctx.new_page()
    child.goto(page.text_content("#linkBox"))
    child.wait_for_selector(".stage-actions .btn")
    check("כּוֹתֶרֶת חֲדָשָׁה" in child.text_content("#stage h1"), "child link has edited lesson")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
