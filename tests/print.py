"""Printable worksheet: content, fixed shuffle, answer page, nikud modes, print CSS, A4 PDF pages."""
import json, re, sys, threading, functools, http.server, os, copy
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8781
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

def pdf_pages(data):
    """Page count and first MediaBox of a Chrome PDF (page objects are not compressed)."""
    pages = len(re.findall(rb"/Type\s*/Page(?![s\w])", data))
    box = re.search(rb"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", data)
    return pages, [float(x) for x in box.groups()] if box else None

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page(viewport={"width": 1000, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    def to_link_step():
        page.click("#makeLink")
        page.click("#toLink")

    def do_print(answers=False):
        # Wrapped in a function: an expression that evaluates to a function would be called by Playwright.
        page.evaluate("() => { window.__prints = 0; window.print = () => { window.__prints++; }; }")
        page.set_checked("#printAnswers", answers)
        page.click("#printBtn")

    def sheet_texts(sel):
        return page.eval_on_selector_all("#printArea " + sel, "els => els.map(e => e.textContent.trim())")

    page.set_input_files("#loadJsonInput", SAMPLE)
    page.wait_for_selector("#step4:not([hidden])")
    to_link_step()
    check(page.is_visible("#step6") and page.is_visible("#printBtn") and page.text_content("#printBtn").strip() == "🖨️ הדפסה", "print button in the link step")
    check(page.is_visible("#printAnswers") and not page.is_checked("#printAnswers"), "'include answer page' checkbox, off by default")

    # ---------- Sheet content ----------
    do_print()
    check(page.evaluate("__prints") == 1, "print button calls window.print once")
    check(page.locator("#printArea .print-sheet").count() == 1 and page.is_hidden("#printArea"), "sheet built, hidden on screen")
    head = page.text_content("#printArea .p-head")
    check("שם:" in head and "תאריך:" in head and page.locator("#printArea .p-head .p-fill").count() == 2, "name and date lines")
    lesson = page.evaluate("(s) => Lesson.coerce(s).lesson", sample)
    check(page.text_content("#printArea .p-title") == lesson["title"], "title")
    targets = sheet_texts(".p-target")
    check(len(targets) == len(lesson["targetWords"]) and all(t["emoji"] in x and t["word"] in x for t, x in zip(lesson["targetWords"], targets)),
          "target words with emoji")
    story_text = page.evaluate("[...document.querySelectorAll('#printArea .p-story p')].map(p => p.textContent).join(' ').replace(/\\s+/g, ' ').trim()")
    check(story_text == " ".join(lesson["story"].split()), "full story")
    qs = page.locator("#printArea .p-q")
    exs = lesson["exercises"]
    check(qs.count() == len(exs) and sheet_texts(".p-num") == ["%d." % (i + 1) for i in range(len(exs))], "every exercise, numbered")

    layout = page.evaluate("(l) => Print.layout(l).map(x => x.order)", lesson)
    shuffled_any = False
    for i, ex in enumerate(exs):
        q = qs.nth(i)
        if ex["type"] == "mcq":
            opts = q.locator(".p-options li")
            printed = [opts.nth(j).text_content() for j in range(opts.count())]
            check(sorted(printed) == sorted(ex["options"]) and q.locator(".p-circle").count() == len(ex["options"]) and ex["question"] in q.text_content(),
                  "mcq %d: question, all options with circles" % (i + 1))
            check(printed == [ex["options"][k] for k in layout[i]], "mcq %d: printed in the layout order" % (i + 1))
            shuffled_any |= layout[i] != list(range(len(printed)))
        elif ex["type"] == "tf":
            check(q.locator(".p-square").count() == 2 and "נָכוֹן" in q.text_content() and "לֹא נָכוֹן" in q.text_content() and ex["statement"] in q.text_content(),
                  "tf %d: statement, two squares" % (i + 1))
        elif ex["type"] == "fill":
            bank = [q.locator(".p-bank span").nth(j).text_content() for j in range(q.locator(".p-bank span").count())]
            check(q.locator(".p-q-text .p-line").count() == 1 and "___" not in q.text_content() and sorted(bank) == sorted(ex["options"]),
                  "fill %d: blank line and word bank" % (i + 1))
            shuffled_any |= layout[i] != list(range(len(bank)))
        elif ex["type"] == "order":
            items = [q.locator(".p-order li").nth(j).text_content() for j in range(q.locator(".p-order li").count())]
            check(sorted(items) == sorted(ex["sentences"]) and q.locator(".p-box").count() == len(items) and items != ex["sentences"],
                  "order %d: shuffled sentences, a box for the number by each" % (i + 1))
    check(shuffled_any, "answer options are shuffled")
    check(page.locator("#printArea .p-answers").count() == 0, "no answer page unless asked")

    # Fixed: printing again (also after a reload) gives the same sheet
    first = page.inner_html("#printArea")
    do_print()
    check(page.inner_html("#printArea") == first, "same order when printing again")
    page.wait_for_timeout(600)  # the draft is saved 400 ms after the last change
    page.reload()
    page.click("#resumeDraft")
    to_link_step()
    do_print()
    check(page.inner_html("#printArea") == first, "same order after a reload")

    # ---------- Answer page ----------
    do_print(answers=True)
    ans = sheet_texts(".p-answers > ol > li")
    check(page.locator("#printArea .p-answers").count() == 1 and len(ans) == len(exs), "answer page: one answer per exercise")
    ok = True
    for i, ex in enumerate(exs):
        if ex["type"] in ("mcq", "fill"): ok &= ans[i] == ex["options"][ex["answer"]]
        elif ex["type"] == "tf": ok &= ans[i] == ("נכון" if ex["answer"] else "לא נכון")
        elif ex["type"] == "order":
            # Each printed sentence, in print order, with the number that belongs next to it.
            key = page.eval_on_selector_all(".p-answers > ol > li:nth-child(%d) .p-order-key li" % (i + 1),
                                            "els => els.map(e => [+e.querySelector('.p-key').textContent, e.textContent.slice(e.querySelector('.p-key').textContent.length)])")
            ok &= [s for _, s in key] == sheet_texts(".p-order li") and all(ex["sentences"][n - 1] == s for n, s in key)
    check(ok, "answers are correct, the order answer matches the printed sentences")

    # ---------- Print stylesheet ----------
    page.emulate_media(media="print")
    check(page.is_visible("#printArea") and page.is_hidden(".wrap"), "print media: only the sheet is shown")
    css = page.evaluate("""() => ({
      q: getComputedStyle(document.querySelector('#printArea .p-q')).breakInside,
      ans: getComputedStyle(document.querySelector('#printArea .p-answers')).breakBefore,
      story: parseFloat(getComputedStyle(document.querySelector('#printArea .p-story')).fontSize),
      body: parseFloat(getComputedStyle(document.querySelector('#printArea .print-sheet')).fontSize),
      target: getComputedStyle(document.querySelector('#printArea .p-story .word.target')).fontWeight
    })""")
    check(css["q"] == "avoid" and css["ans"] == "page", "questions never split across pages; answers start a new page (%s)" % css)
    check(css["story"] >= 24 and css["body"] >= 21, "large font: story %spx, text %spx" % (css["story"], css["body"]))
    check(int(css["target"]) >= 700, "target words in the story are bold (backgrounds do not print)")
    page.screenshot(path=os.path.join(OUT, "p1-print.png"), full_page=True)

    # A4 pages; the answer page adds exactly one page.
    # page.pdf follows the emulated media, and the buttons are only clickable on screen.
    def make_pdf(answers):
        page.emulate_media(media="screen")
        do_print(answers=answers)
        page.emulate_media(media="print")
        return page.pdf(prefer_css_page_size=True)
    n_plain, box = pdf_pages(make_pdf(False))
    pdf = make_pdf(True)
    open(os.path.join(OUT, "p2-worksheet.pdf"), "wb").write(pdf)
    n_ans, _ = pdf_pages(pdf)
    check(box and abs(box[2] - 595.3) < 2 and abs(box[3] - 841.9) < 2, "A4 page size: %s" % box)
    check(n_plain >= 1 and n_ans == n_plain + 1, "answer page is a separate page (%d → %d pages)" % (n_plain, n_ans))
    page.emulate_media(media="screen")

    # ---------- Nikud modes ----------
    def print_in_mode(mode):
        page.click("#steps li[data-step='4']")
        page.check("input[name=edNikud][value=%s]" % mode)
        page.wait_for_timeout(300)
        page.click("#makeLink")
        if mode != "none":
            page.fill("#dictaText", page.evaluate(
                "(l) => Review.slots(l, true).map(s => s.get().trim()).filter(Boolean).join('\\n')", lesson))
            page.click("#compareNikud")
        page.click("#toLink") if page.is_visible("#toLink") else page.click("#skipCheck")
        do_print(answers=True)
        return page.text_content("#printArea .print-sheet")
    text = print_in_mode("none")
    check(page.evaluate("(t) => !Hebrew.hasNikud(t)", text), "no-nikud mode: the whole sheet without nikud")
    text = print_in_mode("partial")
    words = page.evaluate("[...document.querySelectorAll('#printArea .p-story .word')].map(w => [w.classList.contains('target'), Hebrew.hasNikud(w.textContent)])")
    check(all(t == n for t, n in words) and any(t for t, _ in words), "partial mode: nikud only on target words in the story")

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
