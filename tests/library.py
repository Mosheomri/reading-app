"""The public library: the setup link keeps the Google Form in this browser (only), the "הוסף לספרייה" button in the
link step, and the row it sends (a POST to formResponse, no-cors). Google is never reached: the request is caught.
With --real, also sends one real row to the form (a test row, to be checked in the sheet and deleted)."""
import json, sys, os, threading, functools, http.server
from urllib.parse import parse_qs
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8791
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
# The sample lesson, with a level (an old lesson without one sends an empty level)
SAMPLE = os.path.join(ROOT, "tests", "out", "library-lesson.json")
os.makedirs(os.path.dirname(SAMPLE), exist_ok=True)
_l = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
_l["level"] = "3-4"
json.dump(_l, open(SAMPLE, "w", encoding="utf-8"), ensure_ascii=False)
REAL = "--real" in sys.argv

FORM = "1FAIpQLSdof2vNydRXPmrcJifOSTn4sN7KIkJ5BfhftDOItE8EJxMAKw"
ENTRIES = ["2007797355", "193105897", "1747520053", "1055424941", "491000135", "118766139"]  # title … link, as in the form
SETUP = "index.html?library=" + ",".join([FORM] + ENTRIES)

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 1100, "height": 900})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    posts = []
    def catch_form(route):
        posts.append({"url": route.request.url, "method": route.request.method, "body": route.request.post_data or ""})
        route.fulfill(status=200, body="ok")
    if not REAL:
        ctx.route("https://docs.google.com/**", catch_form)

    page.goto(BASE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    def to_link():
        page.set_input_files("#loadJsonInput", SAMPLE)
        page.wait_for_selector("#step4:not([hidden])")
        page.click("#makeLink")
        page.click("#toLink")
        page.wait_for_selector("#step6:not([hidden])")

    # ---------- Not set up: no button ----------
    to_link()
    check(page.is_hidden("#addLibrary"), "browser without the library: no 'add to library' button")
    check(page.locator("#libraryMsgs .msg").count() == 0, "no library message")

    # ---------- A broken setup link saves nothing ----------
    page.goto(BASE + "index.html?library=" + FORM + ",1,2,x")
    check("לא תקין" in page.text_content("#libraryMsgs") and page.evaluate("localStorage.getItem('readingApp.library')") is None,
          "a broken setup link: an error, nothing saved")

    # ---------- The setup link ----------
    page.goto(BASE + SETUP)
    check("הספרייה הוגדרה בדפדפן הזה" in page.text_content("#libraryMsgs"), "setup link: 'הספרייה הוגדרה בדפדפן הזה'")
    stored = json.loads(page.evaluate("localStorage.getItem('readingApp.library')") or "null")
    check(stored == {"form": FORM, "fields": dict(zip(["title", "topic", "level", "genre", "words", "link"], ["entry." + e for e in ENTRIES]))},
          "setup link: the form id and the six entries kept in localStorage (%s)" % stored)
    check("library=" not in page.url, "the parameter is removed from the address (%s)" % page.url)
    page.reload()
    check(page.locator("#libraryMsgs .msg").count() == 0, "the message is shown once, not on every visit")

    # ---------- The button and the row ----------
    to_link()
    check(page.is_visible("#addLibrary") and page.text_content("#addLibrary").strip() == "📚 הוסף לספרייה", "set-up browser: the button in the link step")
    link = page.text_content("#linkBox")
    page.click("#addLibrary")
    page.wait_for_selector("#libraryStatus .msg")
    status = page.text_content("#libraryStatus")
    check("נשלח לספרייה ✓" in status and "גיליון" in status and "אי אפשר לוודא" in status, "after sending: 'נשלח לספרייה ✓', and to check the sheet (%s)" % status)
    check(page.is_disabled("#addLibrary"), "sent once: the button is disabled for this link")
    if not REAL:
        check(len(posts) == 1 and posts[0]["method"] == "POST" and posts[0]["url"] == "https://docs.google.com/forms/d/e/%s/formResponse" % FORM,
              "one POST to formResponse (%s)" % [(x["method"], x["url"]) for x in posts])
        body = {k: v[0] for k, v in parse_qs(posts[0]["body"]).items()} if posts else {}
        sample = page.evaluate("(s) => Lesson.coerce(s).lesson", json.load(open(SAMPLE, encoding="utf-8")))
        plain = lambda s: page.evaluate("(s) => Hebrew.stripNikud(s).trim()", s)
        want = {
            "entry.2007797355": plain(sample["title"]),
            "entry.193105897": plain(sample.get("topic", "")),
            "entry.1747520053": "ג׳–ד׳",
            "entry.1055424941": "סיפור",
            "entry.491000135": ", ".join(plain(w["word"]) for w in sample["targetWords"]),
            "entry.118766139": link,
        }
        check(body == want, "the row: title and words without nikud, topic, level name, kind of text, the link (%s)" %
              {k: (body.get(k), v) for k, v in want.items() if body.get(k) != v})
        check(all(ch not in body.get("entry.2007797355", "") + body.get("entry.491000135", "") for ch in "ְִַָּ"),
              "no nikud in the title and the words")
        check(len(link) > 1000 and body.get("entry.118766139") == link, "a long link is sent whole (%d characters)" % len(link))

        # A failed request: an error, and the button can be pressed again
        ctx.unroute("https://docs.google.com/**")
        ctx.route("https://docs.google.com/**", lambda r: r.abort())
        page.reload()
        to_link()
        check(not page.is_disabled("#addLibrary") and page.locator("#libraryStatus .msg").count() == 0, "a new page: the button is ready again")
        page.click("#addLibrary")
        page.wait_for_selector("#libraryStatus .msg.error")
        check("נכשלה" in page.text_content("#libraryStatus") and not page.is_disabled("#addLibrary"),
              "a network failure: an error, and the button can be pressed again")

    # ---------- Forget the library ----------
    page.goto(BASE + "index.html?library=off")
    check("הוסרה" in page.text_content("#libraryMsgs") and page.evaluate("localStorage.getItem('readingApp.library')") is None, "?library=off forgets the library")

    check(not errors, "no page errors (%s)" % errors[:3])
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
