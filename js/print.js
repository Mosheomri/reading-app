/* Printable worksheet (A4): name/date line, title, target words, story, exercises with answer marks,
   and an optional answer page. Exposes window.Print. */
(function () {
  'use strict';

  var R = window.Render;
  var L = window.Lesson;
  var el = window.Util.el;

  /* ---------- Fixed shuffle: same lesson → same sheet ---------- */

  // FNV-1a hash of a string, as a 32-bit seed.
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  // mulberry32: small seeded PRNG, returns floats in [0, 1).
  function seededRandom(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A permutation of 0..n-1 that differs from the original order when possible.
  function permutation(n, random) {
    var identity = [];
    for (var i = 0; i < n; i++) identity.push(i);
    if (n < 2) return identity;
    for (var tries = 0; tries < 10; tries++) {
      var p = identity.slice();
      for (var j = n - 1; j > 0; j--) {
        var k = Math.floor(random() * (j + 1));
        var t = p[j]; p[j] = p[k]; p[k] = t;
      }
      if (p.some(function (v, idx) { return v !== idx; })) return p;
    }
    return identity.reverse();
  }

  // Which exercise is printed with which order: [{ex, number, order: [original indices in print order]}].
  // The seed is the lesson content, so printing the same lesson again gives the same sheet.
  function layout(lesson) {
    var random = seededRandom(hashString(JSON.stringify(L.clean(lesson))));
    var number = 0;
    return lesson.exercises.filter(function (ex) { return !ex.unknown; }).map(function (ex) {
      var n = ex.type === 'order' ? ex.sentences.length : ex.options ? ex.options.length : 0;
      return { ex: ex, number: ++number, order: ex.type === 'tf' ? [] : permutation(n, random) };
    });
  }

  /* ---------- Sheet ---------- */

  var INSTRUCTIONS = {
    mcq: 'סַמְּנוּ אֶת הַתְּשׁוּבָה הַנְּכוֹנָה.',
    tf: 'סַמְּנוּ: נָכוֹן אוֹ לֹא נָכוֹן.',
    fill: 'הַשְׁלִימוּ אֶת הַמִּלָּה הַחֲסֵרָה. בַּחֲרוּ מִן הַמִּלִּים בַּמִּסְגֶּרֶת.',
    order: 'כִּתְבוּ מִסְפָּר לְיַד כָּל מִשְׁפָּט, לְפִי הַסֵּדֶר בַּסִּפּוּר.'
  };

  function mark(kind) {
    return el('span', { class: 'p-mark p-' + kind, 'aria-hidden': 'true' });
  }

  function question(lesson, item) {
    var ex = item.ex;
    var t = function (s) { return R.text(lesson, s); };
    var box = el('section', { class: 'p-q', 'data-type': ex.type });
    var head = el('div', { class: 'p-q-text' }, el('span', { class: 'p-num' }, item.number + '.'));
    box.appendChild(el('div', { class: 'p-instr' }, R.text(lesson, INSTRUCTIONS[ex.type])));
    box.appendChild(head);

    if (ex.type === 'mcq') {
      head.appendChild(document.createTextNode(' ' + t(ex.question)));
      box.appendChild(el('ul', { class: 'p-options' }, item.order.map(function (i) {
        return el('li', null, mark('circle'), t(ex.options[i]));
      })));
    } else if (ex.type === 'tf') {
      head.appendChild(document.createTextNode(' ' + t(ex.statement)));
      box.appendChild(el('div', { class: 'p-tf' },
        el('span', null, mark('square'), R.text(lesson, 'נָכוֹן')),
        el('span', null, mark('square'), R.text(lesson, 'לֹא נָכוֹן'))));
    } else if (ex.type === 'fill') {
      var parts = ex.sentence.split('___');
      parts.forEach(function (part, i) {
        head.appendChild(document.createTextNode((i ? '' : ' ') + t(part)));
        if (i < parts.length - 1) head.appendChild(el('span', { class: 'p-line' }));
      });
      box.appendChild(el('div', { class: 'p-bank' }, item.order.map(function (i) {
        return el('span', null, t(ex.options[i]));
      })));
    } else if (ex.type === 'order') {
      head.appendChild(document.createTextNode(' ' + R.text(lesson, 'מָה קָרָה קֹדֶם?')));
      box.appendChild(el('ul', { class: 'p-order' }, item.order.map(function (i) {
        return el('li', null, mark('box'), t(ex.sentences[i]));
      })));
    }
    return box;
  }

  // The correct answer of one exercise: text, or for order a list of the printed sentences
  // with the number that belongs next to each (a bare "2, 4, 3, 1" is ambiguous in RTL).
  function answer(lesson, item) {
    var ex = item.ex;
    var t = function (s) { return R.text(lesson, s); };
    if (ex.type === 'mcq' || ex.type === 'fill') return t(ex.options[ex.answer]);
    if (ex.type === 'tf') return ex.answer ? 'נכון' : 'לא נכון';
    return el('ul', { class: 'p-order-key' }, item.order.map(function (i) {
      return el('li', null, el('span', { class: 'p-key' }, String(i + 1)), t(ex.sentences[i]));
    }));
  }

  // opts: {answers: boolean}. Returns the sheet element.
  function build(lesson, opts) {
    opts = opts || {};
    var items = layout(lesson);
    var sheet = el('div', { class: 'print-sheet', lang: 'he', dir: 'rtl' });
    sheet.appendChild(el('div', { class: 'p-head' },
      el('span', null, 'שם: ', el('span', { class: 'p-fill' })),
      el('span', null, 'תאריך: ', el('span', { class: 'p-fill short' }))));
    sheet.appendChild(el('h1', { class: 'p-title' }, R.text(lesson, lesson.title)));
    sheet.appendChild(el('div', { class: 'p-targets' }, lesson.targetWords.filter(function (tw) { return tw.word; }).map(function (tw) {
      return el('span', { class: 'p-target' }, tw.emoji ? tw.emoji + ' ' : '', R.text(lesson, tw.word));
    })));
    sheet.appendChild(el('div', { class: 'story p-story' }, R.story(lesson)));
    if (items.length) {
      sheet.appendChild(el('h2', { class: 'p-section' }, R.text(lesson, 'שְׁאֵלוֹת')));
      items.forEach(function (item) { sheet.appendChild(question(lesson, item)); });
    }
    if (opts.answers) {
      sheet.appendChild(el('div', { class: 'p-answers' },
        el('h2', null, 'דף תשובות' + (lesson.title ? ': ' + R.text(lesson, lesson.title) : '')),
        el('ol', null, items.map(function (item) { return el('li', { value: item.number }, answer(lesson, item)); }))));
    }
    return sheet;
  }

  window.Print = { hashString: hashString, layout: layout, build: build };
})();
