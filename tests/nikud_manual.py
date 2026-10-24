"""Second opinion on Dicta's nikud by hand, in any chat: the prompt (the lines sent to Dicta, in a code block), the
answer pasted back, the same comparison and orange marks as the automatic check; line-count and letter mismatches;
always there, also without a key; offered right away when the automatic check fails."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
API = "https://generativelanguage.googleapis.com/"
KEY = "AIzaTEST-key-1234"
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

def serve_file(route):
    path = unquote(urlparse(route.request.url).path)[len("/reading-app/"):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, path))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

api_calls = []
def quota(route):
    if route.request.method == "OPTIONS":
        route.fulfill(status=204, headers=CORS); return
    api_calls.append(route.request.url)
    route.fulfill(status=429, body=json.dumps({"error": {"code": 429, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}}),
                  headers=dict(CORS, **{"Content-Type": "application/json"}))

def new_page(browser, key=None):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    ctx.route(API + "**", quota)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    if key: page.evaluate("(k) => localStorage.setItem('readingApp.geminiKey', k)", key)
    page.reload()
    page.evaluate("Gemini.config.retryDelay = 100")
    return ctx, page

def to_check_step(page, lesson):
    """Settings (full nikud), the lesson pasted without nikud, then the check step."""
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", str(STORY_WORDS))
    page.check("input[name=nikud][value=full]")
    page.click("#makePrompt")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(lesson, ensure_ascii=False))
    page.click("#parseBtn")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    page.click("#makeLink")

def apply_dicta(page):
    page.fill("#dictaText", DICTA_TEXT)
    page.click("#compareNikud")

def manual_msgs(page): return page.text_content("#secondManualMsgs") or ""

def compare(page, answer):
    page.fill("#secondResponse", answer)
    page.click("#compareSecond")
    page.wait_for_timeout(200)

def marks(page):
    return page.eval_on_selector_all("#preview .nikud-check", "els => els.map(e => e.textContent)")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx, page = new_page(browser)
    plain = json.loads(page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    plain.pop("nikudMode", None)
    for ex in plain["exercises"]:
        if "answer" in ex: ex["answer"] = str(ex["answer"]).lower()
    STORY_WORDS = page.evaluate("(s) => Hebrew.countWords(s)", plain["story"])
    # The lines Dicta gets, with Dicta's nikud (the sample lesson's): [plain, vocalized, key]
    LINES = page.evaluate("""(lesson) => { const out = [];
      Review.slots(lesson, true).forEach(s => s.get().split('\\n').forEach(line => {
        const p = Hebrew.stripNikud(line).trim();
        if (p && Review.words(line).length) out.push([p, Hebrew.normalize(line).trim(), s.key]); }));
      return out; }""", sample)
    DICTA_TEXT = "\n".join(l[1] for l in LINES)
    # The other AI's nikud: Dicta's, except two words that read differently and a meteg (read the same).
    other = [l[1] for l in LINES]
    si = next(i for i, l in enumerate(LINES) if l[2] == "story")
    qi = next(i for i, l in enumerate(LINES) if l[2] == "exercises[0].question")
    w = other[si].split(" ")
    w[1] = "יַשׁ"                      # instead of יֵשׁ → marked
    w[3] = w[3][0] + "ֽ" + w[3][1:]    # a meteg only → not marked
    other[si] = " ".join(w)
    q = other[qi].split(" ")
    q[0] = "אַיךְ"                    # instead of אֵיךְ → marked
    other[qi] = " ".join(q)

    # ---------- Unit: parsing a chat's answer ----------
    parsed = page.evaluate("""() => [
      Review.parseManualNikud('הנה הטקסט:\\n```\\nשׁוּרָה א\\n\\nשׁוּרָה ב\\n```\\nבהצלחה!'),
      Review.parseManualNikud('```json\\n["א", "ב"]\\n```'),
      Review.parseManualNikud('```\\n1. א\\n2. ב\\n```'),
      Review.parseManualNikud('א\\nב')]""")
    check(parsed == [["שׁוּרָה א", "שׁוּרָה ב"], ["א", "ב"], ["א", "ב"], ["א", "ב"]],
          "answer parsing: the code block (text around it ignored, empty lines dropped), a JSON array, numbered lines, no block (%s)" % parsed)

    # ---------- Always there, also without a key ----------
    to_check_step(page, plain)
    check(page.is_visible("#secondManual summary") and "בלי מפתח" in page.text_content("#secondManual summary"),
          "no key: the manual second opinion is in the nikud part")
    page.click("#secondManual summary")
    page.click("#copySecondPrompt")
    check("קודם נקדו את הטקסט בדיקטה" in manual_msgs(page), "before Dicta: asks to vocalize with Dicta first")

    apply_dicta(page)
    page.wait_for_timeout(300)
    check(page.is_visible("#copySecondPrompt") and not api_calls, "after Dicta, no key: no automatic call, the manual way is there")
    # Headless Chrome's clipboard reads back empty: record what the page writes to it.
    page.evaluate("navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }")
    page.click("#copySecondPrompt")
    page.wait_for_timeout(200)
    prompt = page.evaluate("window.__copied || ''")
    block = prompt.split("השורות:\n```\n")[1].split("\n```")[0] if "השורות:\n```\n" in prompt else ""
    check(block.split("\n") == [l[0] for l in LINES], "prompt: the same lines as sent to Dicta, without nikud, in a code block (%d lines)" % len(LINES))
    check("הוסף רק סימני ניקוד. אל תשנה אף אות, אף סימן פיסוק, אף רווח ואף מילה." in prompt and ("%d שורות בדיוק" % len(LINES)) in prompt
          and "בתוך בלוק קוד אחד" in prompt and "בכתיב מלא" in prompt, "prompt: full nikud only, change nothing, N lines in the same order, one code block")

    # ---------- Lines count differs ----------
    compare(page, "```\n" + "\n".join(other[:-1]) + "\n```")
    m = manual_msgs(page)
    check(("מספר השורות לא תואם: שלחנו %d שורות, ובתשובה %d." % (len(LINES), len(LINES) - 1)) in m and ("ההבדל הראשון בשורה %d" % len(LINES)) in m,
          "a missing line: clear error with the first line that differs")
    check(not marks(page) and not page.is_visible("#secondMsgs .second-status"), "nothing compared")

    # ---------- Letters differ in every line ----------
    compare(page, "```\n" + "\n".join("א" + l for l in other) + "\n```")
    check("האותיות בתשובה שונות מהטקסט ששלחנו בכל השורות" in manual_msgs(page) and "ההבדל הראשון בשורה 1" in manual_msgs(page),
          "letters changed everywhere: error with the first line")

    # ---------- The answer, with text around the block ----------
    compare(page, "בטח! הנה הטקסט המנוקד:\n```\n" + "\n".join(other) + "\n```\nאם תרצי עוד משהו, אני כאן.")
    status = page.text_content("#secondMsgs")
    check("2 מילים לבדיקה" in status and "דיקטה והבינה ניקדו" in status and not manual_msgs(page).strip(),
          "compared: two words read differently, 'דיקטה והבינה' (%s)" % status)
    page.click("#secondMsgs button:has-text('לתצוגה המקדימה')")
    got = marks(page)
    check(len(got) == 2 and page.evaluate("Hebrew.stripNikud(document.querySelector('#preview .nikud-check').textContent)") == "יש",
          "orange marks in the preview, as with the automatic check (%s)" % got)
    page.click("#preview .nikud-check >> nth=0")
    labels = page.eval_on_selector_all("#nikudCheckDialog .pick-label", "els => els.map(e => e.textContent)")
    check(labels == ["דיקטה", "הבינה"], "the choice dialog: דיקטה or הבינה (%s)" % labels)
    page.click("#nikudCheckDialog .pick:has-text('הבינה')")
    page.wait_for_timeout(700)  # the draft is saved 400 ms after a change
    check(len(marks(page)) == 1 and "יַשׁ" in page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.story"),
          "choosing the other AI's word: the lesson takes it, one mark left")
    check(page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).second.source") == "manual", "the draft keeps where the marks came from")

    # ---------- Letters differ in one line: the rest is compared ----------
    page.click("#steps li[data-step='5']")
    page.click("#secondManual summary") if not page.evaluate("document.getElementById('secondManual').open") else None
    bad = list(other)
    bad[qi] = bad[qi] + " נוסף"
    # bad[si] stays as other[si]: the lesson now has that line's marked word as the other AI wrote it (chosen above)
    compare(page, "```\n" + "\n".join(bad) + "\n```")
    m = manual_msgs(page)
    check("הבינה שינתה אותיות או מילים בשורה אחת; השורות האלה לא נבדקו." in m and ("ההבדל הראשון בשורה %d" % (qi + 1)) in m,
          "a line with other words: a warning naming it, the other lines compared (%s)" % m[:120])
    check("לא נמצא" not in page.text_content("#secondMsgs") and "ניקדה כמו דיקטה" in page.text_content("#secondMsgs"),
          "the other lines read the same: 'הבינה ניקדה כמו דיקטה' (%s)" % page.text_content("#secondMsgs"))
    ctx.close()

    # ---------- The automatic check fails (quota): the manual way right away ----------
    ctx, page = new_page(browser, key=KEY)
    to_check_step(page, plain)
    apply_dicta(page)
    page.wait_for_function("() => /לא רצה/.test(document.getElementById('secondMsgs').textContent)", timeout=15000)
    check(api_calls and page.evaluate("document.getElementById('secondManual').open") and page.is_visible("#copySecondPrompt"),
          "quota (429): the manual second opinion opens by itself")
    status = page.text_content("#secondMsgs")
    check("נסה שוב" in status and "אפשר לבדוק ידנית בכל צ׳אט, בלי מפתח ובלי מכסה" in status and "המכסה" in status,
          "the failure says why, keeps '↻ נסה שוב', and offers the manual way")
    page.click("#step5 [data-go='4']")
    page.click("#preview .second-status button:has-text('לבדיקה הידנית')", timeout=5000)
    page.wait_for_timeout(300)
    check(page.is_visible("#step5") and page.is_visible("#copySecondPrompt"), "from the preview, 'לבדיקה הידנית' opens it in the check step")
    compare(page, "```\n" + "\n".join(other) + "\n```")
    check("2 מילים לבדיקה" in page.text_content("#secondMsgs"), "the manual answer replaces the failed automatic check")
    ctx.close()

    check(not errors, "no page errors (%s)" % errors[:3])
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
