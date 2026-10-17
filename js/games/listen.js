/* Game: hear a word (Web Speech API, he-IL) and pick it. Skipped when no Hebrew voice exists. */
(function () {
  'use strict';

  var U = window.Util;
  var el = U.el;
  var MAX_ROUNDS = 5;

  window.Games = window.Games || {};
  window.Games.listen = {
    name: 'שומעים ובוחרים',
    instruction: 'הקשיבו ובחרו את המילה ששמעתם',
    available: function (ctx) { return ctx.hasVoice && ctx.targets.length >= 2; },

    play: function (area, ctx, done) {
      var rounds = U.shuffle(ctx.targets).slice(0, MAX_ROUNDS);
      var r = 0;
      playRound();

      function playRound() {
        U.clear(area);
        var target = rounds[r];
        var others = U.shuffle(ctx.targets.filter(function (t) { return t !== target; })).slice(0, 3);
        var choices = U.shuffle([target].concat(others));
        var solved = false;

        area.appendChild(el('button', { type: 'button', class: 'btn primary speak-btn', 'aria-label': 'השמעה שוב',
          onclick: function () { ctx.speak(target.word); } }, '🔊'));

        var opts = el('div', { class: 'options', style: 'margin-top:20px' });
        choices.forEach(function (t) {
          var btn = el('button', { type: 'button', class: 'option' }, ctx.show(t.word));
          btn.addEventListener('click', function () {
            if (solved) return;
            if (t === target) {
              solved = true;
              btn.classList.add('right', 'pop');
              ctx.praise();
              setTimeout(function () {
                r++;
                if (r < rounds.length) playRound(); else done();
              }, 1300);
            } else {
              btn.classList.add('tried');
              ctx.hint('נקשיב שוב 👂');
              setTimeout(function () { ctx.speak(target.word); }, 500);
            }
          });
          opts.appendChild(btn);
        });
        area.appendChild(opts);

        setTimeout(function () { ctx.speak(target.word); }, 400);
      }
    }
  };
})();
