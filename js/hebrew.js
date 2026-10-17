/* Hebrew / nikud helpers. Exposes window.Hebrew. */
(function () {
  'use strict';

  // Points and cantillation in U+0591–U+05C7, minus the punctuation that lives
  // in the same block: maqaf (05BE), paseq (05C0), sof pasuq (05C3), nun hafukha (05C6).
  var MARKS_RE = /[֑-ׇֽֿׁׂׅׄ]/g;
  var INVISIBLE_RE = /[​-‍⁠﻿]/g;
  var PREFIX_RE = /^[ושהבכלמ]{1,3}$/;
  // A word: letters/marks/digits, optionally joined by geresh/gershayim/quotes
  // (צ׳יפס, צה"ל), optionally ending with a geresh (ג׳).
  var WORD_RE = /[\p{L}\p{M}\p{N}]+(?:[׳״'"][\p{L}\p{M}\p{N}]+)*[׳']?/gu;

  function normalize(s) {
    // NFC applies canonical mark ordering and decomposes presentation forms
    // (e.g. U+FB2A), so identical vocalization from different sources compares equal.
    return String(s == null ? '' : s).replace(INVISIBLE_RE, '').normalize('NFC');
  }

  function stripNikud(s) {
    return normalize(s).replace(MARKS_RE, '');
  }

  // Bare letters only, for word comparison.
  function bare(s) {
    return stripNikud(s).replace(/[^\p{L}\p{N}]/gu, '');
  }

  function matchesWord(token, target) {
    var t = bare(token);
    var w = bare(target);
    if (!t || !w) return false;
    if (t === w) return true;
    if (t.length > w.length && t.slice(-w.length) === w &&
        PREFIX_RE.test(t.slice(0, t.length - w.length))) {
      return true;
    }
    // Target given with the article: בגינה / לגינה should match הגינה.
    if (w.charAt(0) === 'ה' && w.length > 2) {
      var rest = w.slice(1);
      if (t === rest) return true;
      if (t.length > rest.length && t.slice(-rest.length) === rest &&
          PREFIX_RE.test(t.slice(0, t.length - rest.length))) {
        return true;
      }
    }
    return false;
  }

  function matchesAny(token, targets) {
    for (var i = 0; i < targets.length; i++) {
      if (matchesWord(token, targets[i])) return true;
    }
    return false;
  }

  // Split text into [{text, isWord}] segments; joining all .text gives back the input.
  function tokenize(text) {
    text = normalize(text);
    var out = [];
    var last = 0;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), isWord: false });
      out.push({ text: m[0], isWord: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), isWord: false });
    return out;
  }

  function countWords(text) {
    return tokenize(text).filter(function (t) { return t.isWord; }).length;
  }

  // Apply a nikud display mode to stored (fully vocalized) text.
  // targets: array of target word strings.
  function displayText(text, mode, targets) {
    text = normalize(text);
    if (mode === 'none') return stripNikud(text);
    if (mode === 'partial') {
      return tokenize(text).map(function (seg) {
        if (!seg.isWord) return seg.text;
        return matchesAny(seg.text, targets || []) ? seg.text : stripNikud(seg.text);
      }).join('');
    }
    return text;
  }

  // Split a word into letter clusters: base character + its marks (+ trailing geresh).
  function graphemes(word) {
    return normalize(word).match(/[^\p{M}][\p{M}]*[׳']?/gu) || [];
  }

  window.Hebrew = {
    normalize: normalize,
    stripNikud: stripNikud,
    bare: bare,
    matchesWord: matchesWord,
    matchesAny: matchesAny,
    tokenize: tokenize,
    countWords: countWords,
    displayText: displayText,
    graphemes: graphemes
  };
})();
