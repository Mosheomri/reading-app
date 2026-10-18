import json, sys
import os, pathlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = pathlib.Path(ROOT, "index.html").as_uri()
SAMPLE = os.path.join(ROOT, "samples", "sample-lesson.json")
from playwright.sync_api import sync_playwright
bad = 0
def ck(c, m):
    global bad; bad += not c; print(("PASS " if c else "FAIL ") + m)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome"); pg = b.new_page()
    pg.goto(INDEX)
    s = json.load(open(SAMPLE, encoding="utf-8"))
    L = pg.evaluate("(l) => Lesson.coerce(l).lesson", s)
    pr = pg.evaluate("(l) => Review.buildReviewPrompt(l)", L)
    ck("שישי ולא ששי, בוקר ולא בקר" in pr and 'reason "כתיב חסר"' in pr, "prompt has ktiv male check")
    ck("נשלחים בלי ניקוד" in pr and "המתוקן, בלי ניקוד" in pr, "prompt: texts and fix without nikud")
    texts = pr[pr.index("הטקסטים לבדיקה:"):]
    ck(not pg.evaluate("(t) => Hebrew.hasNikud(t)", texts), "review texts have no nikud")
    ck(pg.evaluate("(l) => Hebrew.stripNikud(l.title)", L) in texts, "title sent stripped")
    # Defective spelling detection
    hw = lambda story: pg.evaluate("([l, s]) => { const c = JSON.parse(JSON.stringify(l)); c.title = ''; c.targetWords = []; c.exercises = []; c.story = s; return Review.haserWords(c); }", [L, story])
    flagged = ["בֹּקֶר", "שֻׁלְחָן", "חֹם", "אֹכֶל", "הַכֹּל", "וְהַבֹּקֶר"]
    ok = ["בּוֹקֶר", "שׁוּלְחָן", "יוֹם", "וְלֹא", "בְּרֹאשׁ", "הַזֹּאת", "צֹאן", "לִשְׂמֹאל", "מֹשֶׁה", "פֹּה", "כֹּה", "אֵיפֹה", "וּמֹשֶׁה", "הַכּוֹל"]
    for w in flagged: ck(hw(w) == [w], "flagged haser: " + w)
    for w in ok: ck(hw(w) == [], "not flagged: " + w)
    ck(hw("בֹּקֶר טוֹב, בֹּקֶר!") == ["בֹּקֶר"], "duplicates listed once")
    def find(text, needle):
        r = pg.evaluate("([t, n]) => { const r = Review.findLoose(t, n); return r && Hebrew.normalize(t).slice(r.start, r.end); }", [text, needle])
        return r
    ck(find("בְּכָל בֹּקֶר דָּנִי", "בקר") == "בֹּקֶר", "plain original matches vocalized word")
    ck(find("הַמְבַקְּרִים בָּאוּ. בַּבֹּקֶר", "בקר") == "בֹּקֶר", "skips match inside another word; allows prefix")
    ck(find("הַמְבַקְּרִים בָּאוּ", "בקר") is None, "no whole-word match → not found")
    ck(find("סַפָּר וְסֵפֶר", "סֵפֶר") == "סֵפֶר", "prefers occurrence with matching nikud")
    ck(find("כֶּלֶב קָטָן מְאוֹד", "כלב קטן") == "כֶּלֶב קָטָן", "multi-word plain original")
    # apply: ktiv haser word → male
    item = {"field": "story", "type": "error", "original": "בקר", "fix": "בוקר", "reason": "כתיב חסר"}
    st = pg.evaluate("([l, it]) => { Review.applySuggestion(l, it); return l.story; }", [L, item])
    ck("בְּכָל בוקר דָּנִי" in st, "applied: " + st.split("\n")[1][:30])
    item2 = {"field": "story", "type": "error", "original": "אָדֹם", "fix": "אָדוֹם", "reason": "כתיב חסר"}
    st = pg.evaluate("([l, it]) => { Review.applySuggestion(l, it); return l.story; }", [L, item2])
    ck("כַּדּוּר אָדוֹם." in st, "vocalized fix applied")
    b.close()
print(f"\n{bad} failures"); sys.exit(1 if bad else 0)
