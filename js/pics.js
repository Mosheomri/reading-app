/* Pictograms from ARASAAC (arasaac.org) for the target words. Exposes window.Pics.
   A target word may have `pic`: an ARASAAC pictogram id. Shown before its emoji; when the image does not load,
   the emoji is shown instead, and with no emoji there is no picture (like a word with no emoji).
   The teacher picks the picture (search: bestsearch, then search); nothing is chosen automatically. */
(function () {
  'use strict';

  var U = window.Util;
  var el = U.el;
  var MAX_RESULTS = 6;

  var Pics = {
    // The search API and the image server; tests point them at a mock.
    API: 'https://api.arasaac.org/v1/pictograms/he/',
    STATIC: 'https://static.arasaac.org/pictograms/',
    MAX_RESULTS: MAX_RESULTS,
    // The official credit (arasaac.org, terms of use, "How to cite the ARASAAC license"), in Hebrew.
    CREDIT: 'הסמלים הפיקטוגרפיים הם רכוש ממשלת אראגון (ספרד) ונוצרו על ידי סרחיו פאלאו עבור ARASAAC (arasaac.org), ' +
      'שמפיצה אותם ברישיון Creative Commons BY-NC-SA.',
    LICENSE_URL: 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.he'
  };

  // A pictogram id: a positive whole number, else 0 (none). Needs js/lesson.js.
  Pics.valid = window.Lesson.picId;

  Pics.url = function (id) { return Pics.STATIC + id + '/' + id + '_300.png'; };

  // Does the lesson show at least one pictogram (then the credit line is shown)?
  Pics.any = function (lesson) {
    return !!(lesson && lesson.targetWords && lesson.targetWords.some(function (t) { return t.word && Pics.valid(t.pic); }));
  };

  // Search ARASAAC for a word (without nikud): bestsearch, then search if it found nothing.
  // Resolves to up to MAX_RESULTS ids ([] = nothing found); rejects when ARASAAC cannot be reached.
  // A 404 is ARASAAC's answer for "nothing found".
  function get(kind, text) {
    return fetch(Pics.API + kind + '/' + encodeURIComponent(text)).then(function (r) {
      if (r.status === 404) return [];
      if (!r.ok) throw new Error('ARASAAC ' + r.status);
      return r.json();
    }).then(function (list) {
      return (Array.isArray(list) ? list : []).map(function (p) { return Pics.valid(p && p._id); }).filter(Boolean);
    });
  }
  Pics.search = function (text) {
    text = String(text || '').trim();
    if (!text) return Promise.resolve([]);
    return get('bestsearch', text).then(function (ids) {
      return ids.length ? ids : get('search', text);
    }).then(function (ids) {
      return ids.filter(function (id, i) { return ids.indexOf(id) === i; }).slice(0, MAX_RESULTS);
    });
  };

  // The emoji of a target word as an element, or null (no emoji, or one this device cannot show).
  function emojiNode(t) {
    return U.emojiShown(t.emoji) ? el('span', { class: 'emoji' }, t.emoji) : null;
  }

  // The picture of a target word: its pictogram, else its emoji, else null (no picture, no empty place).
  // opts.alt: the image's alt (default the word); opts.fallback(t): what replaces a pictogram that does not load
  // (default: the emoji, or nothing).
  Pics.node = function (t, opts) {
    opts = opts || {};
    var fallback = opts.fallback || emojiNode;
    var id = Pics.valid(t.pic);
    if (!id) return emojiNode(t);
    var img = el('img', { class: 'pic', src: Pics.url(id), alt: opts.alt != null ? opts.alt : t.word, draggable: 'false' });
    img.addEventListener('error', function () {
      var rep = fallback(t);
      if (rep) img.replaceWith(rep); else img.remove();
    });
    return img;
  };

  // Does the word have a picture to show (a pictogram, or an emoji this device shows)?
  Pics.has = function (t) { return !!Pics.valid(t.pic) || U.emojiShown(t.emoji); };

  // The small credit line (only when the lesson has a pictogram; else null).
  Pics.credit = function (lesson, attrs) {
    if (!Pics.any(lesson)) return null;
    return el('p', Object.assign({ class: 'pic-credit' }, attrs || {}), Pics.CREDIT + ' ',
      el('a', { href: Pics.LICENSE_URL, target: '_blank', rel: 'noopener' }, 'פרטי הרישיון'));
  };

  window.Pics = Pics;
})();
