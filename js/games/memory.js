/* Game: memory pairs, word ↔ emoji. */
(function () {
  'use strict';

  var U = window.Util;
  var el = U.el;
  var MAX_PAIRS = 6;

  window.Games = window.Games || {};
  window.Games.memory = {
    name: 'זוגות',
    instruction: 'הפכו שני קלפים ומצאו מילה ותמונה שמתאימות',
    available: function (ctx) { return ctx.targets.length >= 2; },

    play: function (area, ctx, done) {
      var pairs = U.shuffle(ctx.targets).slice(0, MAX_PAIRS);
      var cards = [];
      pairs.forEach(function (t, id) {
        cards.push({ id: id, kind: 'emoji', label: t.emoji, word: t.word });
        cards.push({ id: id, kind: 'word', label: ctx.show(t.word), word: t.word });
      });
      cards = U.shuffle(cards);

      var open = [];
      var matched = 0;
      var busy = false;
      var grid = el('div', { class: 'memory' });

      cards.forEach(function (card) {
        var btn = el('button', { type: 'button', class: 'mcard' + (card.kind === 'word' ? ' word' : ''), 'aria-label': 'קלף' },
          el('span', { class: 'back', 'aria-hidden': 'true' }, '?'),
          el('span', { class: 'face' }, card.label));
        card.btn = btn;
        btn.addEventListener('click', function () { flip(card); });
        grid.appendChild(btn);
      });
      area.appendChild(grid);

      function flip(card) {
        if (busy || card.matched || open.indexOf(card) !== -1) return;
        card.btn.classList.add('open');
        open.push(card);
        if (card.kind === 'word') ctx.speak(card.word);
        if (open.length < 2) return;

        var a = open[0], b = open[1];
        if (a.id === b.id) {
          a.matched = b.matched = true;
          a.btn.classList.add('matched', 'pop');
          b.btn.classList.add('matched', 'pop');
          open = [];
          matched++;
          ctx.praise();
          if (matched === pairs.length) setTimeout(done, 600);
        } else {
          busy = true;
          setTimeout(function () {
            a.btn.classList.remove('open');
            b.btn.classList.remove('open');
            open = [];
            busy = false;
          }, 1100);
        }
      }
    }
  };
})();
