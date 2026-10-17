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

  // Story as <p> elements; target words wrapped in <span class="target">.
  // onWordTap(fullyVocalizedWord) makes every word tappable.
  function story(lesson, onWordTap) {
    var targets = targetsOf(lesson);
    var frag = document.createDocumentFragment();
    lesson.story.split(/\n+/).forEach(function (para) {
      if (!para.trim()) return;
      var p = el('p');
      H.tokenize(para).forEach(function (seg) {
        if (!seg.isWord) { p.appendChild(document.createTextNode(seg.text)); return; }
        var isTarget = H.matchesAny(seg.text, targets);
        var shown = H.displayText(seg.text, lesson.nikudMode, targets);
        var span = el('span', { class: 'word' + (isTarget ? ' target' : '') }, shown);
        if (onWordTap) {
          span.classList.add('tappable');
          span.addEventListener('click', function () { onWordTap(seg.text); });
        }
        p.appendChild(span);
      });
      frag.appendChild(p);
    });
    return frag;
  }

  // Sentence with "___" replaced by a blank box (or by the filled word).
  function fillSentence(lesson, sentence, filled) {
    var parts = sentence.split('___');
    var out = el('span');
    parts.forEach(function (part, i) {
      out.appendChild(document.createTextNode(text(lesson, part)));
      if (i < parts.length - 1) {
        out.appendChild(el('span', { class: 'blank' + (filled ? ' filled' : '') }, filled ? text(lesson, filled) : '\u00A0'));
      }
    });
    return out;
  }

  window.Render = { targetsOf: targetsOf, text: text, story: story, fillSentence: fillSentence };
})();
