/* Game: memory pairs, word ↔ picture (pictogram or emoji; a word with no picture: word ↔ the same word). */
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
        // A pictogram, else the emoji. No picture (or one this device cannot show): a word-word pair (the same
        // word on both cards). A pictogram that does not load falls back to the emoji, then to the word.
        var pic = window.Pics.has(t);
        cards.push({ id: id, kind: pic ? 'pic' : 'word', word: t.word, t: t });
        cards.push({ id: id, kind: 'word', word: t.word, t: t });
      });
      cards = U.shuffle(cards);

      var open = [];
      var matched = 0;
      var busy = false;
      var grid = el('div', { class: 'memory' });

      cards.forEach(function (card) {
        var face = el('span', { class: 'face' });
        var btn = el('button', { type: 'button', class: 'mcard' + (card.kind === 'word' ? ' word' : ''), 'aria-label': 'קלף' },
          el('span', { class: 'back', 'aria-hidden': 'true' }, '?'), face);
        var asWord = function () {
          card.kind = 'word';
          btn.classList.add('word');
          return document.createTextNode(ctx.show(card.word));
        };
        var picture = card.kind === 'pic' && window.Pics.node(card.t, {
          fallback: function (t) { return U.emojiShown(t.emoji) ? el('span', { class: 'emoji' }, t.emoji) : asWord(); }
        });
        if (picture) face.appendChild(picture); else face.appendChild(asWord());
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
