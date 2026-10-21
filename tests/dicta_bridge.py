"""Automatic nikud through Dicta (userscripts/dicta-bridge.user.js + js/dicta.js), against a mock Dicta page.
Nothing goes to the network: the site is served at its real addresses (GitHub Pages, localhost:8000) and Dicta's
address serves tests/fixtures/dicta-mock.html, through Playwright routing. The userscript is injected the way
Tampermonkey would run it (only on Dicta's address), with shorter timeouts.
Run against the real Dicta site: python tests/dicta_bridge.py --live (one manual-style check, a few requests)."""
import json, sys, os, re, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
SITE = "https://mosheomri.github.io/reading-app/"
LOCAL = "http://localhost:8000/"
DICTA = "https://nakdan.dicta.org.il/"
EVIL = "https://evil.example/"
LIVE = "--live" in sys.argv

sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
SCRIPT = open(os.path.join(ROOT, "userscripts", "dicta-bridge.user.js"), encoding="utf-8").read()
MOCK = open(os.path.join(ROOT, "tests", "fixtures", "dicta-mock.html"), encoding="utf-8").read()
QAMATS, SHEVA = chr(0x05B8), chr(0x05B0)  # the mock marks every letter: qamats = modern + ktiv male

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []
mock = {"mode": "normal"}

def serve_file(route, base):
    path = unquote(urlparse(route.request.url).path)
    rel = path[len(urlparse(base).path):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else "")})

def serve_dicta(route):
    html = MOCK.replace("<body>", "<body><script>window.MOCK_MODE = %s;</script>" % json.dumps(mock["mode"]), 1)
    route.fulfill(status=200, body=html, headers={"Content-Type": "text/html; charset=utf-8"})

EVIL_PAGE = """<!doctype html><meta charset="utf-8"><title>evil</title><script>
window.got = [];
window.addEventListener('message', e => got.push(e.data));
</script>"""

def test_script(element_ms=2000, part_ms=5000):
    s = SCRIPT.replace("var ELEMENT_TIMEOUT = 15000;", "var ELEMENT_TIMEOUT = %d;" % element_ms)
    s = s.replace("var PART_TIMEOUT = 30000;", "var PART_TIMEOUT = %d;" % part_ms)
    assert s != SCRIPT
    # Tampermonkey runs the script only where @match says.
    return "if (location.origin === 'https://nakdan.dicta.org.il') {\n" + s + "\n}"

def new_context(browser, with_script=True, **script_opts):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())  # nothing else leaves the machine (fonts included)
    ctx.route(SITE + "**", lambda r: serve_file(r, SITE))
    ctx.route(LOCAL + "**", lambda r: serve_file(r, LOCAL))
    ctx.route(DICTA + "**", serve_dicta)
    ctx.route(EVIL + "**", lambda r: r.fulfill(status=200, body=EVIL_PAGE, headers={"Content-Type": "text/html; charset=utf-8"}))
    if with_script: ctx.add_init_script(test_script(**script_opts))
    ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(pg.url[:40] + ": " + str(e))))
    return ctx

plain_path = os.path.join(OUT, "plain-lesson-bridge.json")

def teacher(ctx, base=SITE, ready_ms=None):
    """Teacher page on the check step with an unvocalized lesson."""
    page = ctx.new_page()
    page.goto(base + "index.html")
    page.evaluate("localStorage.clear()")
    if not os.path.exists(plain_path):
        open(plain_path, "w", encoding="utf-8").write(page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    page.reload()
    page.set_input_files("#loadJsonInput", plain_path)
    page.wait_for_selector("#step4:not([hidden])")
    page.click("#makeLink")
    page.wait_for_selector("#step5:not([hidden])")
    if ready_ms: page.evaluate("(ms) => { DictaBridge.config.readyTimeout = ms; }", ready_ms)
    return page

def draft(page):
    page.wait_for_timeout(600)
    return page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")

def plain_text(page):
    return page.evaluate("(l) => Review.plainText(Lesson.coerce(l).lesson)", draft(page)["lesson"])

def auto_msgs(page): return page.text_content("#autoNikudMsgs") or ""
def nikud_msgs(page): return page.text_content("#nikudMsgs") or ""

def run_live(browser):
    """One check against the real Dicta site, with a short text (Dicta's page sends a request per word).
    The script is injected the way Tampermonkey runs it; the site itself is served from this folder."""
    text = "\n".join(["הילד הלך לגן.", "הוא שיחק עם הכלב בוני ליד העץ הגדול!"])
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route(SITE + "**", lambda r: serve_file(r, SITE))
    ctx.add_init_script("if (location.origin === 'https://nakdan.dicta.org.il') {" + SCRIPT + "}")
    sent = []
    ctx.on("request", lambda r: sent.append(r.post_data or "") if "loadbalancer.dicta.org.il" in r.url and r.method == "POST" else None)
    page = ctx.new_page()
    page.goto(SITE + "index.html")
    with page.expect_popup() as pop:
        page.evaluate("""(t) => { window.__bridge = {status: [], result: null, fail: null};
          DictaBridge.start(t, { status: (k) => __bridge.status.push(k), result: (r) => { __bridge.result = r; },
                                 fail: (r, m) => { __bridge.fail = r + ': ' + m; } }); }""", text)
    popup = pop.value
    page.wait_for_function("() => __bridge.result !== null || __bridge.fail !== null", timeout=90000)
    b = page.evaluate("__bridge")
    print("result:", b["result"]); print("fail:", b["fail"])
    check(b["fail"] is None and b["result"], "live: a result came back")
    res = b["result"] or ""
    check(page.evaluate("(r) => Hebrew.stripNikud(r)", res) == text, "live: same letters and lines as sent")
    n = page.evaluate("(r) => Hebrew.tokenize(r).filter(t => t.isWord)", res)
    check(all(page.evaluate("(w) => Hebrew.hasNikud(w)", w["text"]) for w in n), "live: every word vocalized")
    full = [json.loads(d) for d in sent if d.startswith("{") and json.loads(d).get("data") == text]
    check(full and all(d.get("genre") == "modern" and d.get("keepqq") is True for d in full),
          "live: Dicta asked with modern style and ktiv male (genre=modern, keepqq=true): %s" % [(d.get("genre"), d.get("keepqq")) for d in full])
    page.wait_for_timeout(1000)
    check(popup.is_closed(), "live: Dicta window closed by itself")
    print("requests to Dicta's API:", len(sent))
    ctx.close()

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    if LIVE:
        run_live(browser)
        browser.close()
        print("\n%d failures" % len(fails)); sys.exit(1 if fails else 0)

    # ---------- Files and links ----------
    meta = dict(re.findall(r"^// @(\w+)\s+(.+?)\s*$", SCRIPT, re.M))
    url = "https://mosheomri.github.io/reading-app/userscripts/dicta-bridge.user.js"
    check(meta.get("match") == "https://nakdan.dicta.org.il/*" and meta.get("updateURL") == url and meta.get("downloadURL") == url,
          "userscript header: @match Dicta, @updateURL/@downloadURL on GitHub Pages")
    check(re.search(r"var ALLOWED = \['https://mosheomri\.github\.io', 'http://localhost:8000'\];", SCRIPT) is not None, "userscript talks only to the site's origins")
    sel_block = SCRIPT[SCRIPT.index("var SEL = {"):SCRIPT.index("};", SCRIPT.index("var SEL = {"))]
    body = SCRIPT[SCRIPT.index("};", SCRIPT.index("var SEL = {")):]
    check(all(s not in body for s in ["'#input-textarea'", "'#nikud-text'", "fa-gear", '"maleh"', '"modern"']) and "'#input-textarea'" in sel_block,
          "all Dicta selectors are in the SEL block at the top")

    # ---------- Normal run (GitHub Pages origin) ----------
    ctx = new_context(browser)
    page = teacher(ctx)
    check(page.is_visible("#autoNikud") and page.text_content("#autoNikud").strip() == "✨ נקד אוטומטית בדיקטה", "check step: auto nikud button")
    check(page.get_attribute("#nikudPart a[href='dicta-setup.html']", "target") == "_blank", "setup instructions linked next to the button")
    plain = plain_text(page)
    n_words = page.evaluate("(t) => Hebrew.countWords(t)", plain)
    with page.expect_popup() as pop:
        page.click("#autoNikud")
    popup = pop.value
    popup.wait_for_load_state()
    check(popup.url == DICTA, "Dicta opened in a new window")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('הוחל על')", timeout=15000)
    check("הניקוד של דיקטה הוחל על %d מילים" % n_words in nikud_msgs(page), "result applied like a manual paste (%s)" % nikud_msgs(page))
    page.wait_for_timeout(600)
    check(popup.is_closed(), "Dicta window closed by itself")
    L = draft(page)["lesson"]
    check(QAMATS in L["story"] and SHEVA not in L["story"] and QAMATS in L["title"] and QAMATS in L["exercises"][0]["question"],
          "Dicta was set to modern style + ktiv male before vocalizing (mock marks it with qamats)")
    check(page.evaluate("(t) => Hebrew.stripNikud(t)", page.input_value("#dictaText")) == plain, "the vocalized text is shown in the paste box")
    check(not page.is_disabled("#autoNikud") and auto_msgs(page).strip() == "", "button enabled again, no leftover status")
    page.click("#toLink")
    check(page.is_visible("#step6"), "link allowed after automatic nikud")
    page.screenshot(path=os.path.join(OUT, "db1-done.png"))

    # ---------- Slow Dicta: status shown, waits for the full result ----------
    mock["mode"] = "slow"
    page.click("#steps li[data-step='4']")
    story = page.locator("#editor textarea")
    story.fill(page.evaluate("(s) => Hebrew.stripNikud(s)", story.input_value()))
    page.wait_for_timeout(400)
    # Text changed after the nikud: going on to the check step sends the changed lines to Dicta (in that click)
    with page.expect_popup() as pop:
        page.click("#makeLink")
    popup = pop.value
    page.wait_for_function("() => document.querySelector('#autoNikudMsgs').textContent.includes('דיקטה מנקדת')", timeout=5000)
    check(page.is_disabled("#autoNikud"), "while working: status shown, button disabled")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('דיקטה ניקדה')", timeout=15000)
    st = draft(page)["lesson"]["story"]
    unvoc = page.evaluate("(s) => Hebrew.tokenize(s).filter(t => t.isWord && !Hebrew.hasNikud(t.text)).length", st)
    check(unvoc == 0, "slow Dicta: the half-done update was not taken (%d words without nikud)" % unvoc)
    page.close()
    ctx.close()

    # ---------- Long text: split into parts of at most 5000 characters ----------
    mock["mode"] = "normal"
    ctx = new_context(browser)
    page = teacher(ctx)
    line = " ".join(["הילד הלך לגן עם הכלב הגדול"] * 40)  # ~1000 characters per line
    long_text = "\n".join([line] * 9) + "\n" + " ".join([line] * 6)  # 9 short lines, then one line of ~6000
    check(len(long_text) > 14000, "test setup: long text (%d characters)" % len(long_text))
    page.evaluate("""(t) => { window.__bridge = {status: [], result: null, fail: null};
      DictaBridge.start(t, { status: (k, i) => __bridge.status.push(k + ':' + (i ? i.part + '/' + i.parts : '')),
                             result: (r) => { __bridge.result = r; }, fail: (r, m) => { __bridge.fail = r + ':' + m; } }); }""", long_text)
    page.wait_for_function("() => __bridge.result !== null || __bridge.fail !== null", timeout=30000)
    b = page.evaluate("__bridge")
    expected = "".join(c + QAMATS if "א" <= c <= "ת" else c for c in long_text)
    check(b["fail"] is None and b["result"] == expected, "long text: every part vocalized and joined back exactly (fail: %s)" % b["fail"])
    parts = [s for s in b["status"] if s.startswith("working:")]
    # 9 lines of ~1080 characters → 4 + 4 + 1 lines; the ~6500-character line → split at a space into 2 parts.
    check(parts and parts[-1] == "working:5/5" and "working:3/5" in parts, "long text: 5 parts of at most 5000 characters, progress reported (%s)" % parts[-3:])
    page.close()
    ctx.close()

    # ---------- Local development origin (localhost:8000) ----------
    ctx = new_context(browser)
    page = teacher(ctx, base=LOCAL)
    with page.expect_popup():
        page.click("#autoNikud")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('הוחל על')", timeout=15000)
    check(True, "works from http://localhost:8000")
    ctx.close()

    # ---------- Script not installed: message after the ready timeout, manual flow still there ----------
    ctx = new_context(browser, with_script=False)
    page = teacher(ctx, ready_ms=1500)
    with page.expect_popup() as pop:
        page.click("#autoNikud")
    popup = pop.value
    # Messages that do not come from Dicta's window and origin are ignored.
    page.evaluate("""() => { window.postMessage({source: 'dicta-bridge', type: 'ready'}, '*');
                             window.postMessage({source: 'dicta-bridge', type: 'result', text: 'x'}, '*'); }""")
    page.wait_for_function("() => document.querySelector('#autoNikudMsgs').textContent.includes('לא מותקן')", timeout=5000)
    m = auto_msgs(page)
    check("לא מותקן" in m and "ידנית" in m and page.locator("#autoNikudMsgs a[href='dicta-setup.html']").count() == 1,
          "no script: 'not installed' message with a link to the instructions and the manual way")
    check(page.input_value("#dictaText") == "" and "הוחל" not in nikud_msgs(page), "messages from another origin/window were ignored")
    check(not popup.is_closed(), "no script: Dicta window left open for manual use")
    vocalized = page.evaluate("(t) => [...t].map(c => c >= 'א' && c <= 'ת' ? c + '\\u05B8' : c).join('')",
                              plain_text(page))
    page.fill("#dictaText", vocalized)
    page.click("#compareNikud")
    check("הוחל על" in nikud_msgs(page), "manual paste still works")
    page.screenshot(path=os.path.join(OUT, "db2-missing.png"))

    # Popup blocked
    page.evaluate("window.open = () => null")
    page.click("#autoNikud")
    check("חסם" in auto_msgs(page) and "ידנית" in auto_msgs(page) and not page.is_disabled("#autoNikud"), "popup blocked: clear message, manual way")
    ctx.close()

    # ---------- Failures in the middle ----------
    for mode, expect, label in [("never", "לא החזירה ניקוד בזמן", "Dicta never vocalizes"),
                                ("nogear", "כפתור ההגדרות", "settings button missing (Dicta changed)")]:
        mock["mode"] = mode
        ctx = new_context(browser)
        page = teacher(ctx)
        with page.expect_popup() as pop:
            page.click("#autoNikud")
        popup = pop.value
        page.wait_for_function("() => document.querySelector('#autoNikudMsgs').textContent.includes('נכשל')", timeout=15000)
        m = auto_msgs(page)
        check(expect in m and "ידנית" in m and not page.is_disabled("#autoNikud"), "%s: clear error, back to manual (%s)" % (label, m))
        check(not popup.is_closed() and not page.evaluate("(s) => Hebrew.hasNikud(s)", draft(page)["lesson"]["story"]),
              "%s: lesson unchanged, Dicta window left open" % label)
        ctx.close()

    # Teacher closes the Dicta window in the middle
    mock["mode"] = "slow"
    ctx = new_context(browser)
    page = teacher(ctx)
    with page.expect_popup() as pop:
        page.click("#autoNikud")
    page.wait_for_function("() => document.querySelector('#autoNikudMsgs').textContent.includes('דיקטה מנקדת')", timeout=5000)
    pop.value.close()
    page.wait_for_function("() => document.querySelector('#autoNikudMsgs').textContent.includes('נסגר')", timeout=5000)
    check("ידנית" in auto_msgs(page), "Dicta window closed by hand: message, back to manual")
    ctx.close()

    # ---------- The script talks only to the site ----------
    mock["mode"] = "normal"
    ctx = new_context(browser)
    evil = ctx.new_page()
    evil.goto(EVIL + "index.html")
    with evil.expect_popup() as pop:
        evil.evaluate("window.w = window.open('" + DICTA + "', 'd')")
    popup = pop.value
    popup.wait_for_selector("#input-textarea")
    evil.wait_for_timeout(1500)
    evil.evaluate("w.postMessage({source: 'reading-app', type: 'nikud', id: 'x', text: 'שלום לכם'}, '*')")
    evil.wait_for_timeout(1500)
    check(evil.evaluate("got.length") == 0, "another site opening Dicta gets no messages (no 'ready')")
    check(popup.input_value("#input-textarea") == "" and not popup.is_closed(), "the script ignores requests from another site")
    # Opened directly (no opener): the script does nothing
    direct = ctx.new_page()
    direct.goto(DICTA)
    direct.wait_for_timeout(1200)
    check(direct.input_value("#input-textarea") == "" and direct.locator("#menuHost *").count() == 0, "Dicta opened directly: script does nothing")
    ctx.close()

    # ---------- Setup page ----------
    ctx = new_context(browser, with_script=False)
    page = ctx.new_page()
    page.goto(SITE + "dicta-setup.html")
    t = page.text_content("body")
    check(all(s in t for s in ["Tampermonkey", "chrome://extensions", "edge://extensions", "Allow User Scripts", "התקנה"]),
          "setup page: store, 'Allow User Scripts' in Chrome and Edge, install")
    check(page.get_attribute("#installLink", "href") == "userscripts/dicta-bridge.user.js", "setup page: install link to the script")
    check(page.locator("a[href*='chromewebstore.google.com']").count() == 1 and page.locator("a[href*='microsoftedge.microsoft.com']").count() == 1,
          "setup page: Chrome and Edge store links")
    served = page.evaluate("fetch('userscripts/dicta-bridge.user.js').then(r => r.ok ? r.text() : '')")
    check("==UserScript==" in served, "script served next to the site")
    page.screenshot(path=os.path.join(OUT, "db3-setup.png"), full_page=True)
    ctx.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
