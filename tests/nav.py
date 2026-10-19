"""Bottom navigation on the child page: הקודם / הבא between games, reading, every question and the finish.
Skipped questions count as wrong, solved ones are shown solved on return, layout on phone and desktop."""
import json, sys, threading, functools, http.server, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8783
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

def open_child(browser, **page_opts):
    page = browser.new_page(**page_opts)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "play.html")
    h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", sample)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    return page

def h1(page): return page.evaluate("(document.querySelector('#stage h1') || {}).textContent || ''")
def question_no(page):
    t = page.text_content("#stage")
    return next((k for k in range(1, 9) if ("שאלה %d מתוך" % k) in t), 0)
def disabled(page, sel): return page.evaluate("(s) => document.querySelector(s).disabled", sel)
def nxt(page): page.click("#navNext")
def prev(page): page.click("#navPrev")
def stars(page): return page.text_content(".stars")
def shown(page, s): return page.evaluate("(o) => Render.text(Lesson.decode(location.hash), o)", s)

def answer(page, ex, right=True):
    """Answer the current question. right=False makes one wrong try (choice types only)."""
    if ex["type"] in ("mcq", "fill"):
        correct = shown(page, ex["options"][ex["answer"]])
        labels = page.eval_on_selector_all(".option", "els => els.map(e => e.textContent)")
        target = correct if right else [b for b in labels if b != correct][0]
        page.locator(".option").filter(has_text=target).first.click()
    elif ex["type"] == "tf":
        page.click(".option >> text=" + ("👍 נכון" if ex["answer"] == right else "👎 לא נכון"))
    elif ex["type"] == "order":
        for s in ex["sentences"]:
            page.locator(".order-list:not(.answer) .order-item").filter(has_text=shown(page, s)).first.click()

def go_to_question(page, k):
    """From any exercise / finish screen, walk with the nav buttons to question k (1-based)."""
    for _ in range(20):
        q = question_no(page)
        if q == k: return
        if q == 0 or q > k: prev(page)
        else: nxt(page)

EXS = sample["exercises"]

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")

    # ---------- Moving between screens ----------
    page = open_child(browser, viewport={"width": 1000, "height": 900})
    check(page.is_hidden("#nav"), "start screen: no navigation bar")
    page.click("text=מתחילים ▶")
    check(page.is_visible("#nav") and h1(page) == "זוגות", "first game shows the bar")
    check(page.text_content("#navPrev").strip() == "→ הקודם" and page.text_content("#navNext").strip() == "הבא ←", "button labels")
    check(disabled(page, "#navPrev") and not disabled(page, "#navNext"), "first screen: הקודם disabled, הבא active before the game is done")
    nxt(page)
    check(h1(page) == "הרכבת מילה" and not disabled(page, "#navPrev"), "הבא skips an unfinished game")
    prev(page)
    check(h1(page) == "זוגות" and page.locator(".mcard.matched").count() == 0, "הקודם goes back to the first game (fresh)")
    nxt(page); nxt(page)
    check(page.locator("#stage .reader").count() == 1, "games → reading")
    check(page.locator("text=סיימתי לקרוא").count() == 0, "old 'סיימתי לקרוא' button replaced by the bar")
    prev(page)
    check(h1(page) == "הרכבת מילה", "reading → הקודם → last game")
    nxt(page); nxt(page)
    check(question_no(page) == 1, "reading → הבא → question 1")
    prev(page)
    check(page.locator("#stage .reader").count() == 1, "question 1 → הקודם → reading")
    # Leaving the reading screen while playing stops the timer
    page.locator(".read-modes .btn").nth(1).click()
    page.click("[data-act='play']")
    nxt(page)
    page.wait_for_timeout(1500)
    check(question_no(page) == 1 and not errors, "leaving the reading screen while playing: no errors")

    # ---------- Skipping counts as wrong ----------
    for k in range(1, 9):
        if k in (1, 8): check(question_no(page) == k, "skip to question %d" % k)
        nxt(page)
    check(h1(page) == "כל הכבוד!" and disabled(page, "#navNext") and not disabled(page, "#navPrev"), "finish: הבא disabled, הקודם active")
    check(stars(page) == "⭐", "all skipped → 1 star (%s)" % stars(page))
    check(page.evaluate("document.getElementById('progressFill').style.width") == "100%", "finish: progress 100%")
    prev(page)
    check(question_no(page) == 8, "finish → הקודם → last question")

    # Questions 1–4 right on the first try, 5–8 skipped: 4/8 → 2 stars (skips are not ignored)
    go_to_question(page, 1)
    for k in range(4):
        answer(page, EXS[k])
        page.wait_for_selector("#navNext.pop")
        if k == 0: check("pop" in page.get_attribute("#navNext", "class"), "question 1 answered: הבא highlighted")
        nxt(page)
    while h1(page) != "כל הכבוד!": nxt(page)
    check(stars(page) == "⭐⭐", "4 right + 4 skipped → 2 stars (%s)" % stars(page))

    # ---------- A solved question comes back solved ----------
    go_to_question(page, 1)
    check(page.locator(".option.right").count() == 1 and "כבר עניתם נכון" in page.text_content(".feedback"),
          "solved mcq shown solved on return")
    page.locator(".option:not(.right)").first.click()
    check(page.locator(".option.tried").count() == 0 and page.locator(".option.right").count() == 1, "solved question ignores clicks")
    go_to_question(page, 4)
    check(page.locator(".option.right").count() == 1, "solved tf shown solved on return")
    while h1(page) != "כל הכבוד!": nxt(page)
    check(stars(page) == "⭐⭐", "revisiting solved questions does not change the stars")

    # ---------- Wrong try, leave, come back: not a first-try answer ----------
    go_to_question(page, 5)
    answer(page, EXS[4], right=False)
    check("נסו" in page.text_content(".feedback"), "question 5: wrong try gives a hint")
    nxt(page); prev(page)
    check(question_no(page) == 5 and page.locator(".option.tried").count() == 0, "question 5 on return: can answer again")
    answer(page, EXS[4])
    page.wait_for_selector("#navNext.pop")
    nxt(page)
    answer(page, EXS[5]); page.wait_for_selector("#navNext.pop")
    check(page.locator(".blank.filled").count() == 1, "fill answered")
    nxt(page)
    answer(page, EXS[6]); page.wait_for_selector("#navNext.pop")
    nxt(page)  # question 8 still skipped
    nxt(page)
    # first try: 1-4, 6, 7 = 6/8 = 0.75 → 2 stars. Had question 5 counted, 7/8 → 3 stars.
    check(stars(page) == "⭐⭐", "wrong try before leaving still counts: 6/8 → 2 stars (%s)" % stars(page))
    go_to_question(page, 6)
    check(page.locator(".blank.filled").count() == 1 and page.locator(".option.right").count() == 1, "solved fill shown filled on return")

    # ---------- Back to a skipped question and answer it ----------
    go_to_question(page, 8)
    answer(page, EXS[7]); page.wait_for_selector("#navNext.pop")
    n_sent = len(EXS[7]["sentences"])
    nxt(page)
    check(stars(page) == "⭐⭐⭐", "skipped question answered later counts: 7/8 → 3 stars (%s)" % stars(page))
    prev(page)
    check(page.locator(".order-list.answer .order-item.locked").count() == n_sent
          and page.locator(".order-list:not(.answer) .order-item").count() == 0, "solved order shown in order on return")
    nxt(page)
    page.click(".stage-actions .btn")
    check(page.is_visible("text=מתחילים ▶") and page.is_hidden("#nav"), "restart: back to the start screen, bar hidden")
    page.click("text=מתחילים ▶")
    for _ in range(4): nxt(page)
    check(page.locator(".option.right").count() == 0 and page.text_content(".feedback") == "", "restart clears the answers")
    page.close()

    # ---------- Layout ----------
    def nav_layout(page):
        return page.evaluate("""() => {
          const n = document.querySelector('#nav').getBoundingClientRect();
          const a = document.querySelector('#navPrev').getBoundingClientRect();
          const b = document.querySelector('#navNext').getBoundingClientRect();
          return { navTop: n.top, navBottom: n.bottom, inner: innerHeight, prevH: a.height, nextH: b.height,
                   prevW: a.width, nextW: b.width, prevRight: a.right, nextLeft: b.left, vw: innerWidth,
                   inside: n.left >= 0 && n.right <= innerWidth && a.right <= innerWidth && b.left >= 0 };
        }""")

    for name, vp in [("phone", {"width": 390, "height": 700}), ("small phone", {"width": 320, "height": 568}), ("desktop", {"width": 1200, "height": 900})]:
        page = open_child(browser, viewport=vp, has_touch=name != "desktop")
        page.click("text=מתחילים ▶")
        L = nav_layout(page)
        check(abs(L["navBottom"] - L["inner"]) < 1, "%s: bar at the bottom of the screen" % name)
        check(L["prevH"] >= 56 and L["nextH"] >= 56 and L["prevW"] >= 120 and L["nextW"] >= 120,
              "%s: thumb-size buttons (%dx%d, %dx%d)" % (name, L["prevW"], L["prevH"], L["nextW"], L["nextH"]))
        check(L["prevRight"] > L["nextLeft"] and L["prevRight"] > L["vw"] / 2 > L["nextLeft"], "%s: הקודם on the right, הבא on the left" % name)
        check(L["inside"], "%s: the bar fits the screen width" % name)
        nxt(page); nxt(page)
        # Reading with paced playback: the sticky playback bar sits above the nav bar, never under it.
        for _ in range(8): page.click("[aria-label='הגדלת טקסט']")
        page.locator(".read-modes .btn").nth(1).click()
        for where in ["top", "middle", "bottom"]:
            page.evaluate("(w) => scrollTo(0, w === 'top' ? 0 : w === 'middle' ? document.documentElement.scrollHeight / 2 : document.documentElement.scrollHeight)", where)
            page.wait_for_timeout(50)
            r = page.evaluate("""() => {
              const bar = document.querySelector('.read-bar').getBoundingClientRect();
              const nav = document.querySelector('#nav').getBoundingClientRect();
              return [bar.top, bar.bottom, nav.top, innerHeight];
            }""")
            check(r[1] <= r[2] + 0.5 and r[0] < r[2], "%s, reading scrolled to %s: playback bar above the nav bar (bar %d-%d, nav from %d)" % (name, where, r[0], r[1], r[2]))
            if where == "middle":
                check(r[1] > r[2] - 2, "%s: playback bar sticks right above the nav bar" % name)
        # The end of the page is not hidden behind the bar
        page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        page.wait_for_timeout(50)
        last = page.evaluate("""() => {
          const kids = [...document.querySelectorAll('#stage > *')].filter(e => e.offsetParent);
          return kids[kids.length - 1].getBoundingClientRect().bottom <= document.querySelector('#nav').getBoundingClientRect().top;
        }""")
        check(last, "%s: end of the reading screen scrolls clear of the nav bar" % name)
        page.screenshot(path=os.path.join(OUT, "n-%s-reading.png" % name.replace(" ", "-")))
        while h1(page) != "כל הכבוד!": nxt(page)
        page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        page.wait_for_timeout(50)
        restart_visible = page.evaluate("document.querySelector('.stage-actions .btn').getBoundingClientRect().bottom <= document.querySelector('#nav').getBoundingClientRect().top")
        check(restart_visible, "%s: finish restart button not covered by the nav bar" % name)
        page.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
