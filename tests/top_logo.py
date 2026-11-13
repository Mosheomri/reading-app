"""The logo in the child page's top bar: on every screen (start, games, reading, each exercise), small, still,
not a link, next to the mute button and progress bar, not taller than the bar, not covering the reading screen's
sticky controls or the bottom navigation, and not shrinking the story on a phone. The finish screen keeps its
own logo and hides the top one (one logo, not two). Screenshots: phone, tablet, desktop (tests/out/toplogo-*)."""
import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8803
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
ALT = "צועדים קדימה עם מיכל"

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

INFO = """() => {
  const i = document.getElementById('topLogo'), bar = document.querySelector('.topbar');
  const mute = document.getElementById('muteBtn'), prog = document.querySelector('.topbar .progress');
  const r = i.getBoundingClientRect(), m = mute.getBoundingClientRect(), p = prog.getBoundingClientRect();
  const cs = getComputedStyle(i);
  const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5;
  return {
    visible: !i.hidden && cs.display !== 'none' && r.width > 0,
    loaded: i.complete && i.naturalWidth > 0, src: i.getAttribute('src'), alt: i.alt,
    inBar: i.parentElement === bar, link: !!i.closest('a, button'), tabIndex: i.tabIndex,
    pointer: cs.pointerEvents, anim: cs.animationName, transition: cs.transitionProperty === 'all' && cs.transitionDuration !== '0s',
    w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, vw: innerWidth,
    barBottom: bar.getBoundingClientRect().bottom, barH: bar.getBoundingClientRect().height,
    clear: apart(r, m) && apart(r, p),
    midAligned: Math.abs((r.top + r.bottom) / 2 - (m.top + m.bottom) / 2) <= 2,
    scrollW: document.documentElement.scrollWidth,
    logos: [...document.querySelectorAll('img[src*="logo"]')].filter(x => x.getBoundingClientRect().width > 0).length,
  };
}"""

def screen_name(page):
    return page.evaluate("""() => document.querySelector('#stage .stars') ? 'finish'
      : document.querySelector('#stage .read-modes') ? 'reading'
      : document.querySelector('#stage .question') ? 'exercise' : 'game'""")

VIEWPORTS = [("phone", 390, 844), ("phone-small", 320, 640), ("tablet", 820, 1180), ("desktop", 1300, 900)]

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    for name, vw, vh in VIEWPORTS:
        phone = vw < 900
        ctx = browser.new_context(viewport={"width": vw, "height": vh}, has_touch=phone, is_mobile=vw < 500)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "play.html")
        h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", sample)
        page.goto(BASE + "play.html#" + h)
        page.reload()
        page.wait_for_selector("text=מתחילים ▶")
        page.wait_for_function("document.getElementById('topLogo').complete")

        def check_screen(label):
            L = page.evaluate(INFO)
            lo, hi = (36, 44) if phone and vw < 900 else (44, 56)
            check(L["visible"] and L["loaded"] and L["src"] == "assets/logo-web.png" and L["alt"] == ALT,
                  "%s %s: logo shown, loaded, alt \"%s\"" % (name, label, L["alt"]))
            check(lo <= L["h"] <= hi and L["w"] <= 160, "%s %s: small (%dx%d, height %d-%d)" % (name, label, L["w"], L["h"], lo, hi))
            check(L["inBar"] and L["clear"] and L["midAligned"], "%s %s: in the top bar, beside mute and progress, not overlapping" % (name, label))
            check(not L["link"] and L["tabIndex"] < 0 and L["pointer"] == "none", "%s %s: not a link, not focusable, not clickable" % (name, label))
            check(L["anim"] == "none" and not L["transition"], "%s %s: no animation" % (name, label))
            check(L["left"] >= 0 and L["right"] <= L["vw"] and L["scrollW"] <= L["vw"], "%s %s: fits, no sideways scroll" % (name, label))
            check(L["logos"] == 1, "%s %s: one logo on the screen (%d)" % (name, label, L["logos"]))
            if phone:
                # The bar is exactly as tall as without the logo (the 44px mute button sets it).
                without = page.evaluate("""() => { const i = document.getElementById('topLogo'); i.style.display = 'none';
                  const h = document.querySelector('.topbar').getBoundingClientRect().height; i.style.display = ''; return h; }""")
                check(abs(without - L["barH"]) < 0.5, "%s %s: top bar not taller with the logo (%d vs %d)" % (name, label, L["barH"], without))
            return L

        check_screen("start")
        page.screenshot(path=os.path.join(OUT, "toplogo-%s-start.png" % name))
        # Clicking where the logo is does not leave or change the screen.
        L = page.evaluate(INFO)
        url = page.url
        page.mouse.click(L["left"] + L["w"] / 2, L["top"] + L["h"] / 2)
        page.wait_for_timeout(200)
        check(page.url == url and page.locator("text=מתחילים ▶").count() == 1, "%s: a click on the logo stays on the screen" % name)

        page.click("text=מתחילים ▶")
        seen = {"game": 0, "reading": 0, "exercise": 0}
        for _ in range(30):
            page.wait_for_timeout(150)
            kind = screen_name(page)
            if kind == "finish": break
            seen[kind] += 1
            check_screen("%s %d" % (kind, seen[kind]))
            if kind == "reading":
                if phone:
                    # The story keeps its width and starts at the same height as without the logo.
                    a = page.evaluate("() => { const s = document.querySelector('#stage .story').getBoundingClientRect(); return [s.width, s.top]; }")
                    b = page.evaluate("""() => { const i = document.getElementById('topLogo'); i.style.display = 'none';
                      const s = document.querySelector('#stage .story').getBoundingClientRect(); i.style.display = ''; return [s.width, s.top]; }""")
                    check(abs(a[0] - b[0]) < 0.5 and abs(a[1] - b[1]) < 0.5, "%s reading: story area the same size with the logo" % name)
                page.screenshot(path=os.path.join(OUT, "toplogo-%s-reading.png" % name))
                # Paced reading: the sticky playback bar sits above the navigation; scrolled down, the logo stays
                # in the sticky top bar, clear of both.
                page.click("#stage .read-modes .btn[data-mode]:not([data-mode='normal'])")
                page.wait_for_timeout(200)
                page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
                page.wait_for_timeout(200)
                R = page.evaluate("""() => { const l = document.getElementById('topLogo').getBoundingClientRect();
                  const rb = document.querySelector('#stage .read-bar').getBoundingClientRect();
                  const nav = document.getElementById('nav').getBoundingClientRect();
                  const bar = document.querySelector('.topbar').getBoundingClientRect();
                  return { top: l.top, bottom: l.bottom, rb: rb.top, nav: nav.top, barBottom: bar.bottom }; }""")
                check(R["top"] >= 0 and R["bottom"] <= R["barBottom"] and R["bottom"] < R["rb"] and R["bottom"] < R["nav"],
                      "%s reading (scrolled, paced): logo stays in the top bar, clear of the playback bar and navigation" % name)
                page.screenshot(path=os.path.join(OUT, "toplogo-%s-reading-paced.png" % name))
                page.evaluate("scrollTo(0, 0)")
            elif kind == "exercise" and seen[kind] == 1:
                page.screenshot(path=os.path.join(OUT, "toplogo-%s-exercise.png" % name))
            elif kind == "game" and seen[kind] == 1:
                page.screenshot(path=os.path.join(OUT, "toplogo-%s-game.png" % name))
            page.click("#navNext")
        check(all(seen.values()), "%s: went through games, reading and exercises %s" % (name, seen))

        check(screen_name(page) == "finish", "%s: reached the finish screen" % name)
        F = page.evaluate("""() => ({ top: document.getElementById('topLogo').getBoundingClientRect().width,
          finish: document.querySelectorAll('#stage .finish-logo').length,
          shown: [...document.querySelectorAll('img[src*="logo"]')].filter(x => x.getBoundingClientRect().width > 0).length })""")
        check(F["top"] == 0 and F["finish"] == 1 and F["shown"] == 1, "%s finish: its own logo stays, the top one is hidden (one logo)" % name)
        page.screenshot(path=os.path.join(OUT, "toplogo-%s-finish.png" % name), full_page=True)
        # Back from the finish screen: the top logo is back.
        page.click("#navPrev")
        page.wait_for_timeout(150)
        check(page.evaluate(INFO)["visible"], "%s: back from the finish screen, the top logo shows again" % name)
        ctx.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
