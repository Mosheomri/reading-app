"""Text quality round: kind of text (story / informational) in the form, the lesson and the prompts; the writer's
prompt (role, structure, target words, about N words, paragraphs, read aloud); levels' vocabulary and what to avoid;
the editor's call in the automatic flow (thinking levels, the guard that keeps the draft); the review's editing checks;
letters of another script inside Hebrew words; lines instead of paragraphs, with the "join" button."""
import json, sys, os, mimetypes
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://mosheomri.github.io/reading-app/"
API = "https://generativelanguage.googleapis.com/"
KEY = "AIzaTEST-key-1234"
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"}
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))

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
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if full.endswith(".js"): ctype = "application/javascript"
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

def sse(text):
    events = [{"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]}]
    return "".join("data: " + json.dumps(e, ensure_ascii=False) + "\r\n\r\n" for e in events)

def kind_of(body):
    props = body["generationConfig"]["responseSchema"].get("properties", {})
    if body["generationConfig"]["responseSchema"]["type"] == "ARRAY": return "review"
    if "lines" in props: return "nikud"
    if "story" in props: return "write" if "title" in props else "edit"
    return "exercises"

class MockApi:
    """Fixed answers per kind of call; answers["edit"] may be (status, error body) for a failed call."""
    def __init__(self, answers):
        self.answers = answers
        self.log = []

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            route.fulfill(status=204, headers=CORS); return
        if req.method == "GET":
            route.fulfill(status=200, body='{"name": "models/x"}', headers=dict(CORS, **{"Content-Type": "application/json"})); return
        body = json.loads(req.post_data)
        kind = kind_of(body)
        self.log.append({"kind": kind, "body": body, "prompt": body["contents"][0]["parts"][0]["text"]})
        a = self.answers[kind]
        if isinstance(a, tuple):
            route.fulfill(status=a[0], body=json.dumps(a[1]), headers=dict(CORS, **{"Content-Type": "application/json"})); return
        route.fulfill(status=200, body=sse(a), headers=dict(CORS, **{"Content-Type": "text/event-stream"}))

    def of(self, kind): return [x for x in self.log if x["kind"] == kind]

def new_page(browser, mock=None, key=None):
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    ctx.route("**/*", lambda r: r.abort())
    ctx.route(SITE + "**", serve_file)
    if mock: ctx.route(API + "**", mock.handle)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(SITE + "index.html")
    page.evaluate("localStorage.clear()")
    if key: page.evaluate("(k) => localStorage.setItem('readingApp.geminiKey', k)", key)
    page.reload()
    page.evaluate("Gemini.config.retryDelay = 200; Gemini.config.busyDelays = [100]")
    return ctx, page

def wait_stage(page, sid, cls, timeout=15000):
    page.wait_for_function("([s, c]) => { const li = document.querySelector('#autoStages li[data-stage=\"' + s + '\"]'); return li && li.className === c; }",
                           arg=[sid, cls], timeout=timeout)

def stage_text(page, sid):
    return page.text_content("#autoStages li[data-stage='%s']" % sid).strip()

def paste_lesson(page, lesson, length=None):
    """Settings (story, default level), then the lesson pasted in step 3; returns the text of the messages."""
    page.click("#steps li[data-step='1']")
    page.fill("#topic", "כלב בגינה")
    if length: page.fill("#length", str(length))
    page.click("#makePrompt")
    page.click("#step2 [data-go='3']")
    page.fill("#response", json.dumps(lesson, ensure_ascii=False))
    page.click("#parseBtn")
    msgs = page.text_content("#parseMsgs")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    return msgs

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx, page = new_page(browser)
    plain = json.loads(page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    plain.pop("nikudMode", None)
    STORY_WORDS = page.evaluate("(s) => Hebrew.countWords(s)", plain["story"])
    targets = [t["word"] for t in plain["targetWords"]]

    # ---------- 1. Kind of text in the form ----------
    radios = page.eval_on_selector_all("#genreChoices input[name=genre]", "els => els.map(e => [e.value, e.checked, e.parentNode.textContent.trim()])")
    check(radios == [["story", True, "סיפור"], ["info", False, "טקסט מידעי"]], "form: סיפור (default) or טקסט מידעי: %s" % radios)
    page.check("input[name=level][value='3-4']")
    story_counts = page.evaluate("Levels.exerciseDefaults('3-4')")
    page.check("input[name=genre][value=info]")
    counts = page.eval_on_selector_all("[data-count]", "els => Object.fromEntries(els.map(e => [e.dataset.count, +e.value]))")
    check(counts["order"] == 0 and counts["message"] == 0 and counts["locate"] == story_counts["locate"] + story_counts["order"] + story_counts["message"]
          and counts["mcq"] == story_counts["mcq"], "informational text: no order or message questions by default; locating information instead (%s)" % counts)
    page.check("input[name=genre][value=story]")
    check(page.eval_on_selector_all("[data-count]", "els => Object.fromEntries(els.map(e => [e.dataset.count, +e.value]))") == story_counts,
          "back to a story: the level's defaults again")

    page.check("input[name=genre][value=info]")
    page.fill("#topic", "דבורים")
    page.fill("#length", "200")
    page.click("#makePrompt")
    info = page.text_content("#promptText")
    page.reload()
    check(page.locator("#genreChoices input:checked").get_attribute("value") == "info", "the kind of text is remembered with the settings")

    # ---------- 2. The writer's prompt ----------
    check(info.startswith("אתה סופר ישראלי מנוסה לילדים, שכותב ספרים לקוראים מתחילים.") and "כתוב טקסט מידעי קצר" in info
          and "סוג הטקסט: טקסט מידעי." in info, "info prompt: the writer's role and the kind of text")
    check(all(l in info for l in ["- נושא אחד.", "- משפט פתיחה שמציג את הנושא.", "- פסקה לכל תת-נושא.", "- משפט סיכום בסוף.", "- בלי עלילה ובלי דמויות בדיוניות."])
          and "מבנה הסיפור" not in info and "דמות מרכזית" not in info, "info prompt: the structure of an informational text, not a story's")
    lv = page.evaluate("Levels.get('3-4')")
    check(not any(l in info for l in lv["story"]), "info prompt: no dialogue/character lines of the level")
    ex_part = info.split("תרגילים (בסדר הזה):")[1].split("החזר את ה-JSON")[0]
    check("סיפור" not in ex_part and "מהטקסט" in ex_part, "info prompt: the exercise lines speak of 'הטקסט', not 'הסיפור'")
    check("מסר גלוי" not in ex_part and "סידור" not in ex_part, "info prompt: no order or message exercises (the defaults)")

    page.check("input[name=genre][value=story]")
    page.check("input[name=level][value='3-4']")
    page.fill("#topic", "ילד שמחפש את הכדור שלו בפארק")
    page.fill("#length", "200")
    page.fill("#wordCount", "4")
    page.click("#makePrompt")
    story = page.text_content("#promptText")
    expect = [
        "אתה סופר ישראלי מנוסה לילדים, שכותב ספרים לקוראים מתחילים.",
        "כשיש התנגשות בין איכות לבין דרישה מספרית (אורך, מספר הופעות של מילה), האיכות קובעת.",
        "- דמות מרכזית עם שם, שיש לה רצון או בעיה.",
        "- התחלה, אמצע וסוף ברורים.",
        "- מקום וזמן עקביים לאורך כל הסיפור.",
        "- כל משפט מקדם את העלילה.",
        "- מותר ורצוי דיאלוג קצר.",
        "אורך: בערך 200 מילים. סטייה של עד 20% (בין 160 ל-240 מילים) מותרת.",
        "- בחר 4 מילות יעד פשוטות ומוחשיות, שמשתלבות בסיפור באופן טבעי (לדוגמה: בסיפור על כדורגל, החפץ הוא \"כדור\", לא \"כדורגל\").",
        "- השתמש בכל מילה רק במשמעות הנכונה שלה, ובמקום שבו היא מתאימה באופן טבעי.",
        "- כל מילה מופיעה לפחות פעם אחת, ועדיף 2 עד 3 פעמים, אם זה טבעי.",
        "- אסור להמציא משפט או דמות רק כדי לשלב מילה.",
        "מילות קישור (ו, אבל, כי, אז, פתאום, כש-, ש-)",
        "בלי ז׳רגון",
        "בלי צירופים שנשמעים כמו תרגום",
        "- פסקאות: 3 עד 6 משפטים בכל פסקה. ירידת שורה רק בין פסקאות, לא אחרי כל משפט.",
        "קרא את הטקסט כאילו אתה מקריא אותו לילד, ותקן כל משפט שנשמע לא טבעי.",
    ]
    missing = [e for e in expect if e not in story]
    check(not missing, "story prompt: role, structure, target words, length, language, paragraphs, read aloud (missing: %s)" % missing)
    check("פסקאות, בכל פסקה" not in story and "לפחות פעמיים" not in story and "אתה כותב תוכן" not in story.split("תרגילים (בסדר הזה):")[0],
          "story prompt: no paragraph × sentence count, no 'at least twice', the old role is gone")
    check(all(("- " + l) in story for l in lv["language"] + lv["story"]) and all(("  - " + l) in story for l in lv["avoid"]),
          "story prompt: the level's language, story and 'avoid' lines")
    page.click("#steps li[data-step='1']")
    page.check("input[name=wordsMode][value=list]")
    page.fill("#wordList", "כדור, פארק, ספסל, חבר")
    page.click("#makePrompt")
    check("- מילות היעד: כדור, פארק, ספסל, חבר." in page.text_content("#promptText"), "story prompt: the teacher's words")
    page.check("input[name=wordsMode][value=number]") if page.is_visible("input[name=wordsMode][value=number]") else None
    ctx.close()

    # ---------- 3. Genre in the lesson ----------
    ctx, page = new_page(browser)
    page.check("input[name=genre][value=info]")
    paste_lesson(page, plain)
    page.wait_for_timeout(600)
    draft = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson")
    check(draft.get("genre") == "info", "the lesson keeps the kind of text from the settings (genre: info)")
    check(page.evaluate("Lesson.decode(Lesson.encode(%s)).genre" % json.dumps(dict(plain, genre="info"), ensure_ascii=False)) == "info"
          and page.evaluate("Lesson.coerce(%s).lesson.genre" % json.dumps(plain, ensure_ascii=False)) == "story",
          "genre survives the link; a lesson without one is a story")
    check("genre" not in page.evaluate("Lesson.clean(%s)" % json.dumps(dict(plain, genre="story"), ensure_ascii=False)),
          "a story's link has no genre field (old links and print sheets unchanged)")
    check(page.locator("#editor input[name=edGenre][value=info]").is_checked(), "editor: the kind of text can be changed")
    page.check("#editor input[name=edGenre][value=story]")
    page.wait_for_timeout(600)
    check(page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.genre") == "story", "editor: changing it updates the lesson")

    # ---------- 4. Review prompt: editing checks ----------
    rp = page.evaluate("Review.buildReviewPrompt(Object.assign({}, %s, {level: '3-4', genre: 'story'}))" % json.dumps(plain, ensure_ascii=False))
    for needle, what in [("רצף ומילות קישור", "flow and connectives"), ("משפטי מילוי", "filler sentences"), ("היגיון ועקביות", "logic and consistency"),
                         ("ז׳רגון", "jargon"), ("שפה ספרותית גבוהה", "high language"), ("נשמעים כמו תרגום", "unnatural phrases"),
                         ("במשמעות שגויה היא error", "target words in a wrong sense"), ("ערבוב סוגי טקסט", "mixed kinds of text"),
                         ("לא מתאים לרמה: " + lv["avoid"][0], "the level's 'avoid' lines")]:
        check(needle in rp, "review prompt: " + what)
    check(all(t in rp for t in targets) and "סוג הטקסט: סיפור" in rp and "הסבר" in rp, "review prompt: the target words and the kind of text")
    rpi = page.evaluate("Review.buildReviewPrompt(Object.assign({}, %s, {level: '3-4', genre: 'info'}))" % json.dumps(plain, ensure_ascii=False))
    check("סוג הטקסט: טקסט מידעי" in rpi and "עלילה או דמויות בדיוניות בתוך טקסט מידעי" in rpi, "review prompt (info): checks for story inside an informational text")

    # ---------- 5. Letters of another script ----------
    bad = json.loads(json.dumps(plain, ensure_ascii=False))
    first = bad["story"].split(" ")[0]
    bad["story"] = bad["story"].replace(first, first + "ة", 1)            # ة after a Hebrew word: fixed to ה
    bad["title"] = "הכלב של דωן"  # Greek ω inside דון: an error
    msgs = paste_lesson(page, bad)
    check("תוקנו אותיות ממערכת כתב אחרת בתוך מילים עבריות (1): ة → ה." in msgs, "ة inside a Hebrew word: fixed to ה, with a note")
    check("המילה \"דωן\" כוללת אות ביוונית (ω)" in msgs, "a Greek letter inside a Hebrew word: an error (%s)" % msgs[:200])
    page.wait_for_timeout(300)
    check(page.is_disabled("#makeLink") and "ביוונית" in page.text_content("#checkMsgs"), "the error blocks the link until it is fixed")
    check(page.evaluate("Lesson.mixedWords('hello שלום world ילדי')") == [] and
          page.evaluate("Lesson.mixedWords('שלוםabc')") == [{"word": "שלוםabc", "letters": ["a", "b", "c"]}],
          "separate words in another script are fine; Latin letters glued to a Hebrew word are not")

    # ---------- 6. Lines instead of paragraphs ----------
    sentences = page.evaluate("(s) => Lesson.sentencesOf(s)", plain["story"])
    lined = dict(plain, story="\n".join(sentences))
    msgs = paste_lesson(page, lined)
    check(len(sentences) >= 6 and "הטקסט מחולק לשורות במקום לפסקאות" in msgs, "one sentence per line: warning (%d lines)" % len(sentences))
    page.wait_for_timeout(300)
    check(page.is_visible("#checkMsgs #joinParagraphs"), "the preview warning has an 'אחד לפסקאות' button")
    page.click("#checkMsgs #joinParagraphs")
    page.wait_for_timeout(600)
    joined = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft')).lesson.story")
    paras = [x for x in joined.split("\n") if x.strip()]
    check(2 <= len(paras) <= len(sentences) // 3 + 1 and page.evaluate("(s) => Lesson.sentencesOf(s).length", joined) == len(sentences)
          and "מחולק לשורות" not in page.text_content("#checkMsgs"),
          "joined: %d lines → %d paragraphs, every sentence kept, the warning is gone" % (len(sentences), len(paras)))
    check(page.input_value("#editor textarea") == joined if page.locator("#editor textarea").count() else True, "the editor shows the joined story")
    check(not page.evaluate("Lesson.lineBroken('משפט אחד. משפט שתיים.\\nמשפט שלוש. משפט ארבע.\\nמשפט חמש.')"),
          "real paragraphs (most with more than one sentence): no warning")
    check(page.evaluate("Lesson.joinParagraphs('א.\\nב.\\nג.\\nד.\\nה.\\nו.\\nז.\\nח.\\nט.\\nי.')").split("\n") == ["א. ב. ג.", "ד. ה. ו. ז.", "ח. ט. י."],
          "10 one-sentence lines → paragraphs of 3, 4 and 3")

    # ---------- 7. Length: 20% ----------
    near = page.evaluate("(s) => Lesson.check(s, {length: Math.round(Hebrew.countWords(s.story) / 1.18)}).warnings", dict(plain, genre="story"))
    far = page.evaluate("(s) => Lesson.check(s, {length: Math.round(Hebrew.countWords(s.story) / 1.3)}).warnings", dict(plain, genre="story"))
    check(not any("אורך הסיפור" in w for w in near) and any("אורך הסיפור" in w for w in far), "length: 18% over is fine, 30% over is a warning")
    ctx.close()

    # ---------- 8. The editor in the automatic flow ----------
    story_json = json.dumps({k: plain[k] for k in ("title", "topic", "targetWords", "story")}, ensure_ascii=False)
    ex_json = json.dumps({"exercises": [dict(e, answer=str(e["answer"]).lower()) if "answer" in e else e for e in plain["exercises"]]}, ensure_ascii=False)
    edited = "בוקר אחד, " + plain["story"]

    def auto_run(edit_answer, genre="story"):
        mock = MockApi({"write": story_json, "edit": edit_answer, "exercises": ex_json, "review": "[]"})
        ctx, page = new_page(browser, mock, key=KEY)
        page.check("input[name=genre][value=%s]" % genre)
        page.fill("#topic", "כלב בגינה")
        page.fill("#length", str(STORY_WORDS))
        page.fill("#wordCount", str(len(targets)))
        page.check("input[name=nikud][value=none]")
        page.click("#autoCreate")
        wait_stage(page, "review", "done")
        return ctx, page, mock

    ctx, page, mock = auto_run(json.dumps({"story": edited}, ensure_ascii=False))
    stages = page.eval_on_selector_all("#autoStages li", "els => els.map(e => e.dataset.stage)")
    check(stages[:3] == ["write", "edit", "exercises"] and "הסיפור נערך" in stage_text(page, "edit"), "stages: write → edit ('הסיפור נערך') → exercises")
    levels = [(x["kind"], x["body"]["generationConfig"]["thinkingConfig"]["thinkingLevel"]) for x in mock.log]
    check(levels == [("write", "medium"), ("edit", "medium"), ("exercises", "low"), ("review", "low")],
          "thinking: medium for writing and editing, low for exercises and review (%s)" % levels)
    ep = mock.of("edit")[0]["prompt"]
    check(ep.startswith("אתה עורך ספרי ילדים מנוסה.") and plain["story"] in ep and "הכותרת: " + plain["title"] in ep
          and ("- מילות היעד: " + ", ".join(targets) + ".") in ep and "- סוג הטקסט: סיפור." in ep
          and ("- האורך: בטיוטה %d מילים." % STORY_WORDS) in ep and "קרא את הטקסט כאילו אתה מקריא אותו לילד" in ep,
          "edit prompt: role, the draft, target words, kind of text, length and read aloud")
    check(edited in mock.of("exercises")[0]["prompt"] and page.evaluate("JSON.parse(document.querySelector('#response').value).story") == edited,
          "the exercises are written on the edited story, and the lesson has it")
    ctx.close()

    lost = plain["story"].replace(targets[0], "חפץ")
    ctx, page, mock = auto_run(json.dumps({"story": lost}, ensure_ascii=False))
    check("העריכה לא נשמרה (נעלמה מילת היעד " + targets[0] + ")" in stage_text(page, "edit")
          and page.evaluate("JSON.parse(document.querySelector('#response').value).story") == plain["story"],
          "an edit without a target word is not used: the draft is kept (%s)" % stage_text(page, "edit"))
    ctx.close()

    # Half the story, with every target word added at the end so only the length is wrong.
    half = " ".join(plain["story"].split(" ")[: STORY_WORDS // 2]) + " " + " ".join(targets) + "."
    ctx, page, mock = auto_run(json.dumps({"story": half}, ensure_ascii=False))
    check("העריכה לא נשמרה (האורך השתנה מ-%d ל-" % STORY_WORDS in stage_text(page, "edit"),
          "an edit half as long is not used (%s)" % stage_text(page, "edit"))
    ctx.close()

    ctx, page, mock = auto_run((400, {"error": {"code": 400, "message": "bad", "status": "INVALID_ARGUMENT"}}))
    check("העריכה לא הצליחה" in stage_text(page, "edit") and "ממשיכים עם הטיוטה" in stage_text(page, "edit")
          and len(mock.of("exercises")) == 1 and page.evaluate("JSON.parse(document.querySelector('#response').value).story") == plain["story"],
          "the edit call failed: the flow goes on with the draft")
    ctx.close()

    ctx, page, mock = auto_run(json.dumps({"story": plain["story"]}, ensure_ascii=False), genre="info")
    ep = mock.of("edit")[0]["prompt"]
    check("טיוטה של טקסט מידעי קצר" in ep and "- סוג הטקסט: טקסט מידעי. אל תהפוך אותו לסיפור" in ep and "אותן עובדות" in ep,
          "edit prompt (info): keeps the facts and the kind of text")
    check(mock.of("write")[0]["prompt"].count("מבנה הטקסט המידעי:") == 1 and "הטקסט:" in mock.of("exercises")[0]["prompt"],
          "automatic flow (info): the writer and the exercises get the informational text's prompts")
    ctx.close()

    check(not errors, "no page errors (%s)" % errors[:3])
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
