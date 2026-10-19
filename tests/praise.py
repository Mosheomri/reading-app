"""Encouragement on the child's page (js/praise.js): a random praise / "try again" sentence, heard as a
recording, else the browser's Hebrew voice, else text only; moving on by itself after a right answer;
"הבא" cancels it; the mute button on every screen, remembered."""
import json, sys, threading, functools, http.server, os, io, wave, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)
PORT = 8787
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}/"
sample = json.load(open(os.path.join(ROOT, "samples", "sample-lesson.json"), encoding="utf-8"))
EXS = sample["exercises"]

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

errors = []

def wav(seconds=0.6):
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b"\x00\x00" * int(8000 * seconds))
    w.close()
    return buf.getvalue()
WAV = wav()

# A fake Hebrew voice: records what is said and "ends" after 400 ms.
VOICE_JS = """(() => {
  window.__spoken = [];
  const voice = { lang: 'he-IL', name: 'Mock Hebrew', voiceURI: 'mock', localService: true, default: false };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const synth = window.speechSynthesis;
  synth.getVoices = () => [voice];
  synth.speak = (u) => { __spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 400); };
  synth.cancel = () => {};
})();"""
# Every recording that starts playing.
PLAY_JS = """(() => { window.__played = []; window.__ended = []; const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { __played.push(this.getAttribute('src') || this.src);
    this.addEventListener('ended', () => __ended.push(performance.now())); return play.call(this); }; })();"""

def shown(page, s): return page.evaluate("(o) => Render.text(Lesson.decode(location.hash), o)", s)

def answer(page, ex, right=True):
    if ex["type"] in ("mcq", "fill"):
        correct = shown(page, ex["options"][ex["answer"]])
        labels = page.eval_on_selector_all(".option", "els => els.map(e => e.textContent)")
        page.locator(".option").filter(has_text=correct if right else [b for b in labels if b != correct][0]).first.click()
    elif ex["type"] == "tf":
        page.click(".option >> text=" + ("👍 נכון" if ex["answer"] == right else "👎 לא נכון"))
    elif ex["type"] == "order":
        for s in ex["sentences"]:
            page.locator(".order-list:not(.answer) .order-item").filter(has_text=shown(page, s)).first.click()

def qno(page):
    m = re.search(r"שאלה (\d+) מתוך", page.text_content("#stage") or "")
    return int(m.group(1)) if m else 0

def open_child(browser, voice=False, recordings=False, ctx=None):
    ctx = ctx or browser.new_context(viewport={"width": 390, "height": 800})
    ctx.add_init_script(PLAY_JS)
    if voice: ctx.add_init_script(VOICE_JS)
    audio_requests = []
    def audio(route):
        audio_requests.append(route.request.url.split("/assets/audio/")[1])
        if recordings: route.fulfill(status=200, body=WAV, headers={"Content-Type": "audio/wav"})
        else: route.fulfill(status=404, body="not found")
    ctx.route("**/assets/audio/*", audio)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "play.html")
    h = page.evaluate("(l) => Lesson.encode(Lesson.coerce(l).lesson)", sample)
    page.goto(BASE + "play.html#" + h)
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    return ctx, page, audio_requests

def to_question(page, k):
    page.click("text=מתחילים ▶")
    for _ in range(30):
        if qno(page) == k: return
        page.click("#navNext")

def time_to_next(page, start_q, timeout=5000):
    """Milliseconds until the page moves on from question start_q by itself (None if it does not)."""
    return page.evaluate("""([q, timeout]) => new Promise(res => {
      const t0 = performance.now();
      const tick = () => {
        const m = /שאלה (\\d+) מתוך/.exec(document.querySelector('#stage').textContent);
        const now = m ? +m[1] : -1;
        if (now !== q) { window.__movedAt = performance.now(); return res(performance.now() - t0); }
        if (performance.now() - t0 > timeout) return res(null);
        setTimeout(tick, 25);
      };
      tick();
    })""", [start_q, timeout])

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", args=["--autoplay-policy=no-user-gesture-required"])

    # ---------- The sentences ----------
    ctx, page, _ = open_child(browser)
    lists = page.evaluate("[Praise.PRAISE, Praise.TRY]")
    check(len(lists[0]) >= 5 and all(re.fullmatch(r"assets/audio/praise-\d\d\.mp3", x["audio"]) and x["text"] for x in lists[0]),
          "praise sentences: text + assets/audio/praise-NN.mp3 (%d)" % len(lists[0]))
    check(len(lists[1]) >= 3 and all(re.fullmatch(r"assets/audio/try-\d\d\.mp3", x["audio"]) and "נסו" in x["text"] for x in lists[1]),
          "try-again sentences: text + assets/audio/try-NN.mp3, all say 'נסו' (%d)" % len(lists[1]))
    seq = page.evaluate("Array.from({length: 300}, () => Praise.next('praise').text)")
    check(all(a != b for a, b in zip(seq, seq[1:])) and len(set(seq)) == len(lists[0]), "random, never the same sentence twice in a row, all of them used")
    check(page.evaluate("Praise.spoken({text: 'כל הכבוד! 🌟'})") == "כל הכבוד!", "spoken text leaves the emoji out")

    # ---------- Mute button on every screen ----------
    mutes = []
    mutes.append(page.is_visible("#muteBtn"))
    page.click("text=מתחילים ▶")
    for _ in range(14):
        mutes.append(page.is_visible("#muteBtn") and page.text_content("#muteBtn") == "🔊")
        if page.locator(".stars").count(): break
        page.click("#navNext")
    check(all(mutes) and page.locator(".stars").count() == 1, "🔊 button on every screen: start, games, reading, questions, finish (%d screens)" % len(mutes))
    btn = page.evaluate("(() => { const r = document.querySelector('#muteBtn').getBoundingClientRect(); return [r.width, r.height, r.right <= innerWidth]; })()")
    check(btn[0] >= 44 and btn[1] >= 44 and btn[2], "mute button is thumb-size on a phone (%dx%d)" % (btn[0], btn[1]))
    ctx.close()

    # ---------- No recording, no voice: text only, moves on after 2 s ----------
    ctx, page, reqs = open_child(browser)
    to_question(page, 1)
    answer(page, EXS[0])
    fb = page.text_content(".feedback")
    check(any(fb == x["text"] for x in lists[0]), "right answer: a praise sentence is shown (%s)" % fb)
    ms = time_to_next(page, 1)
    check(ms is not None and 1700 < ms < 2600 and qno(page) == 2, "no sound: the next question comes by itself after ~2 s (%s ms)" % (int(ms) if ms else ms))
    answer(page, EXS[1])
    page.click("#navNext")
    check(qno(page) == 3, "'הבא' before the automatic move: next question at once")
    page.wait_for_timeout(2600)
    check(qno(page) == 3, "…and the automatic move was cancelled (still question 3 after 2.6 s)")
    answer(page, EXS[2], right=False)
    fb = page.text_content(".feedback")
    check(any(fb.startswith(x["text"]) for x in lists[1]) and "אפשר להציץ בסיפור" in fb, "wrong answer: a gentle try-again sentence (%s)" % fb)
    page.wait_for_timeout(2600)
    check(qno(page) == 3, "wrong answer: no automatic move")
    answer(page, EXS[2])
    page.wait_for_timeout(2400)
    # Last question → finish
    for _ in range(10):
        if qno(page) == len(EXS): break
        page.click("#navNext")
    answer(page, EXS[-1])
    page.wait_for_timeout(2500)
    check(page.locator(".stars").count() == 1, "the last question moves on to the finish screen by itself")
    check(len(reqs) == len(set(reqs)), "a missing recording is asked for once per visit (%d requests: %s)" % (len(reqs), sorted(set(reqs))[:4]))
    ctx.close()

    # ---------- Voice, no recording: the sentence is spoken, move on after it ----------
    ctx, page, reqs = open_child(browser, voice=True)
    to_question(page, 1)
    answer(page, EXS[0])
    ms = time_to_next(page, 1)
    spoken = page.evaluate("__spoken")
    praise_say = [x["text"].split(" ")[0] for x in lists[0]]
    check(spoken and any(spoken[-1].startswith(w) for w in praise_say) and not re.search(r"[\U0001F300-\U0001FAFF⭐✨]", spoken[-1]),
          "no recording, Hebrew voice: the praise is spoken, without emoji (%s)" % spoken[-1:])
    check(ms is not None and 500 < ms < 1500, "moves on right after the voice ends (%d ms)" % (ms or 0))
    check(any(r.startswith("praise-") for r in reqs), "the recording was looked for first (%s)" % reqs[:2])
    answer(page, EXS[1], right=False)
    page.wait_for_timeout(100)
    check(any("נסו" in s for s in page.evaluate("__spoken")[-1:]), "wrong answer: the try-again sentence is spoken (%s)" % page.evaluate("__spoken")[-1:])
    ctx.close()

    # ---------- With recordings: the file is played, the voice is not used ----------
    ctx, page, reqs = open_child(browser, voice=True, recordings=True)
    to_question(page, 1)
    page.evaluate("window.__spoken = []; window.__played = []")
    answer(page, EXS[0])
    ms = time_to_next(page, 1)
    played = page.evaluate("__played")
    check(played and re.search(r"assets/audio/praise-\d\d\.mp3$", played[-1]) and page.evaluate("__spoken") == [],
          "recording there: it is played, not the voice (%s)" % played[-1:])
    gap = page.evaluate("__ended.length ? __movedAt - __ended[__ended.length - 1] : null")
    check(ms is not None and gap is not None and 150 < gap < 900, "moves on right after the recording ends (%d ms after 'ended')" % (gap or -1))
    answer(page, EXS[1], right=False)
    page.wait_for_timeout(200)
    check(re.search(r"assets/audio/try-\d\d\.mp3$", page.evaluate("__played")[-1] or ""), "wrong answer: a try-again recording is played")
    ctx.close()

    # ---------- Mute: nothing heard, still moves on after 2 s; remembered ----------
    ctx, page, reqs = open_child(browser, voice=True, recordings=True)
    page.click("#muteBtn")
    check(page.text_content("#muteBtn") == "🔇" and page.get_attribute("#muteBtn", "aria-pressed") == "true"
          and page.evaluate("localStorage.getItem('readingApp.muted')") == "1", "mute: 🔇, saved in localStorage")
    to_question(page, 1)
    page.evaluate("window.__spoken = []; window.__played = []")
    answer(page, EXS[0])
    ms = time_to_next(page, 1)
    check(page.evaluate("__played") == [] and page.evaluate("__spoken") == [] and ms and 1700 < ms < 2600,
          "muted: no recording, no voice, the next question after ~2 s (%d ms)" % (ms or 0))
    page.reload()
    page.wait_for_selector("text=מתחילים ▶")
    check(page.text_content("#muteBtn") == "🔇", "mute remembered after reload")
    page.click("#muteBtn")
    check(page.text_content("#muteBtn") == "🔊" and page.evaluate("localStorage.getItem('readingApp.muted')") is None, "sound back on")
    page.screenshot(path=os.path.join(OUT, "praise-mute.png"))
    ctx.close()

    check(not errors, "no page errors: %s" % errors)
    browser.close()

httpd.shutdown()
print("\n%d failures" % len(fails))
sys.exit(1 if fails else 0)
