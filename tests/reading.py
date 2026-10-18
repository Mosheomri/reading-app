"""Paced reading on the child's reading screen: modes, pace, per-word timing, controls, layout stability.
Uses Playwright's fake clock, so timing is exact and the suite runs fast."""
import json, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8777
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

WORDS = "[...document.querySelectorAll('#stage .story .word')]"

def open_reading(browser, lesson, clear_storage=True, context=None, **page_opts):
    """New page on the reading screen of `lesson`, with a fake clock.
    Pages share localStorage only when opened in the same `context`."""
    page = context.new_page() if context else browser.new_page(**page_opts)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.install()
    page.goto(BASE + "play.html")
    if clear_storage: page.evaluate("localStorage.clear()")
    h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", lesson)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.clock.run_for(2000)  # speech voice lookup times out
    page.click("text=מתחילים ▶")
    for _ in range(5):  # skip the games
        if page.locator("#stage .reader").count(): break
        page.click("#stage .stage-actions button:has-text('הלאה')")
    return page

def cur(page):
    return page.evaluate(WORDS + ".findIndex(w => w.classList.contains('current'))")

def gone(page):
    return page.evaluate(WORDS + ".filter(w => w.classList.contains('gone')).length")

def delay(page, i, wpm):
    return page.evaluate("([i, wpm]) => { const p = Reading.plan(Lesson.decode(location.hash).story)[i]; return Reading.wordDelay(p.word, wpm, p.after); }", [i, wpm])

def set_range(page, v):
    page.evaluate("(v) => { const r = document.querySelector('.pace-range input'); r.value = v; r.dispatchEvent(new Event('input')); }", v)

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")

    # ---------- Pure functions ----------
    shared = browser.new_context(viewport={"width": 1000, "height": 900})
    page = open_reading(browser, sample, context=shared)
    story = sample["story"]
    plan = page.evaluate("(s) => Reading.plan(s)", story)
    n_spans = page.evaluate(WORDS + ".length")
    check(len(plan) == n_spans == page.evaluate("(s) => Hebrew.countWords(s)", story), "plan has one entry per word span (%d)" % n_spans)
    paragraphs = [l for l in story.split("\n") if l.strip()]
    check(sum(1 for w in plan if w["after"] == "paragraph") == len(paragraphs) and plan[-1]["after"] == "paragraph", "paragraph ends marked")
    check(plan[3]["word"] == "קָטָן" and plan[3]["after"] == "sentence" and plan[2]["after"] == "none", "sentence end after 'קָטָן.'")
    tov = [w for w in plan if w["word"] == "טוֹב"][0]
    check(tov["after"] == "sentence", "sentence end before a closing quote (טוֹב!\")")
    d = lambda w, wpm=60, after="none": page.evaluate("([w, p, a]) => Reading.wordDelay(w, p, a)", [w, wpm, after])
    check(d("גדולה") == 1000 and d("גְּדוֹלָה") == 1000, "5-letter word at 60 wpm = 1000 ms, nikud ignored")
    check(d("כלב") == 800 and d("ו") == 700 and d("התפוחים") == 1200 and d("והתפוחיםשלנו") == 1600, "length factor: +-10% per letter, clamped 0.7..1.6")
    check(d("גדולה", 60, "sentence") == 2000 and d("גדולה", 60, "paragraph") == 3000, "extra stop after sentence (1 base) and paragraph (2 base)")
    check(d("גדולה", 30) == 2000 and d("גדולה", 120) == 500 and d("גדולה", 500) == 500 and d("גדולה", 5) == 3000, "base time from pace, pace clamped to 20..120")
    check(page.evaluate("[Reading.clampPace(5), Reading.clampPace(200), Reading.clampPace('x'), Reading.clampPace(47)]") == [20, 120, 60, 47], "clampPace")

    # ---------- Modes and pace ----------
    modes = page.locator(".read-modes .btn")
    check(modes.count() == 3 and "רגיל" in modes.nth(0).text_content() and "סימון מתקדם" in modes.nth(1).text_content()
          and "מילים נעלמות" in modes.nth(2).text_content(), "three modes")
    check(modes.nth(0).get_attribute("aria-pressed") == "true" and page.is_hidden(".pace-box") and page.is_hidden(".read-bar"),
          "normal mode by default, no pace or playback controls")
    modes.nth(1).click()
    check(page.is_visible(".pace-box") and page.is_visible(".read-bar"), "highlight mode shows pace and playback")
    check(page.text_content(".pace-label") == "60 מילים בדקה" and page.get_attribute("[data-pace='60']", "aria-pressed") == "true", "default pace 60 (🐇)")
    icons = page.eval_on_selector_all(".pace-btns .btn", "els => els.map(e => e.textContent + ':' + e.dataset.pace)")
    check(icons == ["🐢:30", "🐇:60", "🚀:90"], "pace buttons 🐢 🐇 🚀 = 30/60/90")
    page.click("[data-pace='90']")
    check(page.input_value(".pace-range input") == "90" and page.evaluate("localStorage.getItem('readingApp.pace')") == "90", "🚀 sets 90 and saves it")
    check(page.get_attribute(".pace-range input", "min") == "20" and page.get_attribute(".pace-range input", "max") == "120", "slider range 20..120")
    set_range(page, 45)
    check(page.text_content(".pace-label") == "45 מילים בדקה" and page.locator(".pace-btns [aria-pressed='true']").count() == 0
          and page.evaluate("localStorage.getItem('readingApp.pace')") == "45", "slider sets any pace, saved")
    set_range(page, 60)

    # ---------- Highlight: advancing, timing, controls ----------
    check(cur(page) == 0, "highlight: first word marked before start")
    page.click("[data-act='play']")
    check(page.text_content("[data-act='play']") == "⏸ עצור", "play → pause label")
    page.clock.run_for(delay(page, 0, 60))
    check(cur(page) == 1 and page.locator("#stage .story .word.current").count() == 1, "advances one word after its delay")
    page.clock.run_for(delay(page, 1, 60) + delay(page, 2, 60))
    check(cur(page) == 3, "at the sentence-end word")
    no_pause = page.evaluate("(w) => Reading.wordDelay(w, 60, 'none')", plan[3]["word"])
    page.clock.run_for(no_pause)
    check(cur(page) == 3, "sentence end: still there after the plain word time")
    page.clock.run_for(delay(page, 3, 60) - no_pause)
    check(cur(page) == 4, "moves on after the extra sentence stop")
    target = page.evaluate(WORDS + ".find(w => w.classList.contains('target') && !w.classList.contains('current'))")
    bg_target = page.evaluate(WORDS + ".find(w => w.classList.contains('target') && !w.classList.contains('current')) && getComputedStyle(" + WORDS + ".find(w => w.classList.contains('target') && !w.classList.contains('current'))).backgroundColor")
    bg_cur = page.evaluate("getComputedStyle(document.querySelector('#stage .story .word.current')).backgroundColor")
    check(bg_cur not in ("rgba(0, 0, 0, 0)", bg_target), "current word colored, unlike target words (%s vs %s)" % (bg_cur, bg_target))

    page.click("[data-act='play']")
    page.clock.run_for(20000)
    check(cur(page) == 4 and page.text_content("[data-act='play']") == "▶ התחל", "pause stops advancing")
    page.click("[data-act='back']")
    check(cur(page) == 3, "one word back")
    page.click("[data-act='play']")
    page.clock.run_for(delay(page, 3, 60))
    check(cur(page) == 4, "resume after back")
    page.click("[data-act='restart']")
    check(cur(page) == 0 and page.text_content("[data-act='play']") == "⏸ עצור", "restart: first word, playing")
    check(page.is_disabled("[data-act='back']"), "back disabled on the first word")

    # Text size keeps working
    size0 = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#stage .reader .story')).fontSize)")
    page.click("[aria-label='הגדלת טקסט']"); page.click("[aria-label='הגדלת טקסט']")
    size1 = page.evaluate("parseFloat(getComputedStyle(document.querySelector('#stage .reader .story')).fontSize)")
    page.clock.run_for(delay(page, 0, 60))
    check(size1 == size0 + 8 and cur(page) == 1, "text size grows while the highlight keeps going (%s → %s)" % (size0, size1))
    page.screenshot(path=os.path.join(OUT, "r1-highlight.png"), full_page=True)

    # ---------- Vanishing words ----------
    modes.nth(2).click()
    check(cur(page) == -1 and gone(page) == 0 and page.text_content("[data-act='play']") == "▶ התחל", "mode switch stops and resets")
    rect = lambda i: page.evaluate("(i) => { const r = " + WORDS + "[i].getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }", i)
    last_before = rect(n_spans - 1)
    h_before = page.evaluate("document.querySelector('#stage .reader').getBoundingClientRect().height")
    page.click("[data-act='play']")
    page.clock.run_for(sum(delay(page, i, 60) for i in range(10)))
    check(gone(page) == 10, "10 words gone after their time")
    check(page.evaluate(WORDS + "[0].matches('.gone') && getComputedStyle(" + WORDS + "[0]).visibility === 'hidden'"), "gone words use visibility: hidden")
    check(rect(n_spans - 1) == last_before and page.evaluate("document.querySelector('#stage .reader').getBoundingClientRect().height") == h_before,
          "text does not move when words vanish")
    page.screenshot(path=os.path.join(OUT, "r2-vanish.png"), full_page=True)

    # End of the story (pace changed on the way: applies from the next word, and is remembered below)
    set_range(page, 45)
    page.clock.run_for(10 * 60 * 1000)
    check(page.is_visible(".read-end") and "סיימת לקרוא" in page.text_content(".read-end") and gone(page) == n_spans, "end: all words gone, end box shown")
    check(page.text_content("[data-act='play']") == "▶ התחל", "end: stopped")
    page.click(".read-end button:has-text('עוד פעם')")
    check(gone(page) == 0 and page.is_hidden(".read-end") and page.text_content("[data-act='play']") == "⏸ עצור", "'עוד פעם' restarts")
    page.clock.run_for(10 * 60 * 1000)
    page.click(".read-end button:has-text('הלאה')")
    check("שאלה 1 מתוך" in page.text_content("#stage"), "'הלאה' goes to the exercises")
    page.close()

    # ---------- Pace remembered; leaving the screen stops the timer ----------
    page = open_reading(browser, sample, clear_storage=False, context=shared)
    page.locator(".read-modes .btn").nth(1).click()
    check(page.input_value(".pace-range input") == "45" and page.text_content(".pace-label") == "45 מילים בדקה", "last pace (45) restored from localStorage")
    page.click("[data-act='play']")
    page.click("text=סיימתי לקרוא ←")
    page.clock.run_for(5 * 60 * 1000)
    check("שאלה 1 מתוך" in page.text_content("#stage") and not errors, "leaving while playing: timer stopped, no errors")
    page.close()

    # ---------- Auto-scroll on a small screen with big text ----------
    page = open_reading(browser, sample, viewport={"width": 390, "height": 600}, reduced_motion="reduce")
    for _ in range(8): page.click("[aria-label='הגדלת טקסט']")
    page.locator(".read-modes .btn").nth(1).click()
    page.click("[data-act='play']")
    page.clock.run_for(sum(delay(page, i, 60) for i in range(40)))
    page.wait_for_timeout(100)
    vis = page.evaluate("""() => {
      const w = document.querySelector('#stage .story .word.current').getBoundingClientRect();
      const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
      const bar = document.querySelector('.read-bar').getBoundingClientRect().top;
      return [w.top >= top, w.bottom <= Math.min(bar, innerHeight), scrollY];
    }""")
    check(cur(page) == 40 and vis[0] and vis[1] and vis[2] > 0, "auto-scroll keeps the current word visible (scrollY %s)" % vis[2])
    check(page.evaluate("(() => { const r = document.querySelector('.read-bar').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top < innerHeight; })()"),
          "playback bar stays on screen (sticky)")
    page.screenshot(path=os.path.join(OUT, "r3-scroll.png"))
    page.close()

    # ---------- All nikud modes ----------
    for mode in ["none", "partial"]:
        lesson = copy.deepcopy(sample); lesson["nikudMode"] = mode
        page = open_reading(browser, lesson, viewport={"width": 1000, "height": 900})
        texts = page.evaluate(WORDS + ".map(w => w.textContent)")
        page.locator(".read-modes .btn").nth(1).click()
        page.click("[data-act='play']")
        page.clock.run_for(delay(page, 0, 60) + delay(page, 1, 60))
        nikud_shown = page.evaluate("(ts) => ts.some(t => Hebrew.hasNikud(t))", texts)
        check(len(texts) == n_spans and cur(page) == 2 and (nikud_shown == (mode == "partial")),
              "nikud mode %s: same words, highlight advances, nikud shown: %s" % (mode, nikud_shown))
        page.locator(".read-modes .btn").nth(2).click()
        page.click("[data-act='play']")
        page.clock.run_for(delay(page, 0, 60))
        check(gone(page) == 1, "nikud mode %s: vanishing works" % mode)
        page.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
