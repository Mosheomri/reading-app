/* Child flow: start → games → reading → exercises → finish. Nothing is saved or sent. */
(function () {
  'use strict';

  var U = window.Util;
  var R = window.Render;
  var L = window.Lesson;
  var el = U.el;

  var GAME_ORDER = ['memory', 'build', 'listen'];
  var PRAISE = ['כל הכבוד! 🌟', 'יופי! 👏', 'מצוין! ⭐', 'נהדר! 🎉', 'איזה יופי! 💫'];

  var stage = document.getElementById('stage');
  var progressFill = document.getElementById('progressFill');

  var lesson = null;
  var ctx = null;
  var games = [];
  var storySize = 30;
  var progress = { done: 0, total: 1 };
  var score = { firstTry: 0 };
  var cleanup = null; // stops whatever the current screen runs (paced reading timer)

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function setProgress(done) {
    progress.done = done;
    var pct = Math.round(100 * Math.min(1, done / progress.total));
    progressFill.style.width = pct + '%';
    progressFill.parentNode.setAttribute('aria-valuenow', pct);
  }

  function screen() {
    if (cleanup) { cleanup(); cleanup = null; }
    U.clear(stage);
    window.scrollTo(0, 0);
    return stage;
  }

  // Feedback line used by games and exercises.
  function feedbackLine() {
    var fb = el('div', { class: 'feedback', role: 'status' });
    return {
      node: fb,
      praise: function (text) { fb.className = 'feedback good'; fb.textContent = text || pick(PRAISE); },
      hint: function (text) { fb.className = 'feedback'; fb.textContent = text; },
      clear: function () { fb.className = 'feedback'; fb.textContent = ''; }
    };
  }

  function storyOverlay() {
    var sheet = el('div', { class: 'sheet' },
      el('div', { class: 'row end', style: 'margin-bottom:8px' },
        el('button', { type: 'button', class: 'btn small', onclick: close }, 'סגירה ✕')),
      el('div', { class: 'reader' },
        el('div', { class: 'story', style: '--story-size:' + storySize + 'px' }, R.story(lesson, ctx.hasVoice ? ctx.speak : null))));
    var overlay = el('div', { class: 'overlay', role: 'dialog', 'aria-label': 'הסיפור' }, sheet);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    function close() { overlay.remove(); }
  }

  /* ---------- Screens ---------- */

  function showError() {
    progressFill.parentNode.hidden = true;
    var s = screen();
    s.appendChild(el('div', { class: 'center-msg' },
      el('div', { class: 'celebrate' }, '🔗'),
      el('h1', null, 'הקישור לא שלם'),
      el('p', { class: 'lead' }, 'ייתכן שחלק מהקישור נחתך. בקשו מהמורה לשלוח אותו שוב.')));
  }

  function showStart() {
    setProgress(0);
    var s = screen();
    s.appendChild(el('div', { class: 'celebrate', 'aria-hidden': 'true' }, '📖'));
    s.appendChild(el('h1', null, R.text(lesson, lesson.title) || 'שיעור קריאה'));
    s.appendChild(el('div', { class: 'big-emoji', style: 'font-size:2.6rem;letter-spacing:6px', 'aria-hidden': 'true' },
      lesson.targetWords.map(function (t) { return t.emoji; }).join(' ')));
    s.appendChild(el('p', { class: 'lead' }, 'נשחק, נקרא סיפור ונענה על שאלות'));
    s.appendChild(el('div', { class: 'stage-actions' },
      el('button', { type: 'button', class: 'btn primary big', onclick: function () {
        if (ctx.hasVoice) ctx.speak(' '); // unlock speech on iOS (needs a user gesture)
        score.firstTry = 0;
        runGame(0);
      } }, 'מתחילים ▶')));
  }

  function runGame(i) {
    if (i >= games.length) { showReading(); return; }
    setProgress(i);
    var game = games[i];
    var s = screen();
    var fb = feedbackLine();
    var area = el('div');
    var nextBtn = el('button', { type: 'button', class: 'btn', onclick: function () { runGame(i + 1); } }, 'הלאה ←');
    var againBtn = el('button', { type: 'button', class: 'btn', hidden: true, onclick: function () { runGame(i); } }, '↻ שוב');

    s.appendChild(el('h1', null, game.name));
    s.appendChild(el('p', { class: 'lead' }, game.instruction));
    s.appendChild(area);
    s.appendChild(fb.node);
    s.appendChild(el('div', { class: 'stage-actions' }, againBtn, nextBtn));

    var gctx = Object.assign({}, ctx, { praise: fb.praise, hint: fb.hint });
    game.play(area, gctx, function () {
      setProgress(i + 1);
      fb.praise('סיימתם את המשחק! 🎉');
      againBtn.hidden = false;
      nextBtn.classList.add('primary', 'big', 'pop');
      nextBtn.focus();
    });
  }

  function showReading() {
    var base = games.length;
    setProgress(base);
    var s = screen();
    s.appendChild(el('h1', null, R.text(lesson, lesson.title) || 'הסיפור'));

    var reader = el('div', { class: 'reader', style: '--story-size:' + storySize + 'px' });
    function resize(delta) {
      storySize = Math.max(20, Math.min(60, storySize + delta));
      reader.style.setProperty('--story-size', storySize + 'px');
    }
    s.appendChild(el('div', { class: 'size-ctrl' },
      el('button', { type: 'button', class: 'btn small', 'aria-label': 'הקטנת טקסט', onclick: function () { resize(-4); } }, 'א−'),
      el('button', { type: 'button', class: 'btn small', 'aria-label': 'הגדלת טקסט', onclick: function () { resize(4); } }, 'א+')));
    if (ctx.hasVoice) s.appendChild(el('p', { class: 'muted small' }, 'לחצו על מילה כדי לשמוע אותה 🔊'));

    reader.appendChild(el('div', { class: 'story' }, R.story(lesson, ctx.hasVoice ? ctx.speak : null)));
    var paced = window.Reading.controller({ reader: reader, story: lesson.story, onNext: function () { runExercise(0); } });
    cleanup = paced.destroy;
    s.appendChild(paced.top);
    s.appendChild(reader);
    s.appendChild(paced.bar);
    s.appendChild(paced.end);
    s.appendChild(el('div', { class: 'stage-actions' },
      el('button', { type: 'button', class: 'btn primary big', onclick: function () { runExercise(0); } }, 'סיימתי לקרוא ←')));
  }

  function runExercise(i) {
    var exercises = lesson.exercises;
    var base = games.length + 1;
    if (i >= exercises.length) { showFinish(); return; }
    setProgress(base + i);
    var s = screen();
    var fb = feedbackLine();
    var area = el('div');
    var nextBtn = el('button', { type: 'button', class: 'btn primary big', hidden: true,
      onclick: function () { runExercise(i + 1); } }, 'הלאה ←');

    s.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' },
      el('span', { class: 'muted small' }, 'שאלה ' + (i + 1) + ' מתוך ' + exercises.length),
      el('button', { type: 'button', class: 'btn small quiet', onclick: storyOverlay }, '📖 לסיפור')));
    s.appendChild(area);
    s.appendChild(fb.node);
    s.appendChild(el('div', { class: 'stage-actions' }, nextBtn));

    var ectx = Object.assign({}, ctx, { praise: fb.praise, hint: fb.hint });
    window.Exercises.render(area, exercises[i], lesson, ectx, function (firstTry) {
      if (firstTry) score.firstTry++;
      setProgress(base + i + 1);
      fb.praise();
      nextBtn.hidden = false;
      nextBtn.focus();
    });
  }

  function showFinish() {
    setProgress(progress.total);
    var n = lesson.exercises.length;
    var ratio = n ? score.firstTry / n : 1;
    var stars = ratio >= 0.8 ? 3 : ratio >= 0.5 ? 2 : 1;
    var s = screen();
    s.appendChild(el('div', { class: 'celebrate pop', 'aria-hidden': 'true' }, '🏆'));
    s.appendChild(el('h1', null, 'כל הכבוד!'));
    s.appendChild(el('div', { class: 'stars', 'aria-label': stars + ' כוכבים' }, '⭐'.repeat(stars)));
    var parts = [];
    if (games.length) parts.push('שיחקת ' + (games.length === 1 ? 'משחק אחד' : games.length + ' משחקים'));
    parts.push('קראת סיפור');
    if (n) parts.push('ענית על ' + (n === 1 ? 'שאלה אחת' : n + ' שאלות'));
    s.appendChild(el('p', { class: 'lead' }, parts.join(', ') + '.'));
    s.appendChild(el('div', { class: 'stage-actions' },
      el('button', { type: 'button', class: 'btn primary big', onclick: showStart }, '↻ מתחילים מחדש')));
  }

  /* ---------- Init ---------- */

  function start() {
    lesson = L.decode(location.hash);
    if (!lesson || !lesson.targetWords.length || !lesson.story) { showError(); return; }
    lesson.exercises = lesson.exercises.filter(function (ex) { return !ex.unknown; });
    lesson.targetWords = lesson.targetWords.filter(function (t) { return t.word; });
    progressFill.parentNode.hidden = false;
    document.title = (R.text(lesson, lesson.title) || 'שיעור קריאה');

    U.speechReady().then(function (hasVoice) {
      ctx = {
        lesson: lesson,
        targets: lesson.targetWords,
        hasVoice: hasVoice,
        show: function (word) { return R.text(lesson, word); },
        speak: hasVoice ? U.speak : function () {}
      };
      games = GAME_ORDER.map(function (k) { return window.Games[k]; })
        .filter(function (g) { return g && g.available(ctx); });
      progress.total = games.length + 1 + lesson.exercises.length;
      showStart();
    });
  }

  window.addEventListener('hashchange', start);
  start();
})();
