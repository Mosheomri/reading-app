/* Paced reading on the child's reading screen: normal / moving highlight / vanishing words.
   Exposes window.Reading. */
(function () {
  'use strict';

  var H = window.Hebrew;
  var el = window.Util.el;

  var MIN_PACE = 20;
  var MAX_PACE = 120;
  var DEFAULT_PACE = 60;
  var PACES = [
    { wpm: 30, icon: '🐢', label: 'לאט' },
    { wpm: 60, icon: '🐇', label: 'בינוני' },
    { wpm: 90, icon: '🚀', label: 'מהר' }
  ];
  var STORE_PACE = 'readingApp.pace';

  // A word of AVERAGE_LETTERS letters (no nikud) takes the base time (60000 / pace ms);
  // each letter more or less adds or removes LETTER_WEIGHT of it, within MIN_FACTOR..MAX_FACTOR.
  var AVERAGE_LETTERS = 5;
  var LETTER_WEIGHT = 0.1;
  var MIN_FACTOR = 0.7;
  var MAX_FACTOR = 1.6;
  // Extra stop after the last word of a sentence / paragraph, in base times.
  var SENTENCE_PAUSE = 1;
  var PARAGRAPH_PAUSE = 2;
  var SENTENCE_END_RE = /[.!?…׃]/;

  var MODES = [
    { id: 'normal', label: '📖 רגיל' },
    { id: 'highlight', label: '👉 סימון מתקדם' },
    { id: 'vanish', label: '✨ מילים נעלמות' }
  ];

  function clampPace(v) {
    v = Math.round(Number(v));
    if (!isFinite(v)) return DEFAULT_PACE;
    return Math.max(MIN_PACE, Math.min(MAX_PACE, v));
  }

  // The story's words in reading order, split exactly as Render.story lays them out
  // (one <span class="word"> each): [{word, after: 'none' | 'sentence' | 'paragraph'}].
  function plan(story) {
    var out = [];
    String(story || '').split(/\n+/).forEach(function (para) {
      if (!para.trim()) return;
      var start = out.length;
      H.tokenize(para).forEach(function (seg) {
        if (seg.isWord) { out.push({ word: seg.text, after: 'none' }); return; }
        if (out.length > start && SENTENCE_END_RE.test(seg.text)) out[out.length - 1].after = 'sentence';
      });
      if (out.length > start) out[out.length - 1].after = 'paragraph';
    });
    return out;
  }

  // Time for reading the word itself, in ms.
  function wordTime(word, wpm) {
    var letters = H.bare(word).length;
    var factor = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, 1 + (letters - AVERAGE_LETTERS) * LETTER_WEIGHT));
    return Math.round(60000 / clampPace(wpm) * factor);
  }

  // Extra stop after a word that ends a sentence or a paragraph, in ms.
  function pauseTime(after, wpm) {
    var pause = after === 'paragraph' ? PARAGRAPH_PAUSE : after === 'sentence' ? SENTENCE_PAUSE : 0;
    return Math.round(60000 / clampPace(wpm) * pause);
  }

  // Time from a word starting until the next one starts: the word plus the stop after it.
  function wordDelay(word, wpm, after) {
    return wordTime(word, wpm) + pauseTime(after, wpm);
  }

  function loadPace() {
    try {
      var v = localStorage.getItem(STORE_PACE);
      return v == null ? DEFAULT_PACE : clampPace(v);
    } catch (e) { return DEFAULT_PACE; }
  }

  function savePace(v) {
    try { localStorage.setItem(STORE_PACE, String(v)); } catch (e) { /* private mode: not remembered */ }
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Paced reading over a story already rendered by Render.story inside opts.reader.
  // opts: {reader, story: lesson.story, onNext: fn}
  // Returns {top: modes + pace (above the story), bar: playback (below it, sticky), end: end-of-story box, destroy}.
  function controller(opts) {
    // One unit per word: the word with the punctuation touching it, so both are marked and vanish together.
    var words = Array.prototype.slice.call(opts.reader.querySelectorAll('.story .unit'));
    var steps = plan(opts.story);
    var n = Math.min(words.length, steps.length);
    var mode = 'normal';
    var pace = loadPace();
    var index = 0;      // the current word; n = past the end
    var playing = false;
    var timer = null;

    /* ----- Controls ----- */

    var modeBtns = MODES.map(function (m) {
      return el('button', { type: 'button', class: 'btn', 'data-mode': m.id, 'aria-pressed': 'false',
        onclick: function () { setMode(m.id); } }, m.label);
    });

    var paceBtns = PACES.map(function (p) {
      return el('button', { type: 'button', class: 'btn', 'data-pace': p.wpm, title: p.label, 'aria-label': p.label + ' (' + p.wpm + ')',
        'aria-pressed': 'false', onclick: function () { setPace(p.wpm); } }, p.icon);
    });
    var range = el('input', { type: 'range', min: MIN_PACE, max: MAX_PACE, step: 5, 'aria-label': 'קצב' });
    var paceLabel = el('span', { class: 'pace-label' });
    range.addEventListener('input', function () { setPace(range.value); });

    var paceBox = el('div', { class: 'pace-box', hidden: true },
      el('div', { class: 'pace-btns' }, paceBtns),
      el('div', { class: 'pace-range' }, range, paceLabel));

    var playBtn = el('button', { type: 'button', class: 'btn primary', 'data-act': 'play', onclick: function () { playing ? stop() : play(); } });
    var restartBtn = el('button', { type: 'button', class: 'btn', 'data-act': 'restart', onclick: restart }, '↻ מההתחלה');
    var backBtn = el('button', { type: 'button', class: 'btn', 'data-act': 'back', onclick: back }, '→ מילה אחורה');
    var bar = el('div', { class: 'read-bar', hidden: true }, playBtn, backBtn, restartBtn);

    var againBtn = el('button', { type: 'button', class: 'btn big', onclick: restart }, '↻ עוד פעם');
    var nextBtn = el('button', { type: 'button', class: 'btn primary big', onclick: function () { stop(); opts.onNext(); } }, 'הלאה ←');
    var end = el('div', { class: 'read-end', hidden: true, role: 'status' },
      el('p', { class: 'lead' }, 'סיימת לקרוא! 🎉'),
      el('div', { class: 'stage-actions' }, againBtn, nextBtn));

    var top = el('div', { class: 'read-ctrl' }, el('div', { class: 'read-modes' }, modeBtns), paceBox);

    /* ----- State ----- */

    function paint() {
      words.forEach(function (w, i) {
        w.classList.toggle('current', mode === 'highlight' && i === index);
        w.classList.toggle('gone', mode === 'vanish' && i < index);
      });
      modeBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
      playBtn.textContent = playing ? '⏸ עצור' : '▶ התחל';
      backBtn.disabled = index === 0;
    }

    function syncPace() {
      range.value = pace;
      paceLabel.textContent = pace + ' מילים בדקה';
      paceBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.pace === pace)); });
    }

    // Keep the current word on screen, between the sticky top bar and the playback bar.
    function follow() {
      var w = words[index];
      if (!w) return;
      var r = w.getBoundingClientRect();
      var topbar = document.querySelector('.topbar');
      var topLimit = (topbar ? topbar.getBoundingClientRect().bottom : 0) + 8;
      var barTop = bar.hidden ? window.innerHeight : Math.min(window.innerHeight, bar.getBoundingClientRect().top);
      if (r.top < topLimit || r.bottom > barTop - 8) {
        w.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    }

    // Highlight: the mark stays on a sentence's last word during the stop after it.
    // Vanish: that word disappears after its own time, then the stop runs on the gone word,
    // before the next word's time (afterTick: the previous word has just vanished).
    function schedule(afterTick) {
      clearTimeout(timer);
      var step = steps[index];
      var ms;
      if (mode === 'vanish') {
        ms = wordTime(step.word, pace) + (afterTick && index > 0 ? pauseTime(steps[index - 1].after, pace) : 0);
      } else {
        ms = wordDelay(step.word, pace, step.after);
      }
      timer = setTimeout(tick, ms);
    }

    function tick() {
      timer = null;
      index++;
      if (index >= n) { finish(); return; }
      paint();
      follow();
      schedule(true);
    }

    function play() {
      if (!n) return;
      if (index >= n) index = 0;
      end.hidden = true;
      playing = true;
      paint();
      follow();
      schedule();
    }

    function stop() {
      playing = false;
      clearTimeout(timer);
      timer = null;
      paint();
    }

    function finish() {
      index = n;
      stop();
      end.hidden = false;
    }

    function restart() {
      stop();
      index = 0;
      play();
    }

    function back() {
      index = Math.max(0, Math.min(index, n) - 1);
      end.hidden = true;
      paint();
      follow();
      if (playing) schedule();
    }

    function setMode(m) {
      stop();
      mode = m;
      index = 0;
      end.hidden = true;
      paceBox.hidden = bar.hidden = m === 'normal';
      paint();
    }

    function setPace(v) {
      pace = clampPace(v);
      savePace(pace);
      syncPace();
    }

    syncPace();
    paint();

    return {
      top: top,
      bar: bar,
      end: end,
      destroy: stop
    };
  }

  window.Reading = {
    MIN_PACE: MIN_PACE,
    MAX_PACE: MAX_PACE,
    DEFAULT_PACE: DEFAULT_PACE,
    PACES: PACES,
    clampPace: clampPace,
    plan: plan,
    wordTime: wordTime,
    pauseTime: pauseTime,
    wordDelay: wordDelay,
    controller: controller
  };
})();
