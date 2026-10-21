"""Sums up the second-opinion reports ("פירוט כל ההבדלים" in the preview: one JSON file per lesson) by kind of
difference: how many, how many of them are marked (read differently), and examples.
Usage: python tests/nikud_diff_report.py nikud-compare-*.json"""
import json, sys
from collections import OrderedDict

sys.stdout.reconfigure(encoding="utf-8")
files = sys.argv[1:]
if not files:
    sys.exit(__doc__)

kinds = OrderedDict()
words = compared = diffs = marked = 0
for path in files:
    data = json.load(open(path, encoding="utf-8"))
    n_marked = sum(1 for d in data["diffs"] if d["marked"])
    print("%s: %d words, %d compared, %d differ, %d marked (%.1f%% of the words)"
          % (data.get("title") or path, data["words"], data["compared"], len(data["diffs"]), n_marked,
             100.0 * n_marked / max(1, data["words"])))
    words += data["words"]; compared += data["compared"]; diffs += len(data["diffs"]); marked += n_marked
    for d in data["diffs"]:
        for k in d["kinds"]:
            o = kinds.setdefault(k, {"count": 0, "marked": 0, "examples": []})
            o["count"] += 1
            o["marked"] += 1 if d["marked"] else 0
            if len(o["examples"]) < 4: o["examples"].append("%s / %s" % (d["dicta"], d["gemini"]))

print("\nAll: %d words, %d compared, %d differ, %d marked (%.1f%% of the words)\n" % (words, compared, diffs, marked, 100.0 * marked / max(1, words)))
print("%-18s %6s %7s  %s" % ("kind", "count", "marked", "examples (Dicta / Gemini)"))
for k, o in sorted(kinds.items(), key=lambda x: -x[1]["count"]):
    print("%-18s %6d %7d  %s" % (k, o["count"], o["marked"], "   ".join(o["examples"])))
