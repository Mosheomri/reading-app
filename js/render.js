/* Rendering shared by the teacher preview and the child player. Exposes window.Render. */
(function () {
  'use strict';

  var H = window.Hebrew;
  var el = window.Util.el;

  function targetsOf(lesson) {
    return lesson.targetWords.map(function (t) { return t.word; });
  }

  // Any lesson text (title, questions, options) in the lesson's nikud mode.
  function text(lesson, s) {
    return H.displayText(s, lesson.nikudMode, targetsOf(lesson));
  }

  // Teacher preview: in full-nikud mode, flag Hebrew words that have no nikud.
  function flagUnvocalized(lesson, word) {
    return lesson.nikudMode === 'full' && H.isUnvocalized(word);
  }

  // Like text(), but as a node with unvocalized words marked (teacher preview).
  function markedText(lesson, s) {
    var shown = text(lesson, s || '');
    if (lesson.nikudMode !== 'full') return document.createTextNode(shown);
    var out = el('span');
    H.tokenize(shown).forEach(function (seg) {
      out.appendChild(seg.isWord && H.isUnvocalized(seg.text)
        ? el('span', { class: 'no-nikud' }, seg.text)
        : document.createTextNode(seg.text));
    });
    return out;
  }

  // Punctuation touching a word belongs to it: text between two words is split at its whitespace,
  // the part before the first whitespace closes the previous word ("קָטָן."), the part after the last
  // whitespace opens the next one ("כֶּלֶב). Text with no whitespace (a maqaf) stays with the previous word.
  // Returns [{space, lead, word, trail}]: `space` is the loose text before the unit (whitespace, a dash
  // between spaces); a last entry with word null holds what follows the last word.
  function storyUnits(para) {
    var units = [];
    var pending = ''; // text before the next word that is not yet assigned
    H.tokenize(para).forEach(function (seg) {
      if (seg.isWord) {
        var m = pending.match(/^([\s\S]*\s)?(\S*)$/);
        units.push({ space: m[1] || '', lead: m[2], word: seg.text, trail: '' });
        pending = '';
        return;
      }
      var last = units[units.length - 1];
      if (!last) { pending += seg.text; return; }
      var ws = seg.text.search(/\s/);
      if (ws === -1) { last.trail += seg.text; return; }
      last.trail += seg.text.slice(0, ws);
      pending = seg.text.slice(ws);
    });
    if (units.length) units.push({ space: pending, lead: '', word: null, trail: '' });
    return units;
  }

  // Story as <p> elements. Each word is a <span class="unit"> holding the punctuation attached to it
  // and a <span class="word"> (target words also get class "target").
  // onWordTap(fullyVocalizedWord) makes every word tappable.
  // mark: flag unvocalized words (teacher preview).
  // decorate(span, index): called for every word span, index = the word's index in the story (teacher preview).
  function story(lesson, onWordTap, mark, decorate) {
    var targets = targetsOf(lesson);
    var frag = document.createDocumentFragment();
    var index = 0;
    lesson.story.split(/\n+/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p');
      storyUnits(para).forEach(function (u) {
        if (u.space) p.appendChild(document.createTextNode(u.space));
        if (u.word === null) return;
        var isTarget = H.matchesAny(u.word, targets);
        var shown = H.displayText(u.word, lesson.nikudMode, targets);
        var span = el('span', { class: 'word' + (isTarget ? ' target' : '') +
          (mark && flagUnvocalized(lesson, u.word) ? ' no-nikud' : '') }, shown);
        if (onWordTap) {
          span.classList.add('tappable');
          span.addEventListener('click', function () { onWordTap(u.word); });
        }
        if (decorate) decorate(span, index);
        index++;
        p.appendChild(el('span', { class: 'unit' }, u.lead || null, span, u.trail || null));
      });
      frag.appendChild(p);
    });
    return frag;
  }

  var SENTENCE_END = /[.!?…]/;

  // The story as <p> elements of sentences (locate exercise): each sentence is a <span class="sent"> of words.
  // Returns {node, sentences: [{node, start, end}]}: start/end are word indices in the story (end excluded),
  // in the order Hebrew.tokenize finds words, the same as Lesson's sentence search.
  function storySentences(lesson) {
    var targets = targetsOf(lesson);
    var frag = document.createDocumentFragment();
    var sentences = [];
    var index = 0;
    lesson.story.split(/\n+/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p');
      var cur = null;
      storyUnits(para).forEach(function (u) {
        if (u.word === null) { if (u.space) (cur ? cur.node : p).appendChild(document.createTextNode(u.space)); return; }
        if (!cur) {
          if (u.space) p.appendChild(document.createTextNode(u.space));
          cur = { node: el('span', { class: 'sent', role: 'button', tabindex: '0' }), start: index, end: index };
          p.appendChild(cur.node);
        } else if (u.space) cur.node.appendChild(document.createTextNode(u.space));
        var isTarget = H.matchesAny(u.word, targets);
        cur.node.appendChild(el('span', { class: 'unit' }, u.lead || null,
          el('span', { class: 'word' + (isTarget ? ' target' : '') }, H.displayText(u.word, lesson.nikudMode, targets)),
          u.trail || null));
        index++;
        cur.end = index;
        if (SENTENCE_END.test(u.trail)) { sentences.push(cur); cur = null; }
      });
      if (cur) sentences.push(cur);
      frag.appendChild(p);
    });
    return { node: frag, sentences: sentences };
  }

  // Sentence with "___" replaced by a blank box (or by the filled word).
  function fillSentence(lesson, sentence, filled, mark) {
    var parts = sentence.split('___');
    var out = el('span');
    parts.forEach(function (part, i) {
      out.appendChild(mark ? markedText(lesson, part) : document.createTextNode(text(lesson, part)));
      if (i < parts.length - 1) {
        out.appendChild(el('span', { class: 'blank' + (filled ? ' filled' : '') }, filled ? text(lesson, filled) : '\u00A0'));
      }
    });
    return out;
  }

  window.Render = {
    targetsOf: targetsOf, text: text, markedText: markedText, storyUnits: storyUnits, story: story,
    storySentences: storySentences, fillSentence: fillSentence
  };
})();
