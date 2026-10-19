"""The logo: teacher page, setup pages, print sheet and the child's finish screen; loaded, with alt text,
fitting phone screens, and ready before the print dialog."""
import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8785
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

LOGO_INFO = """(sel) => { const i = document.querySelector(sel); if (!i) return null; const r = i.getBoundingClientRect();
  return { loaded: i.complete && i.naturalWidth > 0, src: i.getAttribute('src'), alt: i.alt, w: r.width, h: r.height,
           left: r.left, right: r.right, vw: innerWidth, scrollW: document.documentElement.scrollWidth }; }"""

size = os.path.getsize(os.path.join(ROOT, "assets", "logo-web.png"))
check(size < 60000, "web logo is small (%d KB; the original stays in assets/logo.png)" % (size // 1024))

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    for vw in [1300, 390, 320]:
        ctx = browser.new_context(viewport={"width": vw, "height": 800})
        ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(str(e))))
        page = ctx.new_page()
        for url in ["index.html", "dicta-setup.html", "gemini-setup.html"]:
            page.goto(BASE + url)
            page.wait_for_load_state("load")
            L = page.evaluate(LOGO_INFO, ".site-head .site-logo")
            ok = L and L["loaded"] and L["src"] == "assets/logo-web.png" and "צועדים קדימה" in L["alt"]
            fits = L and L["left"] >= 0 and L["right"] <= L["vw"] and L["w"] <= 300.5 and L["h"] > 40 and L["scrollW"] <= L["vw"]
            check(ok and fits, "%s at %dpx: logo loaded, alt text, fits (%dx%d)" % (url, vw, L["w"] if L else 0, L["h"] if L else 0))
            if vw == 390: page.screenshot(path=os.path.join(OUT, "logo-%s-390.png" % url.split(".")[0]))
        # The setup pages' logo leads back to the teacher page
        check(page.get_attribute(".site-head a", "href") == "index.html", "setup page logo links to the teacher page (%dpx)" % vw)

        # Child finish screen
        child = ctx.new_page()
        child.goto(BASE + "play.html")
        h = child.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", sample)
        child.goto(BASE + "play.html#" + h)
        child.reload()
        child.wait_for_selector("text=מתחילים ▶")
        child.click("text=מתחילים ▶")
        for _ in range(20):
            if child.locator(".stars").count(): break
            child.click("#navNext")
        child.wait_for_timeout(300)
        F = child.evaluate(LOGO_INFO, "#stage .finish-logo")
        check(F and F["loaded"] and "צועדים קדימה" in F["alt"] and F["w"] <= 160.5 and F["right"] <= F["vw"] and F["scrollW"] <= F["vw"],
              "finish screen at %dpx: small logo (%dx%d)" % (vw, F["w"] if F else 0, F["h"] if F else 0))
        child.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        child.wait_for_timeout(100)
        clear = child.evaluate("document.querySelector('#stage .finish-logo').getBoundingClientRect().bottom <= document.querySelector('#nav').getBoundingClientRect().top")
        check(clear, "finish screen at %dpx: logo not hidden behind the navigation bar" % vw)
        if vw == 390: child.screenshot(path=os.path.join(OUT, "logo-finish-390.png"), full_page=True)
        ctx.close()

    # ---------- Print sheet ----------
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    page = ctx.new_page()
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()
    page.set_input_files("#loadJsonInput", os.path.join(ROOT, "samples", "sample-lesson.json"))
    page.wait_for_selector("#step4:not([hidden])")
    page.click("#makeLink")
    page.click("#toLink")
    # Record whether the logo was ready when the print dialog was asked for.
    page.evaluate("""() => { window.__printed = null; window.print = () => {
      const i = document.querySelector('#printArea .p-logo'); window.__printed = !!(i && i.complete && i.naturalWidth > 0); }; }""")
    page.click("#printBtn")
    page.wait_for_function("() => window.__printed !== null", timeout=5000)
    check(page.evaluate("__printed") is True, "print: the logo is loaded before the print dialog opens")
    check(page.evaluate("document.querySelector('#printArea .print-sheet').firstElementChild.classList.contains('p-logo')"), "print: logo at the top of the sheet")
    page.emulate_media(media="print")
    page.wait_for_timeout(200)
    w = page.evaluate("document.querySelector('#printArea .p-logo').getBoundingClientRect().width")
    check(170 < w < 190, "print: logo about 48 mm wide (%d px)" % w)
    page.pdf(path=os.path.join(OUT, "logo-print.pdf"), format="A4")
    ctx.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
