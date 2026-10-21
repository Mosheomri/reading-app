"""Nikud after Dicta: text that comes in later (an approved suggestion, an edit) or words Dicta left without nikud
go to Dicta again, only their lines, automatically inside the next click when the bridge is known. Messages that
fit the stage; copy / paste of only those lines without the bridge; a change that keeps every word vocalized keeps
the nikud valid; with a Gemini key, the second opinion checks only those lines. Dicta and Gemini are mocks
(Playwright routing: nothing goes to the network)."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
DICTA = "https://nakdan.dicta.org.il/"
API = "https://generativelanguage.googleapis.com/"
KEY = "AIzaTEST-key-1234"
SCRIPT = open(os.path.join(ROOT, "userscripts", "dicta-bridge.user.js"), encoding="utf-8").read()
MOCK_DICTA = open(os.path.join(ROOT, "tests", "fixtures", "dicta-mock.html"), encoding="utf-8").read()
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
gemini_log = []

def serve_file(route):
    path = unquote(urlparse(route.request.url).path)[len("/reading-app/"):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, path))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = "application/javascript" if full.endswith(".js") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def gemini(route):
    """Only the second opinion is called here: the lines back as they are."""
    req = route.request
    if req.method == "OPTIONS":
        route.fulfill(status=204, headers=CORS); return
    prompt = json.loads(req.post_data)["contents"][0]["parts"][0]["text"]
    lines = json.loads(prompt.split("השורות:\n", 1)[1])
    gemini_log.append(lines)
    ev = {"candidates": [{"content": {"parts": [{"text": json.dumps({"lines": lines}, ensure_ascii=False)}]}, "finishReason": "STOP"}]}
    route.fulfill(status=200, body="data: " + json.dumps(ev, ensure_ascii=False) + "\r\n\r\n",
                  headers=dict(CORS, **{"Content-Type": "text/event-stream"}))

def new_context(browser):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    ctx.route(API + "**", gemini)
    ctx.route(DICTA + "**", lambda r: r.fulfill(status=200, body=MOCK_DICTA, headers={"Content-Type": "text/html; charset=utf-8"}))
    ctx.add_init_script("if (location.origin === 'https://nakdan.dicta.org.il') {" + SCRIPT + "}")
    ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(pg.url[:40] + ": " + str(e))))
    return ctx

def open_lesson(ctx, bridge=True, key=None):
    """A pasted lesson (copy-paste flow), in step 5. Records every text sent to Dicta in __sent."""
    page = ctx.new_page()
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    if bridge: page.evaluate("localStorage.setItem('readingApp.dictaBridge', '1')")
    if key: page.evaluate("(k) => localStorage.setItem('readingApp.geminiKey', k)", key)
    page.reload()
    page.evaluate("""() => { window.__sent = []; const start = DictaBridge.start;
      DictaBridge.start = (text, h) => { __sent.push(text); return start(text, h); }; }""")
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", str(STORY_WORDS))
    page.check("input[name=nikud][value=full]")
    page.check("input[name=wordsMode][value=number]")
    page.fill("#wordCount", str(len(sample["targetWords"])))
    page.evaluate("""() => { const c = {mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 0, message: 0};
      for (const k in c) { const i = document.querySelector('[data-count="' + k + '"]'); i.value = c[k]; i.dispatchEvent(new Event('input')); } }""")
    page.click("#makePrompt")
    page.click("#step2 [data-go='3']")
    page.fill("#response", LESSON_JSON)
    page.click("#parseBtn")
    page.click("#makeLink")
    return page

def dicta_click(page, selector):
    """A click that opens Dicta (the bridge mock); waits until the nikud message is there."""
    with page.expect_popup():
        page.click(selector)
    page.wait_for_function("() => /✓|לא תואם|שונה באותיות/.test(document.querySelector('#nikudMsgs').textContent)", timeout=20000)

def nikud_msgs(page): return page.text_content("#nikudMsgs") or ""

def draft(page):
    page.wait_for_timeout(600)
    return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")

def story_line(page, i):
    return page.evaluate("(i) => JSON.parse(localStorage.getItem('readingApp.draft')).lesson.story.split('\\n')[i]", i)

def review(page, items):
    page.click("#makeReviewPrompt")
    page.fill("#reviewResponse", json.dumps(items, ensure_ascii=False))
    page.click("#parseReview")

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    tmp = browser.new_page()
    tmp.route("**/*", lambda r: serve_file(r) if r.request.url.startswith(SITE) else r.abort())
    tmp.goto(SITE + "index.html")
    plain = json.loads(tmp.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    STORY_WORDS = tmp.evaluate("(s) => Hebrew.countWords(s)", plain["story"])
    tmp.close()
    LESSON_JSON = json.dumps(plain, ensure_ascii=False)
    first_line = plain["story"].split("\n")[0]          # לדני יש כלב קטן. לכלב קוראים בוני.
    SUGGESTION = [{"field": "story", "type": "style", "original": "כלב קטן", "fix": "כלב קטן ושמח", "reason": "ניסוח"}]

    # ---------- A suggestion approved after the nikud: only its line goes to Dicta, in the same click ----------
    ctx = new_context(browser)
    page = open_lesson(ctx)
    dicta_click(page, "#autoNikud")
    check(page.evaluate("__sent.length") == 1 and page.evaluate("__sent[0].split('\\n').length") > 10 and "הטקסט" not in nikud_msgs(page)[:0],
          "first Dicta run: the whole text")
    review(page, SUGGESTION)
    check("תנוקד שוב בדיקטה (רק השורות שהשתנו)" in page.text_content("#reviewList"), "the suggestion's note says its line will be vocalized again")
    with page.expect_popup():
        page.click("#reviewList button:has-text('אשר')")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('דיקטה ניקדה')", timeout=20000)
    sent = page.evaluate("__sent")
    check(len(sent) == 2 and sent[1] == first_line.replace("כלב קטן", "כלב קטן ושמח"),
          "after the last decision (a click): Dicta gets only the changed line (%d runs, last %s)" % (len(sent), sent[-1:]))
    m = nikud_msgs(page)
    check("את השורה שהשתנתה" in m and "✓" in m, "message: Dicta vocalized the line that changed (%s)" % m[:80])
    d = draft(page)
    check("שמח" not in d["lesson"]["story"] and page.evaluate("(s) => Hebrew.stripNikud(s)", d["lesson"]["story"]).count("כלב קטן ושמח") == 1
          and page.evaluate("(s) => !Hebrew.isUnvocalized(s)", d["lesson"]["story"].split("\n")[0].split(" ")[4]),
          "the new words have nikud now")
    check(page.evaluate("(l) => Lesson.unvocalizedWords(l).length", d["lesson"]) == 0 and d["nikudVerified"] is not None,
          "no word without nikud is left; the nikud counts as done")
    page.click("#toLink")
    check(page.is_visible("#step6"), "a link can be made")
    ctx.close()

    # ---------- An edit in step 4 after the nikud: vocalized when going on to the check step ----------
    ctx = new_context(browser)
    page = open_lesson(ctx)
    dicta_click(page, "#autoNikud")
    page.click("#steps li[data-step='4']")
    page.evaluate("""() => { const ta = [...document.querySelectorAll('#step4 textarea')].find(t => t.value.length > 100);
      const lines = ta.value.split('\\n'); lines[2] = lines[2] + ' הכלב שמח מאוד.'; ta.value = lines.join('\\n');
      ta.dispatchEvent(new Event('input')); }""")
    page.wait_for_timeout(400)
    note = page.text_content("#checkMsgs")
    check("שנוספו אחרי הניקוד" in note and "במעבר לשלב הבדיקה" in note, "preview: the words without nikud were added after the nikud, and when they get it (%s)" % note[:90])
    dicta_click(page, "#makeLink")
    sent = page.evaluate("__sent")
    check(len(sent) == 2 and sent[1].endswith("הכלב שמח מאוד.") and "\n" not in sent[1], "going on to the check step: only the edited line goes to Dicta")
    check("דיקטה ניקדה את השורה שהשתנתה" in nikud_msgs(page), "message fits: the changed line was vocalized")
    # A change that keeps every word vocalized (a word deleted): the nikud stays valid, Dicta is not needed
    page.click("#steps li[data-step='4']")
    page.evaluate("""() => { const ta = [...document.querySelectorAll('#step4 textarea')].find(t => t.value.length > 100);
      ta.value = ta.value.replace(/ \\S+$/, ''); ta.dispatchEvent(new Event('input')); }""")
    page.wait_for_timeout(400)
    dicta_click(page, "#makeLink")
    sent = page.evaluate("__sent")
    page.click("#toLink")
    check(len(sent) == 3 and "\n" not in sent[2] and page.is_visible("#step6"),
          "a word deleted after the nikud: its line (only) is checked by Dicta again, then the link")
    # An edit undone: nothing changed since Dicta, the nikud is valid again
    page.click("#steps li[data-step='4']")
    page.evaluate("""() => { const ta = [...document.querySelectorAll('#step4 textarea')].find(t => t.value.length > 100);
      const v = ta.value; ta.value = v + ' x'; ta.dispatchEvent(new Event('input')); ta.value = v; ta.dispatchEvent(new Event('input')); }""")
    page.wait_for_timeout(400)
    page.click("#makeLink")
    page.click("#toLink")
    check(page.is_visible("#step6") and page.evaluate("__sent.length") == 3, "an edit undone: no Dicta run, link made")
    ctx.close()

    # ---------- Without the bridge: the message says what to do; copy and paste only those lines ----------
    ctx = new_context(browser)
    page = open_lesson(ctx, bridge=False)
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=SITE[:-len("reading-app/")])
    vocal = page.evaluate("() => { const l = Review.slots(JSON.parse(document.getElementById('response').value), true); return null; }")
    full = page.evaluate("""() => Review.plainText(JSON.parse(document.getElementById('response').value))""")
    vocalized = page.evaluate("(t) => t.replace(/[\\u05D0-\\u05EA]/g, c => c + '\\u05B8')", full)
    page.fill("#dictaText", vocalized)
    page.click("#compareNikud")
    review(page, SUGGESTION)
    page.click("#reviewList button:has-text('אשר')")
    page.wait_for_timeout(300)
    m = nikud_msgs(page)
    check("הטקסט השתנה אחרי הניקוד (שורה אחת)" in m and "רק השורות שהשתנו" in m and page.evaluate("__sent.length") == 0,
          "no bridge: a message that fits the stage (one line, copy only it), nothing opened (%s)" % m[:100])
    page.click("#copyPlain")
    page.wait_for_timeout(300)
    check("רק השורות שצריך לנקד (1)" in (page.text_content(".toast") or ""), "copy: only the line that needs nikud")
    line = first_line.replace("כלב קטן", "כלב קטן ושמח")
    page.fill("#dictaText", page.evaluate("(t) => t.replace(/[\\u05D0-\\u05EA]/g, c => c + '\\u05B8')", line))
    page.click("#compareNikud")
    check("דיקטה ניקדה את השורה שהשתנתה" in nikud_msgs(page) and page.evaluate("(l) => Lesson.unvocalizedWords(l).length", draft(page)["lesson"]) == 0,
          "paste of that line: its words get the nikud (%s)" % nikud_msgs(page)[:80])
    ctx.close()

    # ---------- Words Dicta left without nikud: listed; the button sends only their lines ----------
    ctx = new_context(browser)
    page = open_lesson(ctx)
    full = page.evaluate("""() => Review.plainText(JSON.parse(document.getElementById('response').value))""")
    lines = full.split("\n")
    voc = [page.evaluate("(t) => t.replace(/[\\u05D0-\\u05EA]/g, c => c + '\\u05B8')", l) for l in lines]
    story_idx = lines.index(first_line)
    voc[story_idx] = first_line  # Dicta left this line without nikud
    page.fill("#dictaText", "\n".join(voc))
    page.click("#compareNikud")
    m = nikud_msgs(page)
    check("דיקטה לא ניקדה" in m and "לדני" in m, "words Dicta left without nikud are listed (%s)" % m[-90:])
    dicta_click(page, "#autoNikud")
    sent = page.evaluate("__sent")
    check(sent == [first_line], "the button sends only their line (%s)" % sent)
    check("דיקטה לא ניקדה" not in nikud_msgs(page), "now every word has nikud")
    ctx.close()

    # ---------- With a Gemini key: the second opinion checks only the changed line ----------
    ctx = new_context(browser)
    page = open_lesson(ctx, key=KEY)
    dicta_click(page, "#autoNikud")
    page.wait_for_function("() => /Gemini ניקד|לבדיקה|לא רצה/.test(document.querySelector('#secondMsgs').textContent)", timeout=10000)
    n_full = len(gemini_log[-1])
    review(page, SUGGESTION)
    with page.expect_popup():
        page.click("#reviewList button:has-text('אשר')")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('דיקטה ניקדה')", timeout=20000)
    page.wait_for_timeout(800)
    check(n_full > 10 and gemini_log[-1] == [first_line.replace("כלב קטן", "כלב קטן ושמח")],
          "second opinion: the whole text first, then only the changed line (%d lines, then %s)" % (n_full, gemini_log[-1]))
    ctx.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
