"""Idea → plan → writing, like an author. The prompts (ideas, plan, writing from the plan, the copy-paste prompt with
its plan field first), the style examples (js/examples.js), the plan of a pasted answer shown in the preview but not
kept in the lesson, and the teacher's turns in the automatic flow against a mock API: idea cards, "3 רעיונות חדשים",
her own idea, the outline editor (edit, delete, add, checks), and the way back after a failed plan or writing call."""
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
    return "data: " + json.dumps({"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]},
                                 ensure_ascii=False) + "\r\n\r\n"

def kind_of(body):
    schema = body["generationConfig"]["responseSchema"]
    if schema["type"] == "ARRAY": return "review"
    props = schema["properties"]
    if "lines" in props: return "nikud"
    if "ideas" in props: return "ideas"
    if "scenes" in props: return "plan"
    if "story" in props: return "edit" if body["contents"][0]["parts"][0]["text"].startswith("אתה עורך") else "write"
    return "exercises"

INTERNAL = (500, {"error": {"code": 500, "message": "internal", "status": "INTERNAL"}})

class MockApi:
    """Fixed answers per kind of call; queue[kind] (HTTP errors as (status, body)) is answered first."""
    def __init__(self, answers):
        self.answers = answers
        self.queue = {}
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
        q = self.queue.get(kind)
        a = q.pop(0) if q else self.answers[kind]
        if callable(a): a = a(len(self.of(kind)))
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
    page.evaluate("Gemini.config.retryDelay = 100; Gemini.config.busyDelays = [100]")
    return ctx, page

def wait_stage(page, sid, cls, timeout=15000):
    page.wait_for_function("([s, c]) => { const li = document.querySelector('#autoStages li[data-stage=\"' + s + '\"]'); return li && li.className === c; }",
                           arg=[sid, cls], timeout=timeout)

def stage_text(page, sid):
    return page.text_content("#autoStages li[data-stage='%s']" % sid).strip()

def flow_msgs(page): return page.text_content("#autoFlowMsgs") or ""

S = {"topic": "ילד שמחפש את הכדור שלו בפארק", "length": 200, "level": "3-4", "genre": "story", "wordsMode": "number", "wordCount": 4, "words": []}
IDEA = {"title": "הכדור שנעלם", "character": "יואב", "want": "למצוא את הכדור", "obstacle": "מחשיך", "ending": "הכלב מוצא אותו.",
        "words": [{"word": "כדור", "use": "החפץ"}, {"word": "ספסל", "use": "עומד עליו"}, {"word": "שיח", "use": "הכדור בו"}, {"word": "כלב", "use": "עוזר"}]}
PLAN = {"title": "הכדור שנעלם", "idea": "הכדור שנעלם. יואב מחפש.", "targetWords": [{"word": "כדור", "emoji": "⚽"}, {"word": "כלב", "emoji": "🐶"}],
        "scenes": [{"what": "יואב בועט והכדור נעלם", "feeling": "בהלה", "words": ["כדור"], "length": 60},
                   {"what": "הכלב מוצא את הכדור", "feeling": "שמחה", "words": ["כלב", "כדור"], "length": 140}]}

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    ctx, page = new_page(browser)
    plain = json.loads(page.evaluate("(s) => Hebrew.stripNikud(s)", json.dumps(sample, ensure_ascii=False)))
    plain.pop("nikudMode", None)
    targets = [t["word"] for t in plain["targetWords"]]
    lv = page.evaluate("Levels.get('3-4')")

    # ---------- 1. The ideas prompt ----------
    ip = page.evaluate("(s) => buildIdeasPrompt(s, [])", S)
    check(ip.startswith("אתה סופר ישראלי מנוסה לילדים") and "הצע 3 רעיונות שונים לסיפור." in ip and "נושא: " + S["topic"] in ip
          and "רמת קריאה: ג׳–ד׳." in ip and "אורך: בערך 200 מילים." in ip, "ideas: the writer's role, 3 ideas, topic, level and length")
    check(all(l in ip for l in ["- title: כותרת.", "- character: הדמות המרכזית ושמה.", "- want: מה היא רוצה.", "- obstacle: מה מפריע לה.",
                                "- ending: איך זה נגמר, ב-2 עד 3 משפטים.", "- words: איך כל מילת יעד משתלבת בסיפור באופן טבעי"]),
          "ideas: per idea a title, the character and name, the wish, the obstacle, the ending in 2–3 sentences, how each word fits")
    check("- בחר 4 מילות יעד" in ip and "- בחר אותן מתוך העלילה" in ip and "אל תחזור" not in ip,
          "ideas: when the AI chooses the words, it chooses them here, from the plot")
    check('"ideas": [' in ip and '"character": "הדמות ושמה"' in ip, "ideas: the JSON example")
    ipl = page.evaluate("(s) => buildIdeasPrompt(s, ['א', 'ב'])", dict(S, wordsMode="list", words=["כדור", "פארק"]))
    check("- מילות היעד: כדור, פארק. כל רעיון משלב את כולן." in ipl and "בחר 4" not in ipl and "שכבר הוצעו: א; ב." in ipl,
          "ideas: the teacher's words in every idea; ideas already shown are not repeated")
    ipi = page.evaluate("(s) => buildIdeasPrompt(s, [])", dict(S, genre="info", topic="דבורים"))
    check("הצע 3 זוויות שונות לנושא." in ipi and "- angle: הזווית ב-2 עד 3 משפטים" in ipi and "character" not in ipi and "לכל זווית:" in ipi,
          "ideas (info): 3 angles on the topic, no character")

    # ---------- 2. The plan prompt ----------
    pp = page.evaluate("([s, i]) => buildPlanPrompt(s, i)", [S, IDEA])
    check("תכנן סיפור קצר" in pp and "הרעיון: הכדור שנעלם. הדמות המרכזית: יואב. מה היא רוצה: למצוא את הכדור." in pp
          and "איך זה נגמר: הכלב מוצא אותו." in pp, "plan: the chosen idea, as text")
    check("- scenes: מתווה של 3 עד 5 סצנות" in pp and "  - what: מה קורה בה." in pp and "  - feeling: הרגש של הדמות בסצנה." in pp
          and "  - words: מילות היעד שמופיעות בה." in pp and "סכום האורכים: בערך 200 מילים." in pp,
          "plan (200 words): 3–5 scenes, each with what happens, the feeling, the target words and its length")
    check("מבנה הסיפור:" in pp and "- דמות מרכזית עם שם, שיש לה רצון או בעיה." in pp and "- מילות היעד: כדור, ספסל, שיח, כלב." in pp
          and "אימוג׳י" in pp and '"scenes": [' in pp, "plan: the story's structure, the idea's words with their emoji, the JSON example")
    ppo = page.evaluate("(s) => buildPlanPrompt(s, {own: 'דנה רוצה לטפס על עץ'})", S)
    check("הרעיון (של המורה): דנה רוצה לטפס על עץ" in ppo and "- בחר 4 מילות יעד" in ppo, "plan: the teacher's own idea; the AI chooses the words then")
    ppl = page.evaluate("([s, i]) => buildPlanPrompt(s, i)", [dict(S, wordsMode="list", words=["עץ", "ענף"]), IDEA])
    check("- מילות היעד: עץ, ענף." in ppl, "plan: the teacher's list wins over the idea's words")
    ppi = page.evaluate("(s) => buildPlanPrompt(s, {title: 'איך דבורים מדברות', angle: 'ריקוד הדבורים.', words: []})", dict(S, genre="info", topic="דבורים"))
    check("הזווית: איך דבורים מדברות. ריקוד הדבורים." in ppi and "תתי-נושאים" in ppi and "  - facts: העובדות המרכזיות" in ppi
          and "מבנה הטקסט המידעי:" in ppi and "feeling" not in ppi, "plan (info): subtopics with their key facts")

    # Scenes by length: up to 80 words 2–3, up to 250 3–5, longer 4–6; the same in the copy-paste prompt
    ranges = page.evaluate("""() => [60, 80, 81, 250, 251, 900].map(n => {
      const s = {topic: 'x', length: n, level: '3-4', genre: 'story', wordsMode: 'number', wordCount: 4, words: []};
      const plan = buildPlanPrompt(s, {own: 'רעיון'}), paste = buildPrompt(s), info = buildPlanPrompt(Object.assign({}, s, {genre: 'info'}), {own: 'x'});
      return [n, Prompt.sceneRange(n), plan.match(/מתווה של (\\d) עד (\\d) סצנות/).slice(1).join('-'),
              paste.match(/מתווה של (\\d) עד (\\d) סצנות/).slice(1).join('-'), info.match(/מתווה של (\\d) עד (\\d) תתי-נושאים/).slice(1).join('-')]; })""")
    want = {60: "2-3", 80: "2-3", 81: "3-5", 250: "3-5", 251: "4-6", 900: "4-6"}
    check(all(r[2] == r[3] == r[4] == want[r[0]] == "%d-%d" % (r[1]["min"], r[1]["max"]) for r in ranges),
          "scenes by length (≤80: 2–3, ≤250: 3–5, more: 4–6), in the plan, the copy-paste prompt and for subtopics (%s)" % [(r[0], r[2], r[3]) for r in ranges])

    # Levels: sentence length in words, not numbers; variety kept
    sent = page.evaluate("Levels.LIST.map(l => l.sentence)")
    check(not any(c.isdigit() for l in sent for c in l) and "קצרים מאוד" in sent[0] and "בדרך כלל קצרים" in sent[1] and "באורך בינוני" in sent[2]
          and "בינוני עד ארוך" in sent[3] and all(("מגוונים" in l or "לא כולם באותו אורך" in l or "חבר אותם" in l) for l in sent),
          "levels: sentence length without numbers, variety kept (%s)" % sent)

    # ---------- 3. The writing prompt ----------
    wp = page.evaluate("([s, p]) => buildStoryPrompt(s, p)", [S, PLAN])
    check("לפי התכנון שלמטה." in wp and "הכותרת: הכדור שנעלם" in wp and "הרעיון: הכדור שנעלם. יואב מחפש." in wp
          and "1. יואב בועט והכדור נעלם (הרגש: בהלה. מילות יעד: כדור. בערך 60 מילים.)" in wp
          and "2. הכלב מוצא את הכדור (הרגש: שמחה. מילות יעד: כלב, כדור. בערך 140 מילים.)" in wp,
          "writing: the plan, scene by scene, with the feeling, the words and the length")
    check("מילות יעד: כדור, כלב." in wp and "- אסור להמציא משפט או דמות רק כדי לשלב מילה." in wp and "קרא את הטקסט כאילו" in wp
          and all(("- " + l) in wp for l in lv["language"]), "writing: the target words, the language rules of the level, read aloud")
    gl = page.evaluate("Prompt.GENRE_LINES.story")
    check(not any(l in wp for l in gl) and "מבנה הסיפור" not in wp and "תרגילים (" not in wp,
          "writing: no story-structure rules (the plan has them), short and focused")
    ex = page.evaluate("StyleExamples.get('3-4', 'story')")
    check("דוגמה לסגנון הכתיבה ברמה הזו (לא לנושא ולא לתוכן):\n---\n" + ex + "\n---" in wp, "writing: the level's style example")
    wpi = page.evaluate("([s, p]) => buildStoryPrompt(s, p)", [dict(S, genre="info", level="1-2"),
                        dict(PLAN, scenes=[{"what": "הכוורת", "facts": "דבורים גרות יחד", "words": [], "length": 50}])])
    check("1. הכוורת: דבורים גרות יחד (בערך 50 מילים.)" in wpi and page.evaluate("StyleExamples.get('1-2', 'info')") in wpi and "הזווית: " in wpi,
          "writing (info): subtopics with their facts, the informational example of the level")

    # ---------- 4. Style examples ----------
    all_ex = page.evaluate("Levels.LIST.map(l => [l.id, StyleExamples.get(l.id, 'story'), StyleExamples.get(l.id, 'info')])")
    flat = [e for _, st, inf in all_ex for e in (st, inf)]
    check(len(all_ex) == 4 and all(len(e) > 60 for e in flat) and len(set(flat)) == 8,
          "js/examples.js: a paragraph for every level and kind of text, all different")
    check(not any(c for e in flat for c in e if 0x0591 <= ord(c) <= 0x05C7), "style examples: no nikud")
    check(page.evaluate("StyleExamples.get('x', 'story')") == "", "unknown level: no example")

    # ---------- 5. The copy-paste prompt: plan first ----------
    cp = page.evaluate("(s) => buildPrompt(s)", S)
    check("קודם תכנן, אחר כך כתוב לפי התכנון." in cp and "תכנון (בשדה plan, לפני הסיפור):" in cp and "- idea: הרעיון ב-2 עד 3 משפטים" in cp
          and "- scenes: מתווה של 3 עד 5 סצנות" in cp and "כתיבה (בשדה story):" in cp and "דוגמה לסגנון הכתיבה ברמה הזו" in cp,
          "copy-paste: plan first, then write from it, with the style example")
    example = json.loads(cp.split("כתוב את מספר הסצנות והתרגילים שביקשתי):\n", 1)[1])
    keys = list(example.keys())
    check(keys.index("plan") < keys.index("story") and keys.index("plan") == 1 and set(example["plan"]) == {"idea", "scenes"}
          and set(example["plan"]["scenes"][0]) == {"what", "feeling", "words", "length"}, "copy-paste JSON: the plan field comes before the story (%s)" % keys)
    cpi = page.evaluate("(s) => buildPrompt(s)", dict(S, genre="info"))
    exi = json.loads(cpi.split("שביקשתי):\n", 1)[1])
    check("לפני הטקסט" in cpi and set(exi["plan"]["scenes"][0]) == {"what", "facts", "words", "length"}, "copy-paste (info): subtopics with facts")

    # ---------- 6. A pasted plan: shown in the preview, not kept in the lesson ----------
    page.fill("#topic", "כלב בגינה")
    page.click("#makePrompt")
    page.click("#step2 [data-go='3']")
    pasted = {"version": 1, "plan": {"idea": "דני מחפש את הכלב.", "scenes": [{"what": "הכלב בורח", "feeling": "פחד", "words": "כלב, גינה", "length": "40"},
                                                                            {"what": "דני מוצא אותו", "feeling": "שמחה", "words": [], "length": 30}]}}
    pasted.update({k: v for k, v in plain.items()})
    page.fill("#response", json.dumps(pasted, ensure_ascii=False))
    page.click("#parseBtn")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    page.wait_for_selector("#step4:not([hidden])")
    check(page.is_visible("#planView") and "התכנון של הבינה" in page.text_content("#planView summary"), "preview: the plan, folded")
    page.click("#planView summary")
    body = page.text_content("#planViewBody")
    check("הרעיון: דני מחפש את הכלב." in body and "הכלב בורח" in body and "הרגש: פחד" in body and "מילות יעד: כלב, גינה" in body
          and "בערך 40 מילים" in body and page.locator("#planViewBody li").count() == 2, "preview: the idea and the scenes (%s)" % body[:120])
    page.wait_for_timeout(600)
    draft = page.evaluate("JSON.parse(localStorage.getItem('readingApp.draft'))")
    check("plan" not in draft["lesson"] and "plan" not in json.dumps(draft, ensure_ascii=False)
          and "plan" not in page.evaluate("Lesson.decode(Lesson.encode(Lesson.coerce(%s).lesson))" % json.dumps(pasted, ensure_ascii=False)),
          "the plan is not kept: not in the lesson, the draft or the link")
    page.click("#steps li[data-step='3']")
    page.fill("#response", json.dumps(plain, ensure_ascii=False))
    page.click("#parseBtn")
    if page.is_visible("#continueAnyway"): page.click("#continueAnyway")
    page.wait_for_selector("#step4:not([hidden])")
    check(page.is_hidden("#planView"), "an answer without a plan: nothing shown")
    check(page.evaluate("Lesson.coercePlan(null)") is None and page.evaluate("Lesson.coercePlan({scenes: ['רק טקסט']})") ==
          {"idea": "", "scenes": [{"what": "רק טקסט", "feeling": "", "facts": "", "words": [], "length": 0}]},
          "Lesson.coercePlan: none → null; a scene given as plain text")
    ctx.close()

    # ---------- 7. The teacher's turns in the automatic flow ----------
    story_json = json.dumps({"story": plain["story"]}, ensure_ascii=False)
    ex_json = json.dumps({"exercises": [dict(e, answer=str(e["answer"]).lower()) if "answer" in e else e for e in plain["exercises"]]}, ensure_ascii=False)
    def ideas_json(n):
        return json.dumps({"ideas": [{"title": "רעיון %d-%d" % (n, i), "character": "דני %d" % i, "want": "לשחק", "obstacle": "גשם", "ending": "השמש יוצאת.",
                                      "angle": "זווית %d-%d" % (n, i), "words": [{"word": t, "use": "בגן"} for t in targets]} for i in range(1, 4)]}, ensure_ascii=False)
    plan_json = json.dumps({"title": plain["title"], "targetWords": plain["targetWords"],
                            "scenes": [{"what": "סצנה %d" % i, "feeling": "רגש %d" % i, "facts": "עובדה %d" % i, "words": targets[:1], "length": 25} for i in range(1, 5)]},
                           ensure_ascii=False)
    def answers():
        return {"ideas": ideas_json, "plan": plan_json, "write": story_json, "edit": story_json, "exercises": ex_json, "review": "[]"}

    def start(genre="story"):
        mock = MockApi(answers())
        ctx, page = new_page(browser, mock, key=KEY)
        page.check("input[name=genre][value=%s]" % genre)
        page.fill("#topic", "כלב בגינה")
        page.fill("#wordCount", str(len(targets)))
        page.check("input[name=nikud][value=none]")
        return mock, ctx, page

    mock, ctx, page = start()
    page.click("#autoCreate")
    wait_stage(page, "choose", "wait")
    card = page.text_content(".idea-card[data-idea='1']")
    check(page.locator(".idea-card").count() == 3 and "רעיון 1-2" in card and "הדמות: דני 2" in card and "רוצה: לשחק" in card
          and "מה מפריע: גשם" in card and "הסוף: השמש יוצאת." in card and (targets[0] + ": בגן") in card,
          "card: title, character, wish, obstacle, ending, how each word fits")
    check(page.is_visible("#autoPlan button:has-text('3 רעיונות חדשים')") and page.is_visible("#autoPlan button:has-text('רעיון משלי')"),
          "cards: '3 רעיונות חדשים' and 'רעיון משלי'")
    page.click("#autoPlan button:has-text('3 רעיונות חדשים')")
    page.wait_for_function("() => (document.querySelector('.idea-card') || {}).textContent?.includes('רעיון 2-1')", timeout=15000)
    second = mock.of("ideas")[1]["prompt"]
    check("שכבר הוצעו: רעיון 1-1; רעיון 1-2; רעיון 1-3." in second and page.get_attribute("#autoStages li[data-stage=choose]", "class") == "wait",
          "3 new ideas: the ones shown are not repeated")
    page.click("#autoPlan button:has-text('רעיון משלי')")
    page.click("#autoPlan button:has-text('תכנון לפי הרעיון שלי')")
    check("כתבו את הרעיון." in page.text_content("#autoPlan") and len(mock.of("plan")) == 0, "own idea, empty: asked to write it")
    page.fill("#ownIdea", "דני מאבד את הכלב בגן, ומוצא אותו בזכות הנביחות")
    page.click("#autoPlan button:has-text('תכנון לפי הרעיון שלי')")
    wait_stage(page, "approvePlan", "wait")
    check("הרעיון (של המורה): דני מאבד את הכלב בגן, ומוצא אותו בזכות הנביחות" in mock.of("plan")[0]["prompt"]
          and "נבחר רעיון משלכם" in stage_text(page, "choose"), "own idea: sent to the plan call as the teacher's")

    # The outline editor
    check(page.locator(".plan-scene").count() == 4 and page.input_value(".plan-scene[data-scene='0'] [data-f=feeling]") == "רגש 1"
          and page.input_value(".plan-scene[data-scene='0'] [data-f=words]") == targets[0] and page.input_value(".plan-scene[data-scene='0'] [data-f=length]") == "25"
          and "סך הכול בערך 100 מילים" in page.text_content("#planTotal") and page.locator(".plan-word").count() == len(targets),
          "outline: every scene editable (what, feeling, words, length), the target words with emoji, the total")
    check("הרעיון: דני מאבד את הכלב" in page.text_content("#autoPlan"), "outline: the idea above it")
    page.fill(".plan-scene[data-scene='1'] [data-f=length]", "60")
    check("סך הכול בערך 135 מילים" in page.text_content("#planTotal"), "outline: the total follows the lengths")
    page.click(".plan-scene[data-scene='3'] button[aria-label='מחיקה']")
    page.click("#autoPlan button:has-text('+ סצנה')")
    page.fill(".plan-scene[data-scene='3'] [data-f=what]", "סצנה חדשה של המורה")
    page.fill("#planTitle", "כותרת של המורה")
    page.fill(".plan-word >> nth=0 >> input[aria-label='מילת יעד']", targets[0])
    for i in range(1, len(targets)):
        page.fill(".plan-word >> nth=%d >> input[aria-label='מילת יעד']" % i, "")
    page.click("#writeFromPlan")
    check("צריך לפחות 2 מילות יעד." in page.text_content("#autoPlan") and len(mock.of("write")) == 0, "outline check: at least 2 target words")
    page.fill(".plan-word >> nth=0 >> input[aria-label='מילת יעד']", targets[0])
    page.fill(".plan-word >> nth=1 >> input[aria-label='מילת יעד']", targets[1])
    mock.queue["write"] = [INTERNAL, INTERNAL]
    page.click("#writeFromPlan")
    wait_stage(page, "write", "fail")
    wp = mock.of("write")[0]["prompt"]
    check("הכותרת: כותרת של המורה" in wp and "4. סצנה חדשה של המורה" in wp and "סצנה 4" not in wp and "בערך 60 מילים" in wp
          and "מילות יעד: %s, %s." % (targets[0], targets[1]) in wp, "writing prompt: the teacher's edits (title, deleted and added scenes, length, words)")
    check("הכתיבה לא הצליחה" in stage_text(page, "write") and page.is_visible("#autoFlowMsgs button:has-text('חזרה למתווה')")
          and "הפרומפט מוכן" in flow_msgs(page), "writing failed: try again, back to the outline, or copy-paste")
    page.click("#autoFlowMsgs button:has-text('חזרה למתווה')")
    wait_stage(page, "approvePlan", "wait")
    check(page.input_value("#planTitle") == "כותרת של המורה" and page.locator(".plan-scene").count() == 4 and flow_msgs(page) == ""
          and page.get_attribute("#autoStages li[data-stage=write]", "class") == "todo", "back to the outline: the edits are kept")
    page.click("#writeFromPlan")
    wait_stage(page, "review", "done")
    resp = json.loads(page.input_value("#response"))
    check(resp["title"] == "כותרת של המורה" and [t["word"] for t in resp["targetWords"]] == targets[:2],
          "the lesson takes the title and the target words from the outline")
    page.click("#steps li[data-step='4']")
    check(page.is_visible("#planView") and "סצנה חדשה של המורה" in page.text_content("#planViewBody")
          and "דני מאבד את הכלב" in page.text_content("#planViewBody"), "after the flow, the preview shows the plan too")
    ctx.close()

    # Failures before the outline
    mock, ctx, page = start()
    mock.queue["ideas"] = [INTERNAL, INTERNAL]
    page.click("#autoCreate")
    wait_stage(page, "ideas", "fail")
    check("לא הצלחתי להביא רעיונות" in stage_text(page, "ideas") and page.is_visible("#step2") and page.is_hidden("#autoPlan")
          and page.get_attribute("#autoStages li[data-stage=write]", "class") == "skip", "ideas failed: message, copy-paste ready, the rest skipped")
    page.click("#autoFlowMsgs button:has-text('לנסות שוב')")
    wait_stage(page, "choose", "wait")
    check(page.locator(".idea-card").count() == 3, "ideas: tried again")
    mock.queue["plan"] = [INTERNAL, INTERNAL]
    page.click(".idea-card[data-idea='2'] button")
    wait_stage(page, "plan", "fail")
    check("התכנון לא הצליח" in stage_text(page, "plan") and "רעיון" in mock.of("plan")[0]["prompt"], "plan failed")
    page.click("#autoFlowMsgs button:has-text('חזרה לרעיונות')")
    wait_stage(page, "choose", "wait")
    check(page.locator(".idea-card").count() == 3 and len(mock.of("ideas")) == 3 and page.get_attribute("#autoStages li[data-stage=plan]", "class") == "todo",
          "back to the ideas: the same cards, no new call")
    page.click(".idea-card[data-idea='0'] button")
    wait_stage(page, "approvePlan", "wait")
    page.click("#autoPlan button:has-text('חזרה לרעיונות')")
    wait_stage(page, "choose", "wait")
    check(page.locator(".idea-card").count() == 3, "from the outline back to the ideas")
    page.click("#steps li[data-step='1']")
    page.click("#makePrompt")
    check(page.is_hidden("#autoFlow") and page.is_hidden("#autoPlan"), "'יצירת פרומפט' leaves the flow")
    ctx.close()

    # Informational text
    mock, ctx, page = start("info")
    page.click("#autoCreate")
    wait_stage(page, "choose", "wait")
    check("הזווית: זווית 1-1" in page.text_content(".idea-card[data-idea='0']") and "הדמות" not in page.text_content(".idea-card[data-idea='0']")
          and page.is_visible("#autoPlan button:has-text('3 זוויות חדשות')") and "בחרו זווית" in stage_text(page, "choose"),
          "info: angle cards")
    page.click(".idea-card[data-idea='0'] button")
    wait_stage(page, "approvePlan", "wait")
    check(page.locator(".plan-scene [data-f=facts]").count() == 4 and page.locator(".plan-scene [data-f=feeling]").count() == 0
          and page.text_content("#writeFromPlan").strip() == "✍️ כתוב את הטקסט" and "תת-נושא 1" in page.text_content(".plan-scene[data-scene='0']"),
          "info: the outline has subtopics with their key facts; 'כתוב את הטקסט'")
    check("הזווית: רעיון 1-1. זווית 1-1" in mock.of("plan")[0]["prompt"], "info: the chosen angle goes to the plan call")
    page.click("#writeFromPlan")
    wait_stage(page, "review", "done")
    check("1. סצנה 1: עובדה 1" in mock.of("write")[0]["prompt"], "info: the writer gets the subtopics and facts")
    ctx.close()

    # Fast mode: the first idea and the outline are approved automatically; both still shown in the preview
    mock, ctx, page = start()
    check(page.is_visible("#fastModeBox") and not page.is_checked("#fastMode"), "fast mode: a checkbox next to 'צור שיעור', off by default")
    page.check("#fastMode")
    page.reload()
    check(page.is_checked("#fastMode"), "fast mode: remembered")
    page.fill("#topic", "כלב בגינה")
    page.fill("#wordCount", str(len(targets)))
    page.check("input[name=nikud][value=none]")
    page.click("#autoCreate")
    wait_stage(page, "review", "done")
    check("נבחר אוטומטית: רעיון 1-1" in stage_text(page, "choose") and "אושר אוטומטית" in stage_text(page, "approvePlan")
          and len(mock.of("write")) == 1 and "רעיון 1-1" in mock.of("plan")[0]["prompt"], "fast mode: the first idea, the outline approved, written without stops")
    page.click("#steps li[data-step='4']")
    page.click("#planView summary")
    pv = page.text_content("#planViewBody")
    check("הרעיונות שהוצעו:" in pv and all("רעיון 1-%d" % i in pv for i in (1, 2, 3)) and "רעיון 1-1" in page.text_content("#planViewBody .chosen")
          and "סצנה 1" in pv, "fast mode: the ideas (the chosen one marked) and the outline in the preview")
    ctx.close()

    # Fast mode with an outline that needs fixing: the teacher's turn after all
    mock, ctx, page = start()
    mock.answers["plan"] = json.dumps({"title": "כותרת", "targetWords": plain["targetWords"][:1], "scenes": [{"what": "א", "feeling": "", "words": [], "length": 30}]}, ensure_ascii=False)
    page.check("#fastMode")
    page.click("#autoCreate")
    wait_stage(page, "approvePlan", "wait")
    check(len(mock.of("write")) == 0 and page.is_visible("#writeFromPlan"), "fast mode, outline with one target word: shown to the teacher instead")
    ctx.close()

    check(not errors, "no page errors (%s)" % errors[:3])
    browser.close()

print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
