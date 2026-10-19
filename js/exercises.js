/* Exercise renderers: mcq, tf, fill, order, open, locate, message. Exposes window.Exercises. */
(function () {
  'use strict';

  var U = window.Util;
  var R = window.Render;
  var el = U.el;

  // Shared logic for "pick one button" exercises.
  // items: [{label: Node|string, correct: bool}]
  // done: already answered right, so show the right option marked and accept no clicks.
  function choiceButtons(area, items, ctx, onRight, twoCols, done) {
    var firstTry = true;
    var solved = !!done;
    var box = el('div', { class: 'options' + (twoCols ? ' two' : '') });
    items.forEach(function (item) {
      var btn = el('button', { type: 'button', class: 'option' + (done && item.correct ? ' right' : '') }, item.label);
      btn.addEventListener('click', function () {
        if (solved || btn.classList.contains('tried')) return;
        if (item.correct) {
          solved = true;
          btn.classList.add('right', 'pop');
          onRight(firstTry);
        } else {
          firstTry = false;
          btn.classList.add('tried', 'wiggle');
          ctx.hint(''); // the player adds a "try again" sentence (js/praise.js)
        }
      });
      box.appendChild(btn);
    });
    area.appendChild(box);
  }

  function shuffledOptions(lesson, ex) {
    return U.shuffle(ex.options.map(function (o, i) {
      return { label: R.text(lesson, o), correct: i === ex.answer };
    }));
  }

  function mcq(area, ex, lesson, ctx, solved, done) {
    area.appendChild(el('div', { class: 'question' }, R.text(lesson, ex.question)));
    choiceButtons(area, shuffledOptions(lesson, ex), ctx, solved, false, done);
  }

  function tf(area, ex, lesson, ctx, solved, done) {
    area.appendChild(el('div', { class: 'question' }, R.text(lesson, ex.statement)));
    choiceButtons(area, [
      { label: '👍 נכון', correct: ex.answer === true },
      { label: '👎 לא נכון', correct: ex.answer === false }
    ], ctx, solved, true, done);
  }

  function fill(area, ex, lesson, ctx, solved, done) {
    var q = el('div', { class: 'question' }, R.fillSentence(lesson, ex.sentence, done ? ex.options[ex.answer] : undefined));
    area.appendChild(q);
    choiceButtons(area, shuffledOptions(lesson, ex), ctx, function (firstTry) {
      U.clear(q).appendChild(R.fillSentence(lesson, ex.sentence, ex.options[ex.answer]));
      solved(firstTry);
    }, false, done);
  }

  function order(area, ex, lesson, ctx, solved, done) {
    var n = ex.sentences.length;
    var all = ex.sentences.map(function (s, i) { return i; });
    var locked = done ? n : 0;            // correct prefix already confirmed
    var answer = done ? all : [];         // indices placed by the child
    var pool = done ? [] : U.shuffleChanged(all);
    var firstTry = true;

    area.appendChild(el('div', { class: 'question' }, 'סדרו את המשפטים לפי הסדר בסיפור'));
    area.appendChild(el('p', { class: 'muted small' }, 'לחצו על המשפט הראשון, אחר כך על השני, וכך הלאה.'));
    var answerBox = el('div', { class: 'order-list answer' });
    var poolBox = el('div', { class: 'order-list' });
    area.appendChild(answerBox);
    area.appendChild(poolBox);
    draw();

    function item(idx, num, isLocked, onClick) {
      var b = el('button', { type: 'button', class: 'order-item' + (isLocked ? ' locked' : '') },
        num ? el('span', { class: 'num' }, String(num)) : null,
        el('span', null, R.text(lesson, ex.sentences[idx])));
      if (onClick) b.addEventListener('click', onClick);
      return b;
    }

    function draw() {
      U.clear(answerBox);
      U.clear(poolBox);
      answer.forEach(function (idx, k) {
        var isLocked = k < locked;
        answerBox.appendChild(item(idx, k + 1, isLocked, isLocked ? null : function () {
          answer.splice(k, 1);
          pool.push(idx);
          draw();
        }));
      });
      if (!answer.length) answerBox.appendChild(el('div', { class: 'muted small', style: 'padding:12px' }, 'המשפטים שתבחרו יופיעו כאן'));
      pool.forEach(function (idx, k) {
        poolBox.appendChild(item(idx, null, false, function () {
          pool.splice(k, 1);
          answer.push(idx);
          draw();
          if (!pool.length) check();
        }));
      });
    }

    function check() {
      var k = 0;
      while (k < n && answer[k] === k) k++;
      if (k === n) {
        locked = n;
        draw();
        solved(firstTry);
        return;
      }
      firstTry = false;
      locked = k;
      pool = U.shuffle(answer.slice(k));
      answer = answer.slice(0, k);
      setTimeout(function () {
        draw();
        ctx.hint(k ? (k === 1 ? 'המשפט הראשון במקום' : k + ' המשפטים הראשונים במקום') + '. סדרו את השאר.' : '');
      }, 500);
    }
  }

  // An open question: the child may write an answer (not required), presses "סיימתי" and sees a sample
  // answer. There is no wrong answer. What was written is kept in ctx.memo[key] while the lesson is open.
  function openPart(area, part, lesson, ctx, onDone, done, key) {
    var memo = ctx.memo || {};
    area.appendChild(el('div', { class: 'question' }, R.text(lesson, part.question)));
    var box = el('textarea', { class: 'open-answer', rows: 3, lang: 'he', dir: 'rtl', 'aria-label': 'התשובה שלי',
      placeholder: 'אפשר לכתוב כאן את התשובה (לא חובה)' });
    box.value = memo[key] || '';
    box.readOnly = !!done;
    box.addEventListener('input', function () { memo[key] = box.value; });
    var sample = el('div', { class: 'sample-answer', hidden: !done, role: 'status' },
      el('div', { class: 'sample-label' }, 'תשובה לדוגמה:'), el('div', null, R.text(lesson, part.sampleAnswer)));
    var btn = el('button', { type: 'button', class: 'btn primary big', hidden: !!done }, 'סיימתי ✓');
    btn.addEventListener('click', function () {
      btn.hidden = true;
      box.readOnly = true;
      sample.hidden = false;
      onDone(true);
    });
    area.appendChild(box);
    area.appendChild(el('div', { class: 'stage-actions' }, btn));
    area.appendChild(sample);
  }

  function open(area, ex, lesson, ctx, solved, done) {
    openPart(area, ex, lesson, ctx, solved, done, 'open');
  }

  // Locate: the story with every sentence clickable; the child clicks the one that answers the question.
  // Any sentence that overlaps the answer sentence (found without nikud, as in the order exercise) is right.
  function locate(area, ex, lesson, ctx, solved, done) {
    var Ls = window.Lesson;
    var start = Ls.findSentence(Ls.bareWords(lesson.story), ex.sentence);
    var len = Ls.bareWords(ex.sentence).length;
    var story = R.storySentences(lesson);
    var firstTry = true;
    var isSolved = !!done;
    // An answer not found in the story (a broken lesson) must not leave the child stuck.
    function hits(s) { return start < 0 || (s.start < start + len && s.end > start); }
    function markRight() {
      story.sentences.forEach(function (s) { if (start >= 0 && hits(s)) s.node.classList.add('right'); });
    }

    area.appendChild(el('div', { class: 'question' }, R.text(lesson, ex.question)));
    area.appendChild(el('p', { class: 'muted small' }, 'לחצו בסיפור על המשפט שעונה על השאלה.'));
    story.sentences.forEach(function (s) {
      function choose() {
        if (isSolved || s.node.classList.contains('tried')) return;
        if (hits(s)) {
          isSolved = true;
          markRight();
          solved(firstTry);
        } else {
          firstTry = false;
          s.node.classList.add('tried');
          ctx.hint('המשפט הזה לא עונה על השאלה. חפשו משפט אחר בסיפור.');
        }
      }
      s.node.addEventListener('click', choose);
      s.node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      });
    });
    if (done) markRight();
    area.appendChild(el('div', { class: 'reader locate-story' }, el('div', { class: 'story' }, story.node)));
  }

  // Message: the visible message (what the story says), then the hidden one (what it teaches).
  // Each part is a multiple-choice question (with options) or an open one (with a sample answer).
  // Right on the first try = both parts right on the first try.
  var MESSAGE_PARTS = [
    { key: 'visible', title: 'המסר הגלוי', hint: 'מה כתוב בסיפור במפורש?' },
    { key: 'hidden', title: 'המסר הסמוי', hint: 'מה הסיפור מלמד אותנו, גם אם זה לא כתוב בו?' }
  ];

  function message(area, ex, lesson, ctx, solved, done) {
    var allFirst = true;
    function showPart(k) {
      var info = MESSAGE_PARTS[k];
      var part = ex[info.key];
      var box = el('div', { class: 'message-part', 'data-part': info.key },
        el('div', { class: 'part-title' }, info.title),
        el('p', { class: 'muted small' }, info.hint));
      area.appendChild(box);
      function next(firstTry) {
        allFirst = allFirst && firstTry;
        if (k === 0) {
          ctx.praise('יופי! עכשיו המסר הסמוי.');
          var second = showPart(1);
          if (second.scrollIntoView) second.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else solved(allFirst);
      }
      if (part.options) {
        box.appendChild(el('div', { class: 'question' }, R.text(lesson, part.question)));
        choiceButtons(box, shuffledOptions(lesson, part), ctx, next, false, done);
      } else {
        openPart(box, part, lesson, ctx, next, done, info.key);
      }
      return box;
    }
    showPart(0);
    if (done) showPart(1);
  }

  var RENDERERS = { mcq: mcq, tf: tf, fill: fill, order: order, open: open, locate: locate, message: message };

  // solved(firstTry) is called once when the child gets it right.
  // ctx.hint(detail) after a wrong try: detail says what is right so far ('' = nothing to add).
  // done: the exercise was already answered right; it is shown solved and solved() is not called.
  function render(area, ex, lesson, ctx, solved, done) {
    var fn = RENDERERS[ex.type];
    if (fn) fn(area, ex, lesson, ctx, solved, !!done);
    else if (!done) solved(true);
  }

  window.Exercises = { render: render };
})();
