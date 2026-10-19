"""Nikud from Dicta: the AI writes without nikud, Dicta's nikud is applied, and it is required for a link
in full/partial mode."""
import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8775
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

SLOTS_JS = "(l) => Review.slots(l, true).map(s => s.get().trim()).filter(Boolean).join('\\n')"

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
        return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")

    def current_text():
        return page.evaluate("(l) => (" + SLOTS_JS + ")(l)", draft()["lesson"])

    vocalized = page.evaluate("(s) => (" + SLOTS_JS + ")(Lesson.coerce(s).lesson)", sample)
    voc_lesson = page.evaluate("(s) => Lesson.coerce(s).lesson", sample)
    plain = page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False))
    check(not page.evaluate("(s) => Hebrew.hasNikud(s)", plain), "test setup: plain lesson has no nikud")

    # ---------- Prompt ----------
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "55")
    page.check("input[name=nikud][value=full]")
    page.click("button[type=submit]")
    prompt = page.text_content("#promptText")
    check("אורך הסיפור: 3 פסקאות, בכל פסקה 3 משפטים, סך הכול בערך 55 מילים." in prompt, "prompt has total word count")
    check(not page.evaluate("(p) => Hebrew.hasNikud(p)", prompt) and "בלי ניקוד בכלל" in prompt, "prompt asks for no nikud and has none")
    scripts = page.eval_on_selector_all("script[src^='js/'], link[href^='css/']", "els => els.map(e => e.getAttribute('src') || e.getAttribute('href'))")
    check(scripts and all("?v=" in s for s in scripts), "local scripts and css carry a ?v= version (cache busting)")

    # ---------- Paste a lesson without nikud ----------
    page.click("#step2 [data-go='3']")
    page.fill("#response", "```json\n" + plain + "\n```")
    page.click("#parseBtn")
    check("ניקוד" not in (page.text_content("#parseMsgs") or ""), "paste step: nothing about nikud")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    check(page.is_visible("#step4"), "editor shown")
    msgs = page.text_content("#checkMsgs")
    check("השיעור עדיין בלי ניקוד" in msgs and "דיקטה" in msgs, "preview: lesson not vocalized yet, Dicta is next")
    check(page.locator("#preview .no-nikud").count() == 0, "preview: no red marks before Dicta")
    check(page.text_content("#makeLink") == "המשך לבדיקה ולניקוד ←", "continue button mentions nikud")

    # ---------- Check step, nikud required ----------
    page.click("#makeLink")
    check(page.text_content("#step5Title") == "בדיקה וניקוד" and page.is_hidden("#skipCheck") and page.is_visible("#nikudPart"),
          "full mode: nikud part shown, no skip")
    check(page.text_content("#compareNikud") == "החלת הניקוד", "unvocalized lesson → apply button")
    page.click("#toLink")
    check(page.is_visible("#step5") and "לנקד את הטקסט בדיקטה" in page.text_content("#checkStepMsgs"), "link blocked before Dicta")

    # Letters must match exactly, ו/י included
    page.fill("#dictaText", vocalized.replace("כַּדּוּר אָדֹם", "כַּדּוּרִים אָדֹם", 1))
    page.click("#compareNikud")
    check("שונה באותיות" in page.text_content("#nikudMsgs"), "letter mismatch → error")
    page.fill("#dictaText", vocalized.replace("בֹּקֶר", "בּוֹקֶר", 1))
    page.click("#compareNikud")
    check("שונה באותיות" in page.text_content("#nikudMsgs"), "extra ו in an unvocalized word → error")
    page.fill("#dictaText", vocalized.replace("כַּדּוּר אָדֹם.", "כַּדּוּר", 1))
    page.click("#compareNikud")
    check("מספר המילים לא תואם" in page.text_content("#nikudMsgs"), "word count mismatch → error")
    check(not page.evaluate("(s) => Hebrew.hasNikud(s)", draft()["lesson"]["story"]), "errors leave the lesson unchanged")

    # Apply
    page.fill("#dictaText", vocalized)
    page.click("#compareNikud")
    n_words = page.evaluate("(t) => Hebrew.countWords(t)", vocalized)
    nm = page.text_content("#nikudMsgs")
    check("הניקוד של דיקטה הוחל על %d מילים" % n_words in nm, "nikud applied to every word (%d): %s" % (n_words, nm))
    check(page.locator(".nikud-row").count() == 0, "no comparison for an unvocalized lesson")
    L = draft()["lesson"]
    check(L["story"] == voc_lesson["story"] and L["title"] == voc_lesson["title"], "story and title now vocalized, punctuation and paragraphs kept")
    check(L["targetWords"] == voc_lesson["targetWords"] and L["exercises"] == voc_lesson["exercises"], "target words and exercises vocalized")
    check(page.text_content("#compareNikud") == "השוואה", "after nikud → compare button")
    check("בֹּקֶר" in page.text_content("#haserMsgs"), "ktiv haser check works once nikud is in")
    page.screenshot(path=os.path.join(OUT, "d1-applied.png"), full_page=True)
    page.click("#toLink")
    check(page.is_visible("#step6"), "after Dicta → link")

    # ---------- Editing after Dicta requires Dicta again ----------
    page.click("#steps li[data-step='4']")
    story = page.locator("#editor textarea")
    story.fill(story.input_value().replace("כֶּלֶב קָטָן.", "כֶּלֶב קָטָן מאוד.", 1))
    page.wait_for_timeout(400)
    msgs = page.text_content("#checkMsgs")
    check("מאוד" in msgs and "בדיקטה" in msgs, "preview lists the new unvocalized word for Dicta")
    page.click("#steps li[data-step='6']")
    check(page.is_visible("#step5") and "לנקד את הטקסט בדיקטה" in page.text_content("#checkStepMsgs"), "progress bar step 6 blocked after an edit")
    check("הטקסט השתנה" in page.text_content("#nikudMsgs"), "check step: stale nikud message")
    page.fill("#dictaText", current_text().replace("מאוד", "מְאוֹד"))
    page.click("#compareNikud")
    check("הוחל על מילה אחת" in page.text_content("#nikudMsgs") and page.locator(".nikud-row").count() == 0, "only the new word is filled")
    check("קָטָן מְאוֹד." in draft()["lesson"]["story"], "new word vocalized")
    page.click("#toLink")
    check(page.is_visible("#step6"), "link after redoing Dicta")

    # ---------- The Dicta state survives a reload (draft) ----------
    page.wait_for_timeout(600)
    page.reload()
    page.click("#resumeDraft")
    page.click("#makeLink")
    check("הטקסט מנוקד" in page.text_content("#nikudMsgs"), "resumed draft: already vocalized")
    page.click("#toLink")
    check(page.is_visible("#step6"), "resumed draft: link without redoing Dicta")

    # ---------- No nikud mode: no Dicta step ----------
    page.click("#steps li[data-step='4']")
    page.check("input[name=edNikud][value=none]")
    story = page.locator("#editor textarea")
    story.fill(story.input_value() + " שוב")
    page.wait_for_timeout(400)
    check("ניקוד" not in page.text_content("#checkMsgs"), "none mode: no nikud note in preview")
    check(page.text_content("#makeLink") == "המשך לבדיקה ←", "none mode: plain continue button")
    page.click("#makeLink")
    check(page.text_content("#step5Title") == "בדיקה (לא חובה)" and page.is_hidden("#nikudPart") and page.is_visible("#skipCheck"),
          "none mode: Dicta part hidden, skip offered")
    page.click("#skipCheck")
    check(page.is_visible("#step6"), "none mode: link without Dicta")

    # ---------- Loaded lesson files ----------
    plain_path = os.path.join(OUT, "plain-lesson.json")
    open(plain_path, "w", encoding="utf-8").write(plain)
    page.click("#newLesson")
    page.set_input_files("#loadJsonInput", plain_path)
    page.wait_for_selector("#step4:not([hidden])")
    page.click("#makeLink"); page.click("#toLink")
    check(page.is_visible("#step5"), "unvocalized file: Dicta required")
    page.click("#steps li[data-step='1']")
    page.set_input_files("#loadJsonInput", SAMPLE)
    page.wait_for_selector("#step4:not([hidden])")
    page.click("#makeLink"); page.click("#toLink")
    check(page.is_visible("#step6"), "fully vocalized file: link without Dicta")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
