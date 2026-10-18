import json, sys
import os, pathlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = pathlib.Path(ROOT, "index.html").as_uri()
SAMPLE = os.path.join(ROOT, "samples", "sample-lesson.json")
from playwright.sync_api import sync_playwright
M = chr(0x05BD)  # meteg
cases = [
  # token, target, expected, note
  ("כֶּלֶב", "כֶּלֶב", True, "identical"),
  ("הַכֶּלֶב", "כֶּלֶב", True, "article"),
  ("וְהַכֶּלֶב", "כֶּלֶב", True, "וה prefix"),
  ("בַּגִּנָּה", "גִּנָּה", True, "בַּ prefix (patach of absorbed article)"),
  ("וּבוֹנִי", "בּוֹנִי", True, "dagesh kal dropped after ו"),
  ("הַגִּנָּה", "גִנָּה", True, "dagesh forte after article, target without dagesh"),
  ("וִילָדִים", "יְלָדִים", True, "sheva dropped on first letter after prefix"),
  ("כֶּלֶב", "כָּלֶב", False, "different vowel (homograph check)"),
  ("סֵפֶר", "סַפָּר", False, "homograph: book vs barber"),
  ("סְפָרִים", "סֵפֶר", False, "different word"),
  ("כֶּלֶב" , "כלב", True, "target unvocalized → letters only"),
  ("כלב", "כֶּלֶב", True, "token unvocalized → letters only"),
  ("בַּגִּנָּה", "הַגִּנָּה", True, "target with article"),
  ("גִּנָּה", "הַגִּנָּה", True, "target with article, bare token"),
  ("עֵ" + M + "ץ", "עֵץ", True, "meteg ignored"),
  ("שָׂם", "שָׁם", False, "sin vs shin dot"),
  ("כְּלָבִים", "כֶּלֶב", False, "plural no match"),
  ("כָּלֶב", "כֶּלֶב", False, "first-letter vowel differs (no prefix)"),
]
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome"); pg = b.new_page()
    pg.goto(INDEX)
    bad = 0
    for tok, tgt, exp, note in cases:
        got = pg.evaluate("([a, b]) => Hebrew.matchesWord(a, b)", [tok, tgt])
        ok = got == exp; bad += not ok
        print(("PASS " if ok else "FAIL ") + f"{note}: {tok} ~ {tgt} → {got}")
    # check() messages
    s = json.load(open(SAMPLE, encoding="utf-8"))
    r = pg.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null)", s)
    ok = not r["errors"]; bad += not ok
    print(("PASS " if ok else "FAIL ") + "sample lesson: no errors " + str(r["errors"]))
    s["targetWords"][0]["word"] = "כָּלֶב"
    r = pg.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null)", s)
    msg = [e for e in r["errors"] if "כָּלֶב" in e]
    ok = msg and "רק בניקוד אחר" in msg[0]; bad += not ok
    print(("PASS " if ok else "FAIL ") + "different-nikud message: " + (msg[0] if msg else str(r["errors"])))
    s["targetWords"][0]["word"] = "חָתוּל"
    r = pg.evaluate("(l) => Lesson.check(Lesson.coerce(l).lesson, null)", s)
    ok = any(e == 'מילת היעד "חָתוּל" לא מופיעה בסיפור.' for e in r["errors"]); bad += not ok
    print(("PASS " if ok else "FAIL ") + "truly missing word message")
    # partial display: only matching vocalization is kept
    out = pg.evaluate("() => Hebrew.displayText('כֶּלֶב וְכָלֶב', 'partial', ['כֶּלֶב'])")
    ok = out == "כֶּלֶב וכלב"; bad += not ok
    print(("PASS " if ok else "FAIL ") + "partial mode follows the same rule: " + out)
    b.close()
print(f"\n{bad} failures"); sys.exit(1 if bad else 0)
