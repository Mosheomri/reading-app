"""Real Gemini timing (not part of run_all.py: it calls the API and uses quota).
For each of the two models (main and fallback, as in js/gemini.js) it writes a few lessons the way the automatic
flow does: the story, then the exercises on it, streamed, with the same prompts, schemas and thinking settings
as the app. It measures the time to the first data, to the first answer text and in total, and counts failures.

The key is read from the environment only (never saved, never printed):
  PowerShell:  $env:GEMINI_API_KEY = "..."; python tests/gemini_bench.py
  bash:        GEMINI_API_KEY=... python tests/gemini_bench.py
Options: --runs N (default 3), --topic "..." (default כלב בגינה). Results also go to tests/out/gemini_bench.json."""
import argparse, json, os, socket, statistics, sys, time, mimetypes
import urllib.request, urllib.error
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
SITE = "https://mosheomri.github.io/reading-app/"
API = "https://generativelanguage.googleapis.com/v1beta/models/"

ap = argparse.ArgumentParser()
ap.add_argument("--runs", type=int, default=3)
ap.add_argument("--topic", default="כלב בגינה")
args = ap.parse_args()

KEY = os.environ.get("GEMINI_API_KEY", "").strip()
if not KEY:
    sys.exit("GEMINI_API_KEY is not set. Set it in this shell only (see the top of this file); do not save it in the repo.")

def serve_file(route):
    url = route.request.url
    if not url.startswith(SITE):
        route.abort(); return
    full = os.path.normpath(os.path.join(ROOT, unquote(urlparse(url).path)[len("/reading-app/"):] or "index.html"))
    if not full.startswith(ROOT) or not os.path.isfile(full):
        route.fulfill(status=404, body="not found"); return
    ctype = "application/javascript" if full.endswith(".js") else (mimetypes.guess_type(full)[0] or "application/octet-stream")
    route.fulfill(status=200, body=open(full, "rb").read(), headers={"Content-Type": ctype + "; charset=utf-8"})

class Fail(Exception):
    pass

def stream(model, level, prompt, schema, first_timeout, idle_timeout):
    """One streamed call, as js/gemini.js sends it. Returns timings and the answer text; raises Fail."""
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema,
                             "thinkingConfig": {"thinkingLevel": level, "includeThoughts": True}},
    }
    req = urllib.request.Request(API + model + ":streamGenerateContent?alt=sse", data=json.dumps(body).encode("utf-8"),
                                 headers={"x-goog-api-key": KEY, "Content-Type": "application/json"}, method="POST")
    t0 = time.monotonic()
    r = {"first": None, "first_text": None, "max_gap": 0.0, "thoughts": 0, "text": "", "finish": ""}
    last = None
    try:
        # The socket timeout is per read: the first-data limit until data comes, then the limit between pieces.
        resp = urllib.request.urlopen(req, timeout=first_timeout)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try: detail = json.loads(detail)["error"]["status"] + " " + json.loads(detail)["error"]["message"]
        except Exception: pass
        if e.code in (400, 401, 403) and "api key" in detail.lower():
            sys.exit("The key in GEMINI_API_KEY was refused: " + detail[:120])
        raise Fail("HTTP %d %s" % (e.code, detail[:120]))
    except (socket.timeout, TimeoutError):
        raise Fail("no answer in %d s" % first_timeout)
    except urllib.error.URLError as e:
        raise Fail("network: %s" % e.reason)
    try:
        for raw in resp:
            now = time.monotonic() - t0
            if r["first"] is None:
                r["first"] = now
                try: resp.fp.raw._sock.settimeout(idle_timeout)
                except AttributeError: pass  # keeps the first-data limit: gaps are still measured (max_gap)
            else:
                r["max_gap"] = max(r["max_gap"], now - last)
            last = now
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"): continue
            data = json.loads(line[5:].strip())
            if "error" in data: raise Fail("stream error: %s" % data["error"].get("message", "")[:120])
            c = (data.get("candidates") or [{}])[0]
            for part in (c.get("content") or {}).get("parts") or []:
                if part.get("thought"): r["thoughts"] += 1
                elif part.get("text"):
                    if r["first_text"] is None: r["first_text"] = now
                    r["text"] += part["text"]
            r["finish"] = c.get("finishReason") or r["finish"]
    except (socket.timeout, TimeoutError):
        raise Fail("no data for %d s (after %.1f s)" % (idle_timeout if r["first"] is not None else first_timeout, time.monotonic() - t0))
    r["total"] = time.monotonic() - t0
    if r["finish"] and r["finish"] != "STOP": raise Fail("finish " + r["finish"])
    try: r["json"] = json.loads(r["text"])
    except ValueError: raise Fail("answer is not JSON (%d chars)" % len(r["text"]))
    return r

def fmt(x): return "-" if x is None else "%.1f" % x

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome")
    page = browser.new_page()
    page.route("**/*", serve_file)  # the app's own files only; the API calls are made here, in Python
    page.goto(SITE + "index.html")
    app = page.evaluate("""(topic) => ({
      models: [[Gemini.MODEL, Gemini.THINKING_LEVEL], [Gemini.FALLBACK_MODEL, Gemini.FALLBACK_THINKING_LEVEL]],
      first: Gemini.config.firstDataTimeout / 1000, idle: Gemini.config.idleTimeout / 1000,
      story: Gemini.STORY_SCHEMA, exercises: Gemini.EXERCISES_SCHEMA,
      settings: { topic, length: +document.getElementById('length').value, level: Levels.DEFAULT, wordsMode: 'number',
                  wordCount: +document.getElementById('wordCount').value, words: [] } })""", args.topic)
    settings = app["settings"]
    story_prompt = page.evaluate("(s) => buildStoryPrompt(s)", settings)
    print("Settings: %s; timeouts: %d s to the first data, %d s between pieces; %d runs per model\n"
          % (json.dumps(settings, ensure_ascii=False), app["first"], app["idle"], args.runs))

    results = []
    # Alternate the models, so a slow minute on Google's side does not land on one of them only.
    for run in range(1, args.runs + 1):
        for model, level in app["models"]:
            res = {"model": model, "run": run, "calls": {}}
            t0 = time.monotonic()
            try:
                for call in ("story", "exercises"):
                    if call == "story":
                        prompt, schema = story_prompt, app["story"]
                    else:
                        prompt, schema = page.evaluate("([s, st]) => buildExercisesPrompt(s, st)", [settings, res["calls"]["story"]["json"]]), app["exercises"]
                    try:
                        r = stream(model, level, prompt, schema, app["first"], app["idle"])
                    except Fail as e:
                        res["calls"][call] = {"error": str(e)}
                        raise Fail(call + ": " + str(e))
                    res["calls"][call] = r
                    print("  %-22s run %d %-9s first data %5s s, first text %5s s, total %5s s, longest gap %4s s, %d thoughts, %d chars"
                          % (model, run, call, fmt(r["first"]), fmt(r["first_text"]), fmt(r["total"]), fmt(r["max_gap"]), r["thoughts"], len(r["text"])))
                res["ok"] = True
                res["exercises"] = len(res["calls"]["exercises"]["json"].get("exercises", []))
            except Fail as e:
                res["ok"] = False
                res["error"] = str(e)
                print("  %-22s run %d FAILED: %s" % (model, run, e))
            res["total"] = time.monotonic() - t0
            results.append(res)
    browser.close()

print("\nSummary (a lesson = story + exercises; no automatic retries here, so every failure counts)")
print("%-22s %8s %22s %22s %18s %18s" % ("model", "failed", "story: first data / total", "exercises: first / total", "lesson total (avg)", "lesson total (max)"))
summary = {}
for model, _ in app["models"]:
    rs = [r for r in results if r["model"] == model]
    ok = [r for r in rs if r["ok"]]
    def avg(call, k):
        v = [r["calls"][call][k] for r in ok if r["calls"][call].get(k) is not None]
        return statistics.mean(v) if v else None
    tot = [r["total"] for r in ok]
    summary[model] = {"runs": len(rs), "failed": len(rs) - len(ok), "story_first": avg("story", "first"), "story_total": avg("story", "total"),
                      "exercises_first": avg("exercises", "first"), "exercises_total": avg("exercises", "total"),
                      "lesson_avg": statistics.mean(tot) if tot else None, "lesson_max": max(tot) if tot else None,
                      "errors": [r["error"] for r in rs if not r["ok"]]}
    s = summary[model]
    print("%-22s %8s %22s %22s %18s %18s" % (model, "%d / %d" % (s["failed"], s["runs"]),
          fmt(s["story_first"]) + " / " + fmt(s["story_total"]) + " s", fmt(s["exercises_first"]) + " / " + fmt(s["exercises_total"]) + " s",
          fmt(s["lesson_avg"]) + " s", fmt(s["lesson_max"]) + " s"))
    for e in s["errors"]: print("    error: " + e)

os.makedirs(OUT, exist_ok=True)
for r in results:
    for c in r["calls"].values(): c.pop("json", None); c.pop("text", None)
json.dump({"settings": settings, "summary": summary, "results": results}, open(os.path.join(OUT, "gemini_bench.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
print("\nDetails: tests/out/gemini_bench.json")
