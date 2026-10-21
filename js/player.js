/* Child flow: start → games → reading → exercises → finish. Nothing is saved or sent.
   After the start screen, a bottom bar (הקודם / הבא) moves freely between all screens. */
(function () {
  'use strict';

  var U = window.Util;
  var R = window.Render;
  var L = window.Lesson;
  var P = window.Praise;
  var el = U.el;

  var GAME_ORDER = ['memory', 'build', 'listen'];

  var stage = document.getElementById('stage');
  var progressFill = document.getElementById('progressFill');
  var navBar = document.getElementById('nav');
  var navPrev = document.getElementById('navPrev');
  var navNext = document.getElementById('navNext');
  var muteBtn = document.getElementById('muteBtn');

  var lesson = null;
  var ctx = null;
  var games = [];
  var storySize = 30;
  var progress = { done: 0, total: 1 };
  // Per exercise: {solved, firstTry, missed}. A skipped exercise has no entry, so it counts as not right.
  var results = [];
  var at = -1;        // current screen: 0..games.length-1 games, then reading, exercises, finish (-1: start / error)
  var screenId = 0;   // bumped on every screen, so callbacks from a screen already left are ignored
  var cleanup = null; // stops whatever the current screen runs (paced reading timer)

  function setProgress(done) {
    progress.done = done;
    var pct = Math.round(100 * Math.min(1, done / progress.total));
    progressFill.style.width = pct + '%';
    progressFill.parentNode.setAttribute('aria-valuenow', pct);
  }

  function screen() {
    if (cleanup) { cleanup(); cleanup = null; }
    P.stop(); // a sound from the screen left (and its automatic move on) ends here
    screenId++;
    U.clear(stage);
    window.scrollTo(0, 0);
    return stage;
  }

  /* ---------- Navigation ---------- */

  // Screen positions: games, reading, each exercise, finish. The finish position equals progress.total.
  function readingAt() { return games.length; }
  function finishAt() { return games.length + 1 + lesson.exercises.length; }

  function go(k) {
    at = Math.max(0, Math.min(finishAt(), k));
    showNav(true);
    navPrev.disabled = at === 0;
    navNext.disabled = at === finishAt();
    navNext.classList.remove('pop');
    if (at < readingAt()) runGame(at);
    else if (at === readingAt()) showReading();
    else if (at < finishAt()) runExercise(at - readingAt() - 1);
    else showFinish();
  }

  function showNav(on) {
    navBar.hidden = !on;
    document.body.classList.toggle('has-nav', on);
  }

  // The current screen is done: draw the eye to "הבא".
  function nudgeNext() {
    navNext.classList.remove('pop');
    void navNext.offsetWidth; // restart the animation
    navNext.classList.add('pop');
    navNext.focus({ preventScroll: true });
  }

  navPrev.addEventListener('click', function () { if (at > 0) go(at - 1); });
  navNext.addEventListener('click', function () { if (at >= 0 && at < finishAt()) go(at + 1); });

  // Feedback line used by games and exercises.
  function feedbackLine() {
    var fb = el('div', { class: 'feedback', role: 'status' });
    return {
      node: fb,
      praise: function (text) { fb.className = 'feedback good'; fb.textContent = text || P.next('praise').text; },
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
    at = -1;
    showNav(false);
    var s = screen();
    s.appendChild(el('div', { class: 'center-msg' },
      el('div', { class: 'celebrate' }, '🔗'),
      el('h1', null, 'הקישור לא שלם'),
      el('p', { class: 'lead' }, 'ייתכן שחלק מהקישור נחתך. בקשו מהמורה לשלוח אותו שוב.')));
  }

  function showStart() {
    setProgress(0);
    at = -1;
    showNav(false);
    var s = screen();
    s.appendChild(el('div', { class: 'celebrate', 'aria-hidden': 'true' }, '📖'));
    s.appendChild(el('h1', null, R.text(lesson, lesson.title) || 'שיעור קריאה'));
    // An emoji this device cannot show is replaced by its word.
    s.appendChild(el('div', { class: 'big-emoji', style: 'font-size:2.6rem;letter-spacing:6px', 'aria-hidden': 'true' },
      lesson.targetWords.map(function (t, i) {
        var shown = U.emojiShown(t.emoji);
        return [i ? ' ' : '', shown ? t.emoji : el('span', { class: 'emoji-word' }, R.text(lesson, t.word))];
      })));
    s.appendChild(el('p', { class: 'lead' }, 'נשחק, נקרא סיפור ונענה על שאלות'));
    s.appendChild(el('div', { class: 'stage-actions' },
      el('button', { type: 'button', class: 'btn primary big', onclick: function () {
        if (ctx.hasVoice) ctx.speak(' '); // unlock speech on iOS (needs a user gesture)
        results = [];
        go(0);
      } }, 'מתחילים ▶')));
  }

  function runGame(i) {
    setProgress(i);
    var game = games[i];
    var s = screen();
    var id = screenId;
    var fb = feedbackLine();
    var area = el('div');
    var againBtn = el('button', { type: 'button', class: 'btn', hidden: true, onclick: function () { go(i); } }, '↻ שוב');

    s.appendChild(el('h1', null, game.name));
    s.appendChild(el('p', { class: 'lead' }, game.instruction));
    s.appendChild(area);
    s.appendChild(fb.node);
    s.appendChild(el('div', { class: 'stage-actions' }, againBtn));

    // A game may speak a word after a delay; once its screen is left, it stays quiet.
    var gctx = Object.assign({}, ctx, {
      praise: fb.praise,
      hint: fb.hint,
      speak: function (w) { if (id === screenId) return ctx.speak(w); }
    });
    game.play(area, gctx, function () {
      if (id !== screenId) return;
      setProgress(i + 1);
      fb.praise('סיימתם את המשחק! 🎉');
      againBtn.hidden = false;
      nudgeNext();
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
    var paced = window.Reading.controller({ reader: reader, story: lesson.story, onNext: function () { go(readingAt() + 1); } });
    cleanup = paced.destroy;
    s.appendChild(paced.top);
    s.appendChild(reader);
    s.appendChild(paced.bar);
    s.appendChild(paced.end);
  }

  function runExercise(i) {
    var exercises = lesson.exercises;
    var base = games.length + 1;
    var r = results[i] || (results[i] = { solved: false, firstTry: false, missed: false });
    setProgress(base + i + (r.solved ? 1 : 0));
    var s = screen();
    var id = screenId;
    var fb = feedbackLine();
    var area = el('div');

    s.appendChild(el('div', { class: 'row', style: 'justify-content:space-between' },
      el('span', { class: 'muted small' }, 'שאלה ' + (i + 1) + ' מתוך ' + exercises.length),
      el('button', { type: 'button', class: 'btn small quiet', onclick: storyOverlay }, '📖 לסיפור')));
    s.appendChild(area);
    s.appendChild(fb.node);

    // Exercises call hint() only after a wrong try. A wrong try counts even if the child leaves and comes back.
    // A gentle "try again" sentence is shown and heard; the child stays on the question.
    var ectx = Object.assign({}, ctx, {
      memo: r, // what the child wrote in open questions, kept while the lesson is open
      praise: fb.praise,
      hint: function (detail) {
        r.missed = true;
        if (id !== screenId) return;
        var item = P.next('try');
        fb.hint(item.text + ' ' + (detail || 'אפשר להציץ בסיפור.'));
        P.play(item);
      }
    });
    // Right: a praise sentence is shown and heard, then the next screen comes by itself
    // (after the sound, or 2 s with no sound). "הבא" before that moves on at once and cancels it.
    window.Exercises.render(area, exercises[i], lesson, ectx, function (firstTry) {
      if (id !== screenId || r.solved) return;
      r.solved = true;
      r.firstTry = firstTry && !r.missed;
      setProgress(base + i + 1);
      var item = P.next('praise');
      fb.praise(item.text);
      nudgeNext();
      P.play(item).then(function () { if (id === screenId) go(at + 1); });
    }, r.solved);
    if (r.solved) fb.praise('כבר עניתם נכון ✓');
  }

  function showFinish() {
    setProgress(progress.total);
    // Open questions (and open-style messages) are not checked, so the stars count the other exercises only.
    var n = lesson.exercises.length;
    var countable = lesson.exercises.filter(L.counts).length;
    var right = lesson.exercises.filter(function (ex, i) {
      return L.counts(ex) && results[i] && results[i].solved && results[i].firstTry;
    }).length;
    var ratio = countable ? right / countable : 1;
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
    s.appendChild(el('img', { class: 'finish-logo', src: 'assets/logo-web.png', width: 720, height: 271, alt: 'צועדים קדימה עם מיכל – למידה, ביטחון, הצלחה' }));
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
      P.setVoice(hasVoice);
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

  /* ---------- Sound on / off (every screen; remembered on this device) ---------- */

  function syncMute() {
    var off = P.muted();
    muteBtn.textContent = off ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-pressed', String(off));
    muteBtn.setAttribute('aria-label', off ? 'הפעלת הקול' : 'השתקת הקול');
    muteBtn.title = off ? 'הקול כבוי' : 'הקול פועל';
  }
  muteBtn.addEventListener('click', function () { P.setMuted(!P.muted()); syncMute(); });
  syncMute();

  window.addEventListener('hashchange', start);
  start();
})();
