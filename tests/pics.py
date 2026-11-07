"""Pictograms from ARASAAC (js/pics.js), against a mock of the API and the image server, plus one real search.
The lesson field `pic`; the teacher's choice (bestsearch, then search; up to 6; a search box; "בלי ציור",
"חזרה לאימוג׳י"; loading and error states); the picture before the emoji everywhere; a picture that does not load
falls back to the emoji, then to nothing (memory: a word-word pair); the credit line."""
import base64, json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
API = "https://api.arasaac.org/v1/pictograms/he/"
STATIC = "https://static.arasaac.org/pictograms/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
BROKEN = 999  # the mock image server has no such picture
CORS = {"Access-Control-Allow-Origin": "*"}

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

def serve_file(route):
    url = route.request.url
    if not url.startswith(SITE): route.abort(); return
    full = os.path.normpath(os.path.join(ROOT, unquote(urlparse(url).path)[len("/reading-app/"):] or "index.html"))
    if not full.startswith(ROOT) or not os.path.isfile(full): route.fulfill(status=404, body="not found"); return
    ctype = "application/javascript" if full.endswith(".js") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

# The mock: bestsearch knows שולחן (8 results: only 6 shown) and כלב; "חתול" only through search; "תקלה" fails.
api_calls = []
mock = {"down": False}
BEST = {"שולחן": [3129, 4942, 4944, 6562, 37873, 2917, 2916, 26071], "כלב": [7202, 2317], "כדור": [3241]}
SEARCH = {"חתול": [7114, 7115]}
def serve(route):
    url = route.request.url
    if url.startswith(API):
        kind, _, text = unquote(url[len(API):]).partition("/")
        api_calls.append((kind, text))
        if mock["down"]: route.abort(); return
        ids = (BEST if kind == "bestsearch" else SEARCH).get(text)
        if not ids: route.fulfill(status=404, body="[]", headers=dict(CORS, **{"Content-Type": "application/json"})); return
        route.fulfill(status=200, body=json.dumps([{"_id": i, "keywords": [{"keyword": text}]} for i in ids]),
                      headers=dict(CORS, **{"Content-Type": "application/json"}))
        return
    if url.startswith(STATIC):
        if mock["down"] or "/%d/" % BROKEN in url: route.fulfill(status=404, body="no"); return
        route.fulfill(status=200, body=PNG, headers=dict(CORS, **{"Content-Type": "image/png"}))
        return
    serve_file(route)

def bare(page, w): return page.evaluate("(w) => Hebrew.stripNikud(w)", w)
def link(page, lesson): return SITE + "play.html#" + page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", lesson)

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx = browser.new_context(viewport={"width": 1200, "height": 900})
    ctx.route("**/*", serve)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SITE + "index.html")

    # ---------- 1. The data: an optional `pic`; old lessons and links unchanged ----------
    words = [t["word"] for t in sample["targetWords"]]
    r = page.evaluate("""(l) => {
      const a = JSON.parse(JSON.stringify(l));
      a.targetWords[0].pic = 3129; a.targetWords[1].pic = '7202'; a.targetWords[2].pic = -4; a.targetWords[3].pic = 'x';
      const c = Lesson.coerce(a).lesson;
      const old = Lesson.coerce(l).lesson;
      return { pics: c.targetWords.map(t => t.pic), keys: c.targetWords.map(t => 'pic' in t),
               oldSame: LZString.decompressFromEncodedURIComponent(Lesson.encode(old)).indexOf('"pic"') === -1,
               round: Lesson.decode('#' + Lesson.encode(c)).targetWords.map(t => t.pic || 0) };
    }""", sample)
    check(r["pics"][:2] == [3129, 7202] and r["keys"][2:] == [False, False], "coerce: a pictogram id kept (also as digits), a bad one dropped (%s)" % r["pics"])
    check(r["oldSame"], "a lesson with no pictogram encodes with no `pic` (old links unchanged)")
    check(r["round"][:2] == [3129, 7202] and r["round"][2:] == [0, 0], "the link keeps the pictogram ids (%s)" % r["round"])

    # ---------- 2. The teacher's choice ----------
    lesson = json.loads(json.dumps(sample))
    lesson["targetWords"][3]["emoji"] = ""
    page.evaluate("(l) => localStorage.setItem('readingApp.draft', JSON.stringify({lesson: l, request: null, nikudVerified: null}))", lesson)
    page.reload()
    page.click("#resumeDraft")
    check(page.locator("#editor .pic-btn").count() == len(words) and "בחרו ציור" in page.text_content("#editor .pic-btn"),
          "editor: a '🖼️ בחרו ציור' button next to every target word")
    check(page.locator("#preview .pic-credit").count() == 0, "teacher page: no credit while there is no pictogram")

    api_calls.clear()
    # Hold the answer (fetch waits for a gate), to see the loading state
    page.evaluate("""() => { const f = window.fetch; let open; window.__gate = new Promise(r => open = r); window.__open = open;
      window.fetch = (...a) => window.__gate.then(() => f(...a)); }""")
    page.locator("#editor .pic-btn").nth(0).click()
    page.wait_for_selector("#picDialog")
    check("מחפשים" in page.text_content("#picDialog .pic-status"), "dialog: a loading message while searching")
    page.evaluate("window.__open()")
    page.wait_for_selector("#picDialog .pic-choice")
    check(page.input_value("#picQuery") == bare(page, words[0]) and api_calls[0] == ("bestsearch", bare(page, words[0])),
          "dialog: searches bestsearch with the word without nikud (%s)" % api_calls[:1])
    n = page.locator("#picDialog .pic-choice").count()
    check(n == 6 and page.locator("#picDialog .pic-choice img").first.get_attribute("src") == STATIC + "3129/3129_300.png"
          if bare(page, words[0]) == "שולחן" else n >= 1, "dialog: up to 6 pictures (%d)" % n)

    # Another wording in the search box: "שולחן" → 8 results, 6 shown
    page.fill("#picQuery", "שולחן")
    page.press("#picQuery", "Enter")
    page.wait_for_function("document.querySelectorAll('#picDialog .pic-choice').length === 6")
    srcs = page.eval_on_selector_all("#picDialog .pic-choice img", "els => els.map(e => e.getAttribute('src'))")
    check(srcs[0] == STATIC + "3129/3129_300.png" and len(srcs) == 6, "search box: another wording, the first 6 in ARASAAC's order")
    page.locator("#picDialog .pic-choice").nth(0).click()
    page.wait_for_selector("#picDialog", state="detached")
    chip0 = page.locator("#preview .chip").nth(0)
    check(chip0.locator("img.pic").get_attribute("src") == STATIC + "3129/3129_300.png"
          and chip0.locator("img.pic").get_attribute("alt") == words[0] and lesson["targetWords"][0]["emoji"] not in chip0.text_content(),
          "preview: the chosen pictogram before (instead of) the emoji, alt = the word")
    check(page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.targetWords[0].pic") == 3129 or
          page.wait_for_timeout(1500) or page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.targetWords[0].pic") == 3129,
          "the choice is kept in the draft")
    check(page.locator("#preview .pic-credit").count() == 1 and "סרחיו פאלאו" in page.text_content("#preview .pic-credit"),
          "teacher page: the credit line once a pictogram is chosen")
    check(page.locator("#editor .pic-btn").nth(0).locator("img.pic").count() == 1, "editor: the chosen pictogram on its button")

    # bestsearch finds nothing → search
    api_calls.clear()
    page.locator("#editor .pic-btn").nth(1).click()
    page.wait_for_selector("#picDialog .pic-status")
    page.fill("#picQuery", "חתול")
    page.click("#picSearch")
    page.wait_for_selector("#picDialog .pic-choice")
    check(("bestsearch", "חתול") in api_calls and ("search", "חתול") in api_calls and page.locator("#picDialog .pic-choice").count() == 2,
          "nothing in bestsearch → search (%s)" % api_calls[-2:])
    page.fill("#picQuery", "אין כזה")
    page.click("#picSearch")
    page.wait_for_function("document.querySelector('#picDialog .pic-status').textContent.includes('לא נמצאו')")
    check(page.locator("#picDialog .pic-choice").count() == 0, "nothing found: a message, no pictures")
    # ARASAAC down: an error, the lesson goes on
    mock["down"] = True
    page.click("#picSearch")
    page.wait_for_selector("#picDialog .pic-status.error")
    check("לא זמינה" in page.text_content("#picDialog .pic-status"), "ARASAAC down: a clear error message")
    mock["down"] = False
    check(page.locator("#picEmoji").count() == 0, "'חזרה לאימוג׳י' only for a word with a pictogram")
    page.keyboard.press("Escape")
    page.wait_for_selector("#picDialog", state="detached")
    check(page.evaluate("Lesson.coerce(JSON.parse(localStorage.getItem('readingApp.draft')).lesson).lesson.targetWords[1].pic") is None,
          "closing the dialog changes nothing (nothing chosen automatically)")

    # Back to the emoji
    page.locator("#editor .pic-btn").nth(0).click()
    page.wait_for_selector("#picEmoji")
    page.click("#picEmoji")
    page.wait_for_selector("#picDialog", state="detached")
    chip0 = page.locator("#preview .chip").nth(0)
    check(chip0.locator("img.pic").count() == 0 and lesson["targetWords"][0]["emoji"] in chip0.text_content()
          and page.locator("#preview .pic-credit").count() == 0, "'חזרה לאימוג׳י': the emoji again, no credit")
    # "בלי ציור"
    page.locator("#editor .pic-btn").nth(2).click()
    page.wait_for_selector("#picNone")
    page.click("#picNone")
    page.wait_for_selector("#picDialog", state="detached")
    check(page.locator("#preview .chip").nth(2).locator("button.no-pic").count() == 1, "'בלי ציור': no picture, the 'אין ציור' mark")
    # "אין ציור" opens the choice
    page.locator("#preview .chip").nth(3).locator("button.no-pic").click()
    page.wait_for_selector("#picDialog .pic-choice, #picDialog .pic-status")
    check(page.locator("#picDialog").count() == 1 and page.input_value("#picQuery") == bare(page, words[3]),
          "'אין ציור' is a button that opens the choice for that word")
    page.fill("#picQuery", "כדור")
    page.click("#picSearch")
    page.wait_for_selector("#picDialog .pic-choice")
    page.locator("#picDialog .pic-choice").nth(0).click()
    page.wait_for_selector("#picDialog", state="detached")
    check(page.locator("#preview .chip").nth(3).locator("img.pic").count() == 1 and page.locator("#preview .chip button.no-pic").count() == 1,
          "a word with no emoji gets the chosen pictogram")

    # ---------- 3. Print ----------
    pl = json.loads(json.dumps(sample))
    pl["targetWords"][0]["pic"] = 3129
    pl["targetWords"][1]["pic"] = BROKEN
    pl["targetWords"][2]["pic"] = BROKEN
    pl["targetWords"][2]["emoji"] = ""
    sheet = page.evaluate("""async (l) => {
      const s = Print.build(Lesson.coerce(l).lesson, {});
      document.body.appendChild(s);
      await Print.ready(s, 1500);
      await new Promise(r => setTimeout(r, 300));
      const t = [...s.querySelectorAll('.p-target')].map(e => ({img: e.querySelector('img.pic') && e.querySelector('img.pic').getAttribute('src'), text: e.textContent.trim()}));
      const credit = s.querySelector('.pic-credit') && s.querySelector('.pic-credit').textContent;
      s.remove();
      return {t, credit};
    }""", pl)
    t = sheet["t"]
    check(t[0]["img"] == STATIC + "3129/3129_300.png", "print: the pictogram")
    check(not t[1]["img"] and t[1]["text"].startswith(pl["targetWords"][1]["emoji"]), "print: a picture that does not load → the emoji (%s)" % t[1])
    check(not t[2]["img"] and t[2]["text"] == page.evaluate("(w) => Render.text({nikudMode: 'full', targetWords: []}, w)", pl["targetWords"][2]["word"]),
          "print: … and with no emoji, the word alone (%s)" % t[2])
    check(sheet["credit"] and "ARASAAC" in sheet["credit"], "print: the credit line")
    plain = page.evaluate("(l) => { const s = Print.build(Lesson.coerce(l).lesson, {}); return !!s.querySelector('.pic-credit'); }", sample)
    check(not plain, "print: no credit with no pictogram")

    # ---------- 4. The child page ----------
    child = json.loads(json.dumps(sample))
    child["targetWords"][0]["pic"] = 3129                       # a pictogram
    child["targetWords"][1]["pic"] = BROKEN                     # does not load, has an emoji
    child["targetWords"][2]["pic"] = BROKEN; child["targetWords"][2]["emoji"] = ""   # does not load, no emoji
    page.goto(link(page, child))
    page.wait_for_selector(".stage-actions .btn")
    page.wait_for_timeout(400)
    start = page.locator(".start-pics")
    check(start.locator("img.pic").count() == 1 and start.locator("img.pic").get_attribute("alt") == child["targetWords"][0]["word"]
          and child["targetWords"][1]["emoji"] in start.text_content() and child["targetWords"][3]["emoji"] in start.text_content(),
          "start page: the pictogram (alt = word); a broken one → its emoji")
    shown2 = page.evaluate("(w) => Render.text(Lesson.decode(location.hash), w)", child["targetWords"][2]["word"])
    check(shown2 not in start.text_content() and start.locator(".emoji-word").count() == 0, "start page: broken with no emoji → left out")
    check(page.is_visible("#picCredit .pic-credit") and "סרחיו פאלאו" in page.text_content("#picCredit"), "child page: the credit line at the bottom")

    page.click(".stage-actions .btn")
    page.wait_for_selector(".mcard")
    page.wait_for_timeout(500)
    cards = page.eval_on_selector_all(".mcard", "els => els.map(e => ({word: e.classList.contains('word'), img: !!e.querySelector('img.pic'), text: e.querySelector('.face').textContent}))")
    check(sum(c["img"] for c in cards) == 1, "memory: the pictogram on one card")
    check(sum(1 for c in cards if c["text"] == shown2 and c["word"]) == 2, "memory: broken with no emoji → a word-word pair")
    check(sum(1 for c in cards if c["text"] == child["targetWords"][1]["emoji"]) == 1, "memory: broken with an emoji → the emoji card")
    # match the pictogram pair
    faces = cards
    w0 = page.evaluate("(w) => Render.text(Lesson.decode(location.hash), w)", child["targetWords"][0]["word"])
    i_img = next(i for i, c in enumerate(faces) if c["img"]); i_w = next(i for i, c in enumerate(faces) if c["word"] and c["text"] == w0)
    page.locator(".mcard").nth(i_img).click(); page.locator(".mcard").nth(i_w).click()
    page.wait_for_timeout(300)
    check(page.locator(".mcard.matched").count() == 2, "memory: the pictogram matches its word")

    # The build and listen games, played directly with a pictogram word
    g = page.evaluate("""() => {
      const lesson = Lesson.decode(location.hash);
      const t = lesson.targetWords[0];
      const ctx = { lesson, targets: [t, lesson.targetWords[3]], hasVoice: true, show: w => Render.text(lesson, w),
                    speak() {}, praise() {}, hint() {} };
      const out = {};
      for (const k of ['build', 'listen']) {
        const area = document.createElement('div');
        document.body.appendChild(area);
        if (k === 'build') ctx.targets = [t];
        else ctx.targets = [t, lesson.targetWords[3]];
        Games[k].play(area, ctx, () => {});
        const img = area.querySelector('.big-emoji img.pic');
        out[k] = img && img.getAttribute('src');
        area.remove();
      }
      return out;
    }""")
    check(g["build"] == STATIC + "3129/3129_300.png", "build game: the pictogram")
    check(g["listen"] in (STATIC + "3129/3129_300.png", None) and page.evaluate("""() => {
      const lesson = Lesson.decode(location.hash);
      const ctx = { lesson, targets: [lesson.targetWords[0], lesson.targetWords[0]], hasVoice: true, show: w => w, speak() {}, praise() {}, hint() {} };
      const area = document.createElement('div'); Games.listen.play(area, ctx, () => {});
      return !!area.querySelector('.big-emoji img.pic');
    }"""), "listen game: the heard word's pictogram")

    # No pictogram: no credit on the child page
    page.goto(link(page, sample))
    page.wait_for_selector(".stage-actions .btn")
    check(page.is_hidden("#picCredit"), "child page: no credit with no pictogram")
    ctx.close()

    # ---------- 5. The real ARASAAC: one search for "שולחן" ----------
    real = browser.new_context()
    real.route(SITE + "**", serve_file)
    rp = real.new_page()
    rp.on("pageerror", lambda e: errors.append(str(e)))
    rp.goto(SITE + "index.html")
    try:
        res = rp.evaluate("""async () => {
          const ids = await Pics.search('שולחן');
          const img = new Image(); img.src = Pics.url(ids[0]);
          await img.decode();
          return { ids, w: img.naturalWidth };
        }""")
        check(len(res["ids"]) >= 1 and 3129 in res["ids"] and res["w"] > 0,
              "real ARASAAC: 'שולחן' found from the browser (CORS), the image loads (%s)" % res["ids"])
    except Exception as e:
        check(False, "real ARASAAC search failed: %s" % e)
    real.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
