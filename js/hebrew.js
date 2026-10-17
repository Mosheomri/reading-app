/* Hebrew / nikud helpers. Exposes window.Hebrew. */
(function () {
  'use strict';

  // Points and cantillation in U+0591–U+05C7, minus the punctuation that lives
  // in the same block: maqaf (05BE), paseq (05C0), sof pasuq (05C3), nun hafukha (05C6).
  var MARKS_RE = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
  var INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  var PREFIX_RE = /^[ושהבכלמ]{1,3}$/;
  // A word: letters/marks/digits, optionally joined by geresh/gershayim/quotes
  // (צ׳יפס, צה"ל), optionally ending with a geresh (ג׳).
  var WORD_RE = /[\p{L}\p{M}\p{N}]+(?:[\u05F3\u05F4'"][\p{L}\p{M}\p{N}]+)*[\u05F3']?/gu;

  function normalize(s) {
    // NFC applies canonical mark ordering and decomposes presentation forms
    // (e.g. U+FB2A), so identical vocalization from different sources compares equal.
    return String(s == null ? '' : s).replace(INVISIBLE_RE, '').normalize('NFC');
  }

  function stripNikud(s) {
    return normalize(s).replace(MARKS_RE, '');
  }

  var HAS_MARK_RE = new RegExp(MARKS_RE.source);

  function hasNikud(s) {
    return HAS_MARK_RE.test(s);
  }

  function isHebrew(s) {
    return /[א-ת]/.test(s);
  }

  // A Hebrew word that has no nikud mark at all.
  function isUnvocalized(word) {
    return isHebrew(word) && !hasNikud(word);
  }

  // Bare letters only, for word comparison.
  function bare(s) {
    return stripNikud(s).replace(/[^\p{L}\p{N}]/gu, '');
  }

  /* ---------- Word matching ---------- */

  var DAGESH = '\u05BC';
  var SHEVA = '\u05B0';
  // Cantillation and meteg never distinguish words for a young reader.
  var IGNORED_MARKS_RE = /[\u0591-\u05AF\u05BD]/g;

  // Letter clusters (letter + its marks), one per bare letter.
  function letterClusters(word) {
    return graphemes(word).filter(function (c) { return /[\p{L}\p{N}]/u.test(c.charAt(0)); });
  }

  // The marks of a cluster as a comparable key.
  // first: the word's first letter, where a prefix changes the nikud
  // (dagesh after ה הידיעה, dagesh kal dropped after ו/ב/כ/ל, sheva dropped as in וִילָדִים).
  function marksKey(cluster, first, hasPrefix) {
    var marks = cluster.slice(1).replace(/[^\p{M}]/gu, '').replace(IGNORED_MARKS_RE, '')
      .replace(/\u05BA/g, '\u05B9'); // holam haser for vav = holam
    if (first) marks = marks.split(DAGESH).join('');
    if (first && hasPrefix) marks = marks.split(SHEVA).join('');
    return marks.split('').sort().join('');
  }

  // Same nikud on the part of token that corresponds to target (after prefixLen letters).
  function sameNikud(token, target, prefixLen) {
    var tc = letterClusters(token).slice(prefixLen);
    var wc = letterClusters(target);
    if (tc.length !== wc.length) return false;
    for (var i = 0; i < wc.length; i++) {
      if (marksKey(tc[i], i === 0, prefixLen > 0) !== marksKey(wc[i], i === 0, prefixLen > 0)) return false;
    }
    return true;
  }

  // Number of prefix letters if bare letters `t` are `w` with an allowed prefix, else -1.
  function prefixLength(t, w) {
    if (t === w) return 0;
    if (t.length > w.length && t.slice(-w.length) === w && PREFIX_RE.test(t.slice(0, t.length - w.length))) {
      return t.length - w.length;
    }
    return -1;
  }

  // Does a story token match a target word (allowing prefixes)?
  // When both are vocalized the nikud must match too; ignoreNikud compares letters only.
  function matchesWord(token, target, ignoreNikud) {
    var t = bare(token);
    var w = bare(target);
    if (!t || !w) return false;
    var forms = [{ letters: w, word: target }];
    // Target given with the article: בגינה / לגינה should match הגינה.
    if (w.charAt(0) === 'ה' && w.length > 2) {
      forms.push({ letters: w.slice(1), word: letterClusters(target).slice(1).join('') });
    }
    var checkNikud = !ignoreNikud && hasNikud(token) && hasNikud(target);
    for (var i = 0; i < forms.length; i++) {
      var p = prefixLength(t, forms[i].letters);
      if (p === -1) continue;
      if (!checkNikud || sameNikud(token, forms[i].word, p)) return true;
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
    return normalize(word).match(/[^\p{M}][\p{M}]*[\u05F3']?/gu) || [];
  }

  window.Hebrew = {
    normalize: normalize,
    stripNikud: stripNikud,
    hasNikud: hasNikud,
    isHebrew: isHebrew,
    isUnvocalized: isUnvocalized,
    bare: bare,
    matchesWord: matchesWord,
    matchesAny: matchesAny,
    tokenize: tokenize,
    countWords: countWords,
    displayText: displayText,
    graphemes: graphemes
  };
})();
