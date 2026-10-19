"""Automatic lesson with the Gemini API, against a mock API (Playwright routing: nothing goes to the network).
Key box, structured-output requests, the flow (write → checks → review → approvals → nikud through the Dicta
bridge mock), errors with one automatic retry, and the copy-paste fallback."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
SITE = "https://mosheomri.github.io/reading-app/"
DICTA = "https://nakdan.dicta.org.il/"
API = "https://generativelanguage.googleapis.com/"
KEY = "AIzaTEST-key-1234"

sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
SCRIPT = open(os.path.join(ROOT, "userscripts", "dicta-bridge.user.js"), encoding="utf-8").read()
MOCK_DICTA = open(os.path.join(ROOT, "tests", "fixtures", "dicta-mock.html"), encoding="utf-8").read()

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []
console = []
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}

def serve_file(route):
    path = unquote(urlparse(route.request.url).path)[len("/reading-app/"):] or "index.html"
    full = os.path.normpath(os.path.join(ROOT, path))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def reply(text, finish="STOP", pieces=4):
    """A streamed answer (server-sent events): the text in a few chunks, a thought part first (to be skipped)."""
    n = max(1, len(text) // pieces + 1)
    events = [{"candidates": [{"content": {"role": "model", "parts": [{"text": "thinking about it", "thought": True}]}}]}]
    for i in range(0, len(text), n):
        events.append({"candidates": [{"content": {"role": "model", "parts": [{"text": text[i:i + n]}]}}]})
    events[-1]["candidates"][0]["finishReason"] = finish
    return "sse", events

def sse_body(events):
    return "".join("data: " + json.dumps(e, ensure_ascii=False) + "\r\n\r\n" for e in events)

def api_error(status, message, reason=None, st="INVALID_ARGUMENT"):
    e = {"code": status, "message": message, "status": st}
    if reason: e["details"] = [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": reason}]
    return status, {"error": e}

class MockApi:
    """Answers in order from queue[kind] (kind: models | write | review), else a default. 'abort' = network error.
    With hold=True, write / review requests wait until release()."""
    def __init__(self, lesson_json, review_json="[]"):
        self.queue = {"models": [], "write": [], "review": []}
        self.log = []
        self.hold = False
        self.held = []
        self.hung = []
        self.defaults = {"models": (200, {"name": "models/x"}), "write": reply(lesson_json), "review": reply(review_json)}

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS); return
        body = json.loads(req.post_data) if req.post_data else None
        kind = "models" if req.method == "GET" else ("review" if body["generationConfig"]["responseSchema"]["type"] == "ARRAY" else "write")
        model = req.url.split("/models/")[1].split(":")[0].split("?")[0]
        self.log.append({"kind": kind, "model": model, "url": req.url, "headers": req.headers, "body": body})
        if self.hold and kind != "models":
            self.held.append((route, kind)); return
        self.answer(route, kind)

    def answer(self, route, kind):
        r = self.queue[kind].pop(0) if self.queue[kind] else self.defaults[kind]
        if r == "abort":
            route.abort("internetdisconnected"); return
        if r == "hang":
            self.hung.append(route); return  # never answers: the idle timeout must fire
        status, data = r
        if status == "sse":
            route.fulfill(status=200, body=sse_body(data), headers=dict(CORS, **{"Content-Type": "text/event-stream"})); return
        route.fulfill(status=status, body=json.dumps(data, ensure_ascii=False), headers=dict(CORS, **{"Content-Type": "application/json; charset=utf-8"}))

    def release(self):
        held, self.held = self.held, []
        for route, kind in held: self.answer(route, kind)

    def count(self, kind, model=None): return sum(1 for x in self.log if x["kind"] == kind and (model is None or x["model"] == model))

def new_context(browser, mock, bridge=False):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    ctx.route(API + "**", mock.handle)
    ctx.route(DICTA + "**", lambda r: r.fulfill(status=200, body=MOCK_DICTA, headers={"Content-Type": "text/html; charset=utf-8"}))
    if bridge:
        ctx.add_init_script("if (location.origin === 'https://nakdan.dicta.org.il') {" + SCRIPT + "}")
    ctx.on("page", lambda pg: (pg.on("pageerror", lambda e: errors.append(pg.url[:40] + ": " + str(e))),
                                pg.on("console", lambda m: console.append(m.type + ": " + m.text))))
    return ctx

def open_teacher(ctx, key=None, bridge_known=False):
    page = ctx.new_page()
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    if key: page.evaluate("(k) => localStorage.setItem('readingApp.geminiKey', k)", key)
    if bridge_known: page.evaluate("localStorage.setItem('readingApp.dictaBridge', '1')")
    page.reload()
    page.evaluate("Gemini.config.retryDelay = 300; Gemini.config.busyDelays = [100, 200, 300]")
    # Record every text a stage line showed (the list is redrawn on each change), to see the progress notes.
    page.evaluate("""() => { window.__stageTexts = [];
      new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.textContent && __stageTexts.push(n.textContent.trim()))))
        .observe(document.getElementById('autoStages'), { childList: true }); }""")
    return page

def fill_form(page, nikud="full"):
    page.fill("#topic", "כלב בגינה")
    page.fill("#length", str(STORY_WORDS))
    page.check("input[name=wordsMode][value=number]")
    page.fill("#wordCount", str(len(sample["targetWords"])))
    page.check("input[name=nikud][value=%s]" % nikud)
    # The question types of the sample lesson the mock answers with.
    page.evaluate("""() => { const c = {mcq: 3, tf: 2, fill: 2, order: 1, open: 0, locate: 0, message: 0};
      for (const k in c) { const i = document.querySelector('[data-count="' + k + '"]'); i.value = c[k]; i.dispatchEvent(new Event('input')); } }""")

def stages(page):
    return page.eval_on_selector_all("#autoStages li", "els => els.map(e => [e.dataset.stage, e.className, e.textContent.trim()])")

def stage_of(page, sid):
    return next((s for s in stages(page) if s[0] == sid), [sid, "", ""])

def flow_msgs(page): return page.text_content("#autoFlowMsgs") or ""

def wait_stage(page, sid, cls, timeout=15000):
    page.wait_for_function("([s, c]) => { const li = document.querySelector('#autoStages li[data-stage=\"' + s + '\"]'); return li && li.className === c; }",
                           arg=[sid, cls], timeout=timeout)

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")

    # The model's answer: the sample lesson without nikud, answers as strings (as the schema asks).
    tmp = browser.new_page()
    tmp.route("**/*", lambda r: serve_file(r) if r.request.url.startswith(SITE) else r.abort())
    tmp.goto(SITE + "index.html")
    plain = json.loads(tmp.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    STORY_WORDS = tmp.evaluate("(s) => Hebrew.countWords(s)", plain["story"])
    MODEL = tmp.evaluate("Gemini.MODEL")
    tmp.close()
    for ex in plain["exercises"]:
        if "answer" in ex: ex["answer"] = str(ex["answer"]).lower()
    plain.pop("nikudMode", None)
    LESSON_JSON = json.dumps(plain, ensure_ascii=False)
    words = plain["story"].split()
    SUGGESTIONS = json.dumps([
        {"field": "story", "type": "error", "original": words[0], "fix": words[0] + "ים", "reason": "בדיקה"},
        {"field": "title", "type": "style", "original": plain["title"].split()[0], "fix": "ה" + plain["title"].split()[0], "reason": "ניסוח"},
    ], ensure_ascii=False)

    # ---------- No key: copy-paste only ----------
    mock = MockApi(LESSON_JSON)
    ctx = new_context(browser, mock)
    page = open_teacher(ctx)
    check(page.is_hidden("#autoCreate") and "primary" in page.get_attribute("#makePrompt", "class"), "no key: only 'יצירת פרומפט' (primary)")
    check(page.locator("#geminiBox a[href='gemini-setup.html']").count() == 1 and "מחשב משותף" in page.text_content("#geminiBox"),
          "key box: link to instructions, shared-computer warning")
    check(page.get_attribute("#geminiKey", "type") == "password", "key field is a password field")

    # Invalid key: not saved
    mock.queue["models"].append(api_error(400, "API key not valid. Please pass a valid API key.", "API_KEY_INVALID"))
    page.click("#geminiBox summary")
    page.fill("#geminiKey", "bad-key")
    page.click("#checkKey")
    page.wait_for_function("() => !document.querySelector('#checkKey').disabled")
    check("לא תקין" in page.text_content("#geminiMsgs") and page.evaluate("localStorage.getItem('readingApp.geminiKey')") is None,
          "invalid key: clear message, not saved")
    # Valid key: saved, auto button appears
    page.fill("#geminiKey", "  " + KEY + " ")
    page.click("#checkKey")
    page.wait_for_function("() => document.querySelector('#geminiMsgs').textContent.includes('תקין ונשמר')")
    req = mock.log[-1]
    check(req["kind"] == "models" and req["url"] == API + "v1beta/models/" + MODEL and req["headers"].get("x-goog-api-key") == KEY and "key=" not in req["url"],
          "check key: GET models/%s with the key in the x-goog-api-key header (not in the URL)" % MODEL)
    check(page.evaluate("localStorage.getItem('readingApp.geminiKey')") == KEY and page.input_value("#geminiKey") == "", "valid key saved (trimmed), field cleared")
    check(page.is_visible("#autoCreate") and "primary" not in page.get_attribute("#makePrompt", "class") and page.is_visible("#geminiState"),
          "with a key: '✨ צור שיעור' shown, copy-paste still there")
    page.click("#deleteKey")
    check(page.evaluate("localStorage.getItem('readingApp.geminiKey')") is None and page.is_hidden("#autoCreate"), "delete key: removed, auto button hidden")
    ctx.close()

    # ---------- Full flow: write, check, review, approvals, nikud through the bridge ----------
    mock = MockApi(LESSON_JSON, SUGGESTIONS)
    ctx = new_context(browser, mock, bridge=True)
    page = open_teacher(ctx, key=KEY, bridge_known=True)
    fill_form(page)
    mock.hold = True
    page.click("#autoCreate")
    page.wait_for_function("() => document.querySelector('#autoStages li.active')")
    check(page.is_visible("#autoFlow") and stage_of(page, "write")[1] == "active" and "כותב סיפור" in stage_of(page, "write")[2]
          and page.is_disabled("#autoCreate"), "progress: 'כותב סיפור…' while writing, button disabled")
    page.wait_for_timeout(200)
    w = [x for x in mock.log if x["kind"] == "write"][-1]
    gc = w["body"]["generationConfig"]
    check(w["url"] == API + "v1beta/models/" + MODEL + ":streamGenerateContent?alt=sse" and w["headers"].get("x-goog-api-key") == KEY,
          "write: POST models/%s:streamGenerateContent?alt=sse (streamed) with the key header" % MODEL)
    check(gc.get("thinkingConfig") == {"thinkingLevel": "low"}, "write: thinkingConfig.thinkingLevel = low (the lowest for this model)")
    check(gc["responseMimeType"] == "application/json" and gc["responseSchema"]["type"] == "OBJECT"
          and set(gc["responseSchema"]["required"]) == {"title", "topic", "targetWords", "story", "exercises"}
          and gc["responseSchema"]["properties"]["exercises"]["items"]["properties"]["type"]["enum"] == ["mcq", "tf", "fill", "order"],
          "write: structured output (application/json + lesson responseSchema)")
    check(w["body"]["contents"][0]["parts"][0]["text"] == page.text_content("#promptText"), "write: the same prompt as copy-paste")
    mock.release()
    wait_stage(page, "review", "active")
    notes = [t for t in page.evaluate("__stageTexts") if "נכתבו כבר" in t]
    nums = [int("".join(c for c in t.split("נכתבו כבר")[1] if c.isdigit())) for t in notes]
    js_len = page.evaluate("document.querySelector('#response').value.length")  # UTF-16 units, as the page counts
    check(len(nums) >= 3 and nums == sorted(nums) and nums[-1] == js_len and all("כותב סיפור" in t for t in notes),
          "progress while streaming: 'כותב סיפור… (נכתבו כבר X תווים)', growing to the whole answer (%s)" % nums)
    check(page.evaluate("JSON.parse(document.querySelector('#response').value).title") == plain["title"] and "thinking about it" not in page.input_value("#response"),
          "streamed chunks joined into the answer; thought parts left out")
    logs = [c for c in console if "[Gemini] write-lesson (" + MODEL + "): HTTP 200" in c]
    check(len(logs) == 1 and " s, " in logs[0] and "%d chars" % js_len in logs[0] and "finish STOP" in logs[0],
          "console: call, duration, HTTP status, length (%s)" % (logs[0] if logs else console[-3:]))
    check(stage_of(page, "write")[1] == "done" and stage_of(page, "check")[1] == "done" and "בודק טקסט" in stage_of(page, "review")[2],
          "progress: written, checked, 'בודק טקסט…'")
    check(page.is_visible("#step5"), "check step shown while the text is reviewed")
    page.wait_for_timeout(200)
    r = [x for x in mock.log if x["kind"] == "review"][-1]
    check(r["body"]["generationConfig"]["responseSchema"]["type"] == "ARRAY" and r["body"]["contents"][0]["parts"][0]["text"] == page.text_content("#reviewPromptText")
          and "עורך לשון" in r["body"]["contents"][0]["parts"][0]["text"], "review: separate call with the existing review prompt, list schema")
    mock.release()
    wait_stage(page, "approve", "wait")
    check(page.locator("#reviewList .review-item").count() == 2 and "נמצאו 2 הצעות" in stage_of(page, "review")[2],
          "review suggestions shown for approval, as with a paste")
    check(stage_of(page, "nikud")[1] == "todo" and page.is_visible("#autoFlow"), "nikud waits for the approvals")
    page.screenshot(path=os.path.join(OUT, "g1-review.png"), full_page=True)
    page.locator("#reviewList .review-item").nth(0).locator("button:has-text('אשר')").click()
    check(stage_of(page, "approve")[1] == "wait", "one decision left: still waiting")
    with page.expect_popup() as pop:
        page.locator("#reviewList .review-item").nth(1).locator("button:has-text('דחה')").click()
    pop.value.wait_for_load_state()
    check(pop.value.url == DICTA, "the last decision (a click) opens Dicta, since the bridge is known")
    page.wait_for_function("() => document.querySelector('#nikudMsgs').textContent.includes('הוחל על')", timeout=15000)
    wait_stage(page, "nikud", "done")
    check("השיעור מוכן" in flow_msgs(page), "nikud done through the bridge, 'השיעור מוכן'")
    page.wait_for_timeout(600)
    d = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")
    check((words[0] + "ים") in page.evaluate("(s) => Hebrew.stripNikud(s)", d["lesson"]["story"]), "approved suggestion applied before nikud")
    page.click("#autoFlowMsgs button:has-text('יצירת קישור')")
    check(page.is_visible("#step6"), "link from the flow")
    page.screenshot(path=os.path.join(OUT, "g2-done.png"))
    ctx.close()

    # ---------- Bridge not known: the teacher's turn for nikud; manual paste completes it ----------
    mock = MockApi(LESSON_JSON, SUGGESTIONS)
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "approve", "wait")
    page.locator("#reviewList .review-item button:has-text('דחה'):visible").first.click()
    page.locator("#reviewList .review-item button:has-text('דחה'):visible").first.click()
    wait_stage(page, "nikud", "wait")
    check(len(ctx.pages) == 1 and "ידנית" in stage_of(page, "nikud")[2], "no bridge: no window opened, nikud is the teacher's turn (auto or manual)")
    page.wait_for_timeout(600)  # the draft is saved after 400 ms
    voc = page.evaluate("""() => { const l = Lesson.coerce(JSON.parse(localStorage.getItem('readingApp.draft')).lesson).lesson;
      return [...Review.plainText(l)].map(c => c >= 'א' && c <= 'ת' ? c + String.fromCharCode(0x05B8) : c).join(''); }""")
    page.fill("#dictaText", voc)
    page.click("#compareNikud")
    wait_stage(page, "nikud", "done")
    check("השיעור מוכן" in flow_msgs(page), "manual nikud completes the flow")
    ctx.close()

    # ---------- No nikud, nothing to fix ----------
    mock = MockApi(LESSON_JSON, "[]")
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page, nikud="none")
    page.click("#autoCreate")
    page.wait_for_function("() => document.querySelector('#autoFlowMsgs').textContent.includes('השיעור מוכן')", timeout=15000)
    check(stage_of(page, "approve")[1] == "skip" and stage_of(page, "nikud")[1] == "skip" and "לא נמצא מה לתקן" in stage_of(page, "review")[2],
          "no nikud, no suggestions: ready right away")
    ctx.close()

    # ---------- Errors while writing ----------
    def failing(label, queue, expect, n_requests, nikud="full"):
        mock = MockApi(LESSON_JSON)
        mock.queue["write"] = list(queue)
        ctx = new_context(browser, mock)
        page = open_teacher(ctx, key=KEY)
        fill_form(page, nikud)
        page.click("#autoCreate")
        page.wait_for_function("() => document.querySelector('#autoStages li.fail')", timeout=15000)
        m = flow_msgs(page)
        check(expect in m and "הפרומפט מוכן" in m and page.is_visible("#step2") and page.text_content("#promptText").strip() != "",
              "%s: clear message, copy-paste with the prompt ready (%s)" % (label, m[:90]))
        check(mock.count("write") == n_requests, "%s: %d request(s) (got %d)" % (label, n_requests, mock.count("write")))
        check(not page.is_disabled("#autoCreate") and page.locator("#autoFlowMsgs button:has-text('לנסות שוב')").count() == 1, "%s: can try again" % label)
        return mock, ctx, page

    failing("invalid key", [api_error(400, "API key not valid.", "API_KEY_INVALID")], "המפתח של Gemini לא תקין", 1)[1].close()
    failing("quota (429)", [api_error(429, "Resource has been exhausted", None, "RESOURCE_EXHAUSTED")], "נגמרה המכסה", 1)[1].close()
    failing("network", ["abort", "abort"], "אין חיבור", 2)[1].close()
    failing("server error twice (500)", [api_error(500, "internal", None, "INTERNAL")] * 2, "תקלה זמנית", 2)[1].close()
    failing("cut answer", [reply(LESSON_JSON[:200], "MAX_TOKENS")], "נקטעה", 1)[1].close()
    failing("blocked", [("sse", [{"promptFeedback": {"blockReason": "SAFETY"}}])], "סירב", 1)[1].close()

    # No data for the idle time (45 s; shortened here): timeout, retried once, then the message
    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = ["hang", "hang"]
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    page.evaluate("Gemini.config.idleTimeout = 1500")
    fill_form(page)
    page.click("#autoCreate")
    page.wait_for_function("() => document.querySelector('#autoStages li.fail')", timeout=15000)
    check("הפסיק לשלוח נתונים" in flow_msgs(page) and mock.count("write") == 2 and "הפרומפט מוכן" in flow_msgs(page),
          "no data for the idle time: timeout, one retry, message with the copy-paste way")
    warn = [c for c in console if c.startswith("warning: [Gemini] write-lesson") and "הפסיק לשלוח נתונים" in c]
    check(len(warn) == 2 and any(", retry" in c for c in warn), "console: both timed-out attempts logged as warnings (%s)" % warn[-1:])
    check(page.evaluate("Gemini.config.idleTimeout") == 1500 and page.evaluate("Gemini.config.timeout") == 120000, "timeouts: 120 s for plain requests, idle timer for streams")
    for r in mock.hung:
        try: r.abort()
        except Exception: pass
    ctx.close()

    # A stream that keeps sending data is not cut, however long it takes in total
    mock = MockApi(LESSON_JSON)
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    page.evaluate("Gemini.config.idleTimeout = 800")
    got = page.evaluate("""async () => {
      // A fake stream: a chunk every 500 ms for 3 s (longer than the idle time in total, never idle).
      const realFetch = window.fetch;
      window.fetch = (url, init) => {
        const enc = new TextEncoder();
        let n = 0;
        const body = new ReadableStream({ pull(ctrl) {
          return new Promise(r => setTimeout(r, 500)).then(() => {
            if (n++ === 6) { ctrl.enqueue(enc.encode('data: ' + JSON.stringify({candidates: [{content: {parts: [{text: ']'}]}, finishReason: 'STOP'}]}) + '\\r\\n\\r\\n')); ctrl.close(); return; }
            ctrl.enqueue(enc.encode('data: ' + JSON.stringify({candidates: [{content: {parts: [{text: n === 1 ? '[1' : ',1'}]}}]}) + '\\r\\n\\r\\n'));
          });
        }});
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
      };
      const seen = [];
      const t0 = Date.now();
      const text = await Gemini.generate('k', 'p', Gemini.REVIEW_SCHEMA, { onProgress: c => seen.push(c) });
      window.fetch = realFetch;
      return { text, seen, ms: Date.now() - t0 };
    }""")
    check(got["text"] == "[1,1,1,1,1,1]" and got["ms"] > 2500 and got["seen"] == sorted(got["seen"]) and len(got["seen"]) == 7,
          "a slow stream that keeps sending is not cut by the idle timer (%d ms, progress %s)" % (got["ms"], got["seen"]))
    ctx.close()

    # An error inside the stream (after HTTP 200) counts as a temporary server error: retried once
    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = [("sse", [{"error": {"code": 503, "message": "The model is overloaded.", "status": "UNAVAILABLE"}}])]
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    check(mock.count("write") == 2 and any("UNAVAILABLE The model is overloaded." in c for c in console),
          "error event inside the stream: retried, Google's message in the console")
    ctx.close()

    # A lesson that fails the checks: message, prompt ready, and the answer can be opened in step 3
    bad = dict(plain); bad["exercises"] = []
    mock, ctx, page = failing("lesson fails the checks", [reply(json.dumps(bad, ensure_ascii=False))], "לא עבר את הבדיקות", 1)
    check("אין תרגילים" in flow_msgs(page), "the failed checks are listed")
    page.click("#autoFlowMsgs button:has-text('לראות את התשובה')")
    check(page.is_visible("#step3") and "אין תרגילים" in page.text_content("#parseMsgs") and page.is_visible("#fixBox"),
          "the answer opens in step 3 with the usual fix message")
    ctx.close()

    # One automatic retry after a temporary error
    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = [api_error(503, "overloaded", None, "UNAVAILABLE")]
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    check(mock.count("write") == 2 and stage_of(page, "write")[1] == "done", "503 then OK: retried, flow goes on")
    ctx.close()

    # ---------- Overloaded server (503): up to 3 more tries with growing waits, then the fallback model ----------
    SRC = open(os.path.join(ROOT, "js", "gemini.js"), encoding="utf-8").read()
    check("busyDelays: [2000, 5000, 10000]" in SRC and "var FALLBACK_MODEL = 'gemini-3.5-flash-lite';" in SRC,
          "503 waits 2, 5 and 10 s; fallback model in a constant at the top of the file")
    BUSY = api_error(503, "The model is overloaded. Please try again later.", None, "UNAVAILABLE")
    FALLBACK = "gemini-3.5-flash-lite"

    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = [BUSY, BUSY]
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    texts = page.evaluate("__stageTexts")
    check(mock.count("write", MODEL) == 3 and mock.count("write", FALLBACK) == 0, "503 twice: third try works, main model only")
    check(any("השרת של גוגל עמוס, מנסה שוב… (ניסיון 2 מתוך 4)" in t for t in texts) and any("(ניסיון 3 מתוך 4)" in t for t in texts),
          "the teacher sees 'השרת של גוגל עמוס, מנסה שוב…' with the try number")
    ctx.close()

    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = [BUSY] * 4
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    fb = [x for x in mock.log if x["model"] == FALLBACK]
    check(mock.count("write", MODEL) == 4 and mock.count("write", FALLBACK) == 1, "503 four times on %s: switched to %s" % (MODEL, FALLBACK))
    check(fb and fb[0]["body"]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}
          and fb[0]["body"]["generationConfig"]["responseSchema"]["type"] == "OBJECT", "fallback: same structured output, its own lowest thinking level (minimal)")
    check(mock.count("review", FALLBACK) == 1 and mock.count("review", MODEL) == 0, "the review continues with the fallback model")
    texts = page.evaluate("__stageTexts")
    check(any("ממשיכים עם מודל קל יותר (%s)" % FALLBACK in t for t in texts) and "במודל הגיבוי" in stage_of(page, "write")[2],
          "the teacher sees the switch, and that the story was written with the fallback")
    check(any("still overloaded (503)" in c and FALLBACK in c for c in console) and any(("write-lesson (%s): HTTP 200" % FALLBACK) in c for c in console),
          "console: the switch and the fallback's calls, with its name")
    # The next lesson starts with the main model again
    before = len(mock.log)
    page.evaluate("document.getElementById('autoCreate').click()")
    page.wait_for_timeout(300)
    new = mock.log[before:]
    check(new and new[0]["kind"] == "write" and all(x["model"] == MODEL for x in new), "a new lesson starts with the main model again (%s)" % [(x["kind"], x["model"]) for x in new])
    ctx.close()

    mock, ctx, page = failing("503 on both models", [BUSY] * 8, "השרת של Google עמוס כרגע", 4 + 4)
    check(mock.count("write", FALLBACK) == 4, "fallback model also tried 4 times before giving up")
    ctx.close()

    # If the model rejected the thinking setting (400 about thinking): sent once more without it
    mock = MockApi(LESSON_JSON)
    mock.queue["write"] = [api_error(400, "thinking_level is not supported for this model.")]
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    bodies = [x["body"]["generationConfig"] for x in mock.log if x["kind"] == "write"]
    check(len(bodies) == 2 and "thinkingConfig" in bodies[0] and "thinkingConfig" not in bodies[1],
          "thinking setting rejected (400): sent again once without it, flow goes on")
    ctx.close()

    # Review fails: clear message with "נסה ביקורת שוב" (top and part 1); the flow still offers nikud
    mock = MockApi(LESSON_JSON, SUGGESTIONS)
    mock.queue["review"] = [api_error(500, "internal", None, "INTERNAL")] * 2
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#autoCreate")
    wait_stage(page, "nikud", "wait")
    m = flow_msgs(page)
    check(stage_of(page, "review")[1] == "fail" and "בדיקת הטקסט האוטומטית נכשלה" in m and "יצירת פרומפט ביקורת" in m and mock.count("review") == 2,
          "review error (retried once): clear message with the manual way")
    check(page.locator("#autoFlowMsgs button:has-text('נסה ביקורת שוב')").count() == 1 and page.locator("#reviewMsgs button:has-text('נסה ביקורת שוב')").count() == 1,
          "'נסה ביקורת שוב' at the top and next to the review part")
    page.screenshot(path=os.path.join(OUT, "g4-review-failed.png"), full_page=True)
    page.locator("#reviewMsgs button:has-text('נסה ביקורת שוב')").click()
    wait_stage(page, "approve", "wait")
    check(mock.count("review") == 3 and page.locator("#reviewList .review-item").count() == 2 and stage_of(page, "nikud")[1] == "todo"
          and "נסה ביקורת שוב" not in flow_msgs(page), "review retried: suggestions shown, nikud waits for the approvals again")
    ctx.close()

    # Review fails in no-nikud mode: "ready" does not hide the failure and its button
    mock = MockApi(LESSON_JSON)
    mock.queue["review"] = [api_error(500, "internal", None, "INTERNAL")] * 2
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page, nikud="none")
    page.click("#autoCreate")
    page.wait_for_function("() => document.querySelector('#autoFlowMsgs').textContent.includes('מוכן לקישור')", timeout=15000)
    check("נסה ביקורת שוב" in flow_msgs(page) and "גם בלי בדיקת הטקסט" in flow_msgs(page), "no nikud: ready for a link, review retry still offered")
    ctx.close()

    # ---------- Copy-paste still works with a key ----------
    mock = MockApi(LESSON_JSON)
    ctx = new_context(browser, mock)
    page = open_teacher(ctx, key=KEY)
    fill_form(page)
    page.click("#makePrompt")
    check(page.is_visible("#step2") and mock.count("write") == 0 and page.is_hidden("#autoFlow"), "with a key, 'יצירת פרומפט' is the usual copy-paste")
    page.click("#step2 [data-go='3']")
    page.fill("#response", "```json\n" + LESSON_JSON + "\n```")
    page.click("#parseBtn")
    check(page.is_visible("#step4"), "pasted answer still works")
    ctx.close()

    # ---------- Setup page ----------
    ctx = new_context(browser, MockApi(LESSON_JSON))
    page = ctx.new_page()
    page.goto(SITE + "gemini-setup.html")
    t = page.text_content("body")
    check(page.locator("a[href='https://aistudio.google.com/api-keys']").count() == 1 and "Create API key" in t and "mosheomri.github.io/*" in t
          and "Websites" in t and "מחשב משותף" in t, "setup page: AI Studio steps, optional website restriction, shared-computer warning")
    page.screenshot(path=os.path.join(OUT, "g3-setup.png"), full_page=True)
    ctx.close()

    check(any("HTTP 429" in c and "RESOURCE_EXHAUSTED" in c for c in console), "console: HTTP status and Google's error for a failed call")
    check(any(c.startswith("info: [Gemini] check-key (") for c in console), "console: the key check is logged too")
    check(not [c for c in console if KEY in c or "bad-key" in c], "the key never appears in the console")
    check(not errors, "no page errors: %s" % errors)
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
