/* Game: build the word from shuffled letters (each letter keeps its nikud). */
(function () {
  'use strict';

  var U = window.Util;
  var H = window.Hebrew;
  var el = U.el;
  var MAX_ROUNDS = 5;

  window.Games = window.Games || {};
  window.Games.build = {
    name: 'הרכבת מילה',
    instruction: 'לחצו על האותיות לפי הסדר',
    available: function (ctx) { return ctx.targets.length >= 1; },

    play: function (area, ctx, done) {
      var rounds = U.shuffle(ctx.targets).slice(0, MAX_ROUNDS);
      var r = 0;
      playRound();

      function playRound() {
        U.clear(area);
        var target = rounds[r];
        var clusters = H.graphemes(ctx.show(target.word)).map(function (c) {
          return { text: c, space: !c.trim() };
        });
        var letters = clusters.filter(function (c) { return !c.space; });
        var pos = 0;
        var mistakes = 0;

        var head = el('div', null, el('div', { class: 'big-emoji', 'aria-hidden': 'true' }, target.emoji));
        if (ctx.hasVoice) {
          head.appendChild(el('button', { type: 'button', class: 'btn quiet small', 'aria-label': 'השמעה',
            onclick: function () { ctx.speak(target.word); } }, '🔊'));
        }
        area.appendChild(head);

        var slotsBox = el('div', { class: 'slots' });
        var slots = clusters.map(function (c) {
          var s = el('div', { class: 'slot' + (c.space ? ' filled' : '') }, c.space ? '' : '\u00A0');
          if (c.space) s.style.borderColor = 'transparent';
          slotsBox.appendChild(s);
          return s;
        });
        area.appendChild(slotsBox);

        // Slot index for each letter (skipping spaces).
        var slotOf = [];
        clusters.forEach(function (c, i) { if (!c.space) slotOf.push(i); });

        var tilesBox = el('div', { class: 'tiles' });
        var tiles = U.shuffleChanged(letters.map(function (c, i) { return { text: c.text, idx: i }; }),
          function (a, b) { return a.text === b.text; });
        tiles.forEach(function (t) {
          t.btn = el('button', { type: 'button', class: 'tile' }, t.text);
          t.btn.addEventListener('click', function () { tap(t); });
          tilesBox.appendChild(t.btn);
        });
        area.appendChild(tilesBox);

        function tap(t) {
          if (t.used || pos >= letters.length) return;
          if (t.text === letters[pos].text) {
            t.used = true;
            t.btn.classList.add('used');
            t.btn.classList.remove('hint');
            var slot = slots[slotOf[pos]];
            slot.textContent = t.text;
            slot.classList.add('filled', 'pop');
            pos++;
            mistakes = 0;
            if (pos === letters.length) finishRound();
          } else {
            mistakes++;
            t.btn.classList.remove('wiggle');
            void t.btn.offsetWidth;
            t.btn.classList.add('wiggle');
            if (mistakes >= 2) {
              var next = tiles.filter(function (x) { return !x.used && x.text === letters[pos].text; })[0];
              if (next) next.btn.classList.add('hint');
              ctx.hint('רמז: האות הבאה מסומנת 🙂');
            } else {
              ctx.hint('נסו אות אחרת 🙂');
            }
          }
        }

        function finishRound() {
          ctx.praise();
          ctx.speak(target.word);
          setTimeout(function () {
            r++;
            if (r < rounds.length) playRound(); else done();
          }, 1400);
        }
      }
    }
  };
})();
