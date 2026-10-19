"""Stories up to 2000 words: the form, the prompt, Dicta's split into parts (mock), the time budget,
the link length (printed), and the child page with a long lesson."""
import json, sys, os, random, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
SITE = "https://mosheomri.github.io/reading-app/"
DICTA = "https://nakdan.dicta.org.il/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
SCRIPT = open(os.path.join(ROOT, "userscripts", "dicta-bridge.user.js"), encoding="utf-8").read()
MOCK = open(os.path.join(ROOT, "tests", "fixtures", "dicta-mock.html"), encoding="utf-8").read()

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
    ctype = "application/javascript" if full.endswith(".js") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def new_context(browser, **opts):
    ctx = browser.new_context(**opts)
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    ctx.route(DICTA + "**", lambda r: r.fulfill(status=200, body=MOCK, headers={"Content-Type": "text/html; charset=utf-8"}))
    ctx.add_init_script("if (location.origin === 'https://nakdan.dicta.org.il') {" + SCRIPT + "}")
    ctx.on("page", lambda pg: pg.on("pageerror", lambda e: errors.append(pg.url[:40] + ": " + str(e))))
    return ctx

def sentences(story):
    out = []
    for para in story.split("\n"):
        cur = ""
        for ch in para:
            cur += ch
            if ch in ".!?":
                if cur.strip(): out.append(cur.strip())
                cur = ""
        if cur.strip(): out.append(cur.strip())
    return out

def long_lesson(words_target, mode, seed=1):
    """A vocalized lesson of ~words_target words, made of the sample's own (Dicta-vocalized) text.
    mode 'sentences': its sentences in a random order (repeats whole sentences: compresses well);
    mode 'words': its words in a random order (hardly any repeated phrases: compresses badly)."""
    rnd = random.Random(seed)
    sents = sentences(sample["story"])
    words = sample["story"].replace("\n", " ").split()
    paras, n = [], 0
    original = sample["story"].split("\n")  # keep the original once, so the order exercise stays valid
    paras.extend(original)
    n = sum(len(p.split()) for p in original)
    while n < words_target:
        if mode == "sentences":
            para = " ".join(rnd.choice(sents) for _ in range(4))
        else:
            para = " ".join(rnd.choice(words) for _ in range(30)).rstrip(".,!?") + "."
        paras.append(para)
        n += len(para.split())
    lesson = json.loads(json.dumps(sample))
    lesson["story"] = "\n".join(paras)
    return lesson

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = new_context(browser, viewport={"width": 1300, "height": 900})
    page = ctx.new_page()
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    page.reload()

    # ---------- The form ----------
    check(page.get_attribute("#length", "max") == "2000" and "2000" in page.text_content("#step1 .field:has(#length) .hint"), "form: up to 2000 words")
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", "2010")
    page.click("#makePrompt")
    check("בין 20 ל-2000 מילים" in page.text_content("#settingsMsgs"), "2010 words: refused with the new limit")
    page.fill("#length", "2000")
    page.click("#makePrompt")
    prompt = page.text_content("#promptText")
    check(page.is_visible("#step2") and "סך הכול בערך 2000 מילים" in prompt, "2000 words: accepted, the prompt asks for 2000 (%s)" %
          [l for l in prompt.split("\n") if "אורך הסיפור" in l][0])

    # ---------- Dicta: a 2000-word lesson, split into parts ----------
    lesson = long_lesson(2060, "sentences")  # the site counts words a little differently from split()
    plain = page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(lesson, ensure_ascii=False))
    plain_path = os.path.join(OUT, "long-plain-lesson.json")
    open(plain_path, "w", encoding="utf-8").write(plain)
    page.click("#steps li[data-step='1']")
    page.set_input_files("#loadJsonInput", plain_path)
    page.wait_for_selector("#step4:not([hidden])")
    n_words = page.evaluate("Hebrew.countWords(document.querySelector('#editor textarea').value)")
    check(n_words >= 2000, "test setup: the story has %d words" % n_words)
    page.click("#makeLink")
    page.wait_for_timeout(600)  # the draft is saved after 400 ms
    text = page.evaluate("Review.plainText(Lesson.coerce(JSON.parse(localStorage.getItem('readingApp.draft')).lesson).lesson)")
    parts = -(-len(text) // 5000)
    # Time budget: the page waits 30 s + 30 s per 5000 characters; the script gives each part 30 s.
    budget = page.evaluate("(n) => DictaBridge.config.baseTimeout + Math.max(1, Math.ceil(n / 5000)) * DictaBridge.config.partTimeout", len(text))
    script_part = int(SCRIPT.split("var PART_TIMEOUT = ")[1].split(";")[0])
    check(budget >= parts * script_part + 20000, "time budget: page waits %d s for %d characters (%d+ parts × %d s in the script)" %
          (budget // 1000, len(text), parts, script_part // 1000))
    statuses = []
    page.expose_function("__status", lambda t: statuses.append(t))
    page.evaluate("""() => new MutationObserver(() => __status(document.querySelector('#autoNikudMsgs').textContent))
                           .observe(document.querySelector('#autoNikudMsgs'), { childList: true, subtree: true, characterData: true })""")
    with page.expect_popup():
        page.click("#autoNikud")
    page.wait_for_function("() => /הוחל על|נכשל|לא התקבלה/.test(document.querySelector('#nikudMsgs').textContent + document.querySelector('#autoNikudMsgs').textContent)", timeout=60000)
    total_words = page.evaluate("(t) => Hebrew.countWords(t)", text)
    check(("הוחל על %d מילים" % total_words) in page.text_content("#nikudMsgs"), "2000-word lesson vocalized through the bridge (%d words, %d characters)" % (total_words, len(text)))
    seen_parts = sorted({s.split("מתוך ")[1].split(")")[0] for s in statuses if "מתוך" in s})
    check(seen_parts == [str(parts)] and any("חלק %d מתוך %d" % (parts, parts) in s for s in statuses),
          "split into %d parts of up to 5000 characters, progress per part" % parts)
    page.click("#toLink")
    link = page.text_content("#linkBox")
    info = page.text_content("#linkInfo")
    print("    link of this lesson: %d characters" % len(link))
    check(page.is_visible("#step6") and (("הקישור ארוך" in info) == (len(link) > 8000)), "link step: long-link note only above 8000 characters (%s)" % info)

    # ---------- Link length for 2000 words (vocalized, full nikud) ----------
    sizes = {}
    for mode in ["sentences", "words"]:
        L = long_lesson(2060, mode)
        L["nikudMode"] = "full"
        sizes[mode] = page.evaluate("""(l) => { const c = Lesson.coerce(l).lesson;
          const url = new URL('play.html', location.href); url.hash = Lesson.encode(c);
          return { words: Hebrew.countWords(c.story), json: JSON.stringify(Lesson.clean(c)).length, link: url.href.length }; }""", L)
        print("    2000 words (%s): story %d words, lesson JSON %d chars, link %d chars" % (mode, sizes[mode]["words"], sizes[mode]["json"], sizes[mode]["link"]))
    json.dump(sizes, open(os.path.join(OUT, "link-sizes.json"), "w"), indent=1)

    # ---------- The child page with the long link ----------
    child = ctx.new_page()
    child.on("pageerror", lambda e: errors.append("child: " + str(e)))
    child.goto(link)
    child.wait_for_selector("text=מתחילים ▶")
    child.click("text=מתחילים ▶")
    for _ in range(4):
        if child.locator("#stage .reader").count(): break
        child.click("#navNext")
    t = child.evaluate("""() => { const t0 = performance.now(); document.querySelector('.read-modes .btn:nth-child(2)').click();
                                   return [document.querySelectorAll('#stage .story .unit').length, performance.now() - t0]; }""")
    check(t[0] >= 2000 and t[1] < 500, "child page: the 2000-word story renders (%d words), switching mode takes %d ms" % (t[0], t[1]))

    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
