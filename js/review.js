/* Check step logic: AI text review (spelling/grammar) and nikud comparison with Dicta.
   Pure functions, no DOM. Exposes window.Review. */
(function () {
  'use strict';

  var H = window.Hebrew;

  /* ---------- Text slots ---------- */

  // Every editable text in the lesson, as {key, label, get, set}.
  // withTargets: include target words (nikud check only).
  function slots(lesson, withTargets) {
    var out = [];
    function add(key, label, obj, prop) {
      if (typeof obj[prop] !== 'string') return;
      out.push({
        key: key,
        label: label,
        get: function () { return obj[prop]; },
        set: function (v) { obj[prop] = H.normalize(v); }
      });
    }
    add('title', 'כותרת', lesson, 'title');
    if (withTargets) {
      lesson.targetWords.forEach(function (t, i) { add('targetWords[' + i + '].word', 'מילת יעד ' + (i + 1), t, 'word'); });
    }
    add('story', 'סיפור', lesson, 'story');
    lesson.exercises.forEach(function (ex, i) {
      if (ex.unknown) return;
      var base = 'exercises[' + i + ']';
      var name = 'תרגיל ' + (i + 1);
      add(base + '.question', name + ' – שאלה', ex, 'question');
      add(base + '.statement', name + ' – משפט', ex, 'statement');
      add(base + '.sentence', name + ' – משפט', ex, 'sentence');
      (ex.options || []).forEach(function (o, j) { add(base + '.options[' + j + ']', name + ' – אפשרות ' + (j + 1), ex.options, j); });
      (ex.sentences || []).forEach(function (s, j) { add(base + '.sentences[' + j + ']', name + ' – משפט ' + (j + 1), ex.sentences, j); });
      add(base + '.sampleAnswer', name + ' – תשובה לדוגמה', ex, 'sampleAnswer');
      // A "message" has two parts, each a multiple-choice or an open question.
      [['visible', 'מסר גלוי'], ['hidden', 'מסר סמוי']].forEach(function (k) {
        var part = ex[k[0]];
        if (!part) return;
        var pBase = base + '.' + k[0];
        var pName = name + ' – ' + k[1];
        add(pBase + '.question', pName + ', שאלה', part, 'question');
        (part.options || []).forEach(function (o, j) { add(pBase + '.options[' + j + ']', pName + ', אפשרות ' + (j + 1), part.options, j); });
        add(pBase + '.sampleAnswer', pName + ', תשובה לדוגמה', part, 'sampleAnswer');
      });
    });
    return out;
  }

  // Changes whenever any slot text changes.
  function signature(lesson) {
    return JSON.stringify(slots(lesson, true).map(function (s) { return s.get(); }));
  }

  /* ---------- 1. Text review ---------- */

  function buildReviewPrompt(lesson) {
    var texts = {};
    // Without nikud, so defective spelling stands out (ששי, בקר).
    slots(lesson, false).forEach(function (s) {
      var t = H.stripNikud(s.get()).trim();
      if (t) texts[s.key] = t;
    });
    // Lessons made before reading levels have none: then the general rule only.
    var level = window.Levels && window.Levels.get(lesson.level);
    var levelLines = level ? [
      '- רמת הקריאה של השיעור: ' + level.label + '. בדוק שהטקסט מתאים לרמה הזו:',
      '  - ' + level.sentence
    ].concat(level.language.map(function (l) { return '  - ' + l; }), [
      '  - בשאלות: ' + level.questions,
      '- משפט או מילה שלא מתאימים לרמה (ארוכים, קשים או פשוטים מדי): הצע תיקון מסוג style, ובשדה reason כתוב "לא מתאים לרמה" והסבר קצר.'
    ]) : ['- שמור על שפה פשוטה וקצרה שמתאימה לילדים.'];
    return [
      'אתה עורך לשון שבודק תוכן לימודי לילדים בעברית.',
      'בדוק את הטקסטים שלמטה (כותרת, סיפור ותרגילים): איות, דקדוק, ניסוח והתאמה לרמת הקריאה.',
      '',
      'הנחיות:',
      '- אל תשכתב את הסיפור כולו. הצע רק תיקונים נקודתיים: כל תיקון הוא מילה אחת או כמה מילים.'
    ].concat(levelLines, [
      '- הטקסטים נשלחים בלי ניקוד. אל תוסיף ניקוד, הוא נבדק בנפרד.',
      '- בדוק שכל מילה כתובה בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר). כל מילה בכתיב חסר היא הצעה מסוג error, עם reason "כתיב חסר".',
      '- בשדה field כתוב את שם השדה מהרשימה, למשל "story" או "exercises[2].question".',
      '- שדה sentence של תרגיל איתור מידע הוא משפט מתוך הסיפור, והוא חייב להישאר זהה לו. אם אתה מתקן משפט כזה, הצע את אותו תיקון גם בשדה story, ולהפך.',
      '- בתשובה לדוגמה (sampleAnswer) בדוק שהיא נכונה לפי הסיפור, קצרה, ומתאימה לשאלה.',
      '- בשדה original העתק את הקטע בדיוק כפי שהוא מופיע בטקסט.',
      '- בשדה fix כתוב את הקטע המתוקן, בלי ניקוד.',
      '- בשדה reason כתוב הסבר קצר בעברית.',
      '- בשדה type כתוב "error" אם זו שגיאה (איות או דקדוק), או "style" אם זו הצעת ניסוח או התאמה לרמה.',
      '- אם אין מה לתקן, החזר רשימה ריקה: [].',
      '',
      'החזר JSON בלבד בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, במבנה הזה:',
      '[',
      '  { "field": "story", "type": "error", "original": "הקטע המקורי", "fix": "הקטע המתוקן", "reason": "הסבר קצר" }',
      ']',
      '',
      'הטקסטים לבדיקה:',
      JSON.stringify(texts, null, 2)
    ]).join('\n');
  }

  function tryParse(s) {
    var attempts = [s, s.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/,\s*([}\]])/g, '$1')];
    for (var i = 0; i < attempts.length; i++) {
      try { return { value: JSON.parse(attempts[i]) }; } catch (e) { /* next */ }
    }
    return null;
  }

  // 'style' for wording suggestions; anything else (or missing) is treated as an error.
  function suggestionType(t) {
    return /^(style|ניסוח|הצעת ניסוח)$/i.test(String(t || '').trim()) ? 'style' : 'error';
  }

  // Returns {items: [{field, type, original, fix, reason}]} or {error}.
  function parseSuggestions(text) {
    var s = String(text || '').replace(/```(?:json|JSON)?/g, '');
    var list = null;
    var a = s.indexOf('[');
    var b = s.lastIndexOf(']');
    if (a !== -1 && b > a) {
      var r = tryParse(s.slice(a, b + 1));
      if (r && Array.isArray(r.value)) list = r.value;
    }
    if (!list) {
      var o = s.indexOf('{');
      var c = s.lastIndexOf('}');
      var r2 = o !== -1 && c > o ? tryParse(s.slice(o, c + 1)) : null;
      if (r2 && r2.value && typeof r2.value === 'object' && !Array.isArray(r2.value)) {
        // {"suggestions": [...]} or a single suggestion object.
        var arr = Object.keys(r2.value).map(function (k) { return r2.value[k]; }).filter(Array.isArray)[0];
        list = arr || (r2.value.original ? [r2.value] : null);
      }
    }
    if (!list) return { error: 'לא מצאתי בתשובה רשימת הצעות בפורמט JSON.' };
    var items = list.filter(function (x) { return x && typeof x === 'object'; }).map(function (x) {
      return {
        field: String(x.field || '').trim(),
        type: suggestionType(x.type),
        original: H.normalize(String(x.original || '')).trim(),
        fix: H.normalize(String(x.fix || '')).trim(),
        reason: String(x.reason || '').trim()
      };
    }).filter(function (x) { return x.original && x.original !== x.fix; });
    return { items: items };
  }

  var LETTER_RE = /[\p{L}\p{N}]/u;

  // Is stripped[k .. k+len) a whole word, or a word after a prefix (בַּבֹּקֶר for בקר)?
  function atWordBoundary(stripped, k, len) {
    if (k + len < stripped.length && LETTER_RE.test(stripped.charAt(k + len))) return false;
    var p = k;
    while (p > 0 && LETTER_RE.test(stripped.charAt(p - 1))) p--;
    return p === k || /^[ושהבכלמ]{1,3}$/.test(stripped.slice(p, k));
  }

  // Find `needle` in `text` as whole word(s), ignoring nikud (a prefix before it is allowed).
  // Prefers an occurrence whose nikud also matches. Returns {start, end} or null.
  function findLoose(text, needle) {
    text = H.normalize(text);
    needle = H.normalize(needle);
    var n = H.stripNikud(needle);
    if (!n) return null;

    var stripped = '';
    var map = [];
    for (var i = 0; i < text.length; i++) {
      if (H.hasNikud(text[i])) continue;
      stripped += text[i];
      map.push(i);
    }

    var first = null;
    for (var k = stripped.indexOf(n); k !== -1; k = stripped.indexOf(n, k + 1)) {
      if (!atWordBoundary(stripped, k, n.length)) continue;
      var start = map[k];
      var end = map[k + n.length - 1] + 1;
      while (end < text.length && H.hasNikud(text[end])) end++;
      var range = { start: start, end: end };
      if (text.slice(start, end) === needle) return range;
      if (!first) first = range;
    }
    return first;
  }

  // Where a suggestion applies now: its own field first, then any field. Returns {slot, start, end} or null.
  function locate(lesson, item) {
    var all = slots(lesson, false);
    var own = all.filter(function (s) { return s.key === item.field; });
    var order = own.concat(all.filter(function (s) { return s.key !== item.field; }));
    for (var i = 0; i < order.length; i++) {
      var r = findLoose(order[i].get(), item.original);
      if (r) return { slot: order[i], start: r.start, end: r.end };
    }
    return null;
  }

  // Apply a suggestion. Returns false if the original text is no longer there.
  function applySuggestion(lesson, item) {
    var loc = locate(lesson, item);
    if (!loc) return false;
    var t = H.normalize(loc.slot.get());
    loc.slot.set(t.slice(0, loc.start) + item.fix + t.slice(loc.end));
    return true;
  }

  /* ---------- Defective spelling (ktiv haser) ---------- */

  var HOLAM = String.fromCharCode(0x05B9);
  var QUBUTS = String.fromCharCode(0x05BB);
  // Words spelled with holam haser even in ktiv male (holam before א, as in לֹא, is allowed by the rule itself).
  var HASER_OK = ['פה', 'כה', 'איפה', 'משה'];

  function isHaserException(word) {
    var b = H.bare(word);
    return HASER_OK.some(function (w) {
      return b === w || (b.length > w.length && b.slice(-w.length) === w && /^[ושהבכלמ]{1,3}$/.test(b.slice(0, b.length - w.length)));
    });
  }

  // A holam or qubuts on a letter other than ו with no ו or א after it: בֹּקֶר, שֻׁלְחָן, אֹכֶל (but not רֹאשׁ).
  function looksHaser(word) {
    var letters = H.graphemes(word).filter(function (c) { return /\p{L}/u.test(c.charAt(0)); });
    for (var i = 0; i < letters.length; i++) {
      var c = letters[i];
      var letter = c.charAt(0);
      if (letter === 'ו' || (c.indexOf(HOLAM) === -1 && c.indexOf(QUBUTS) === -1)) continue;
      var next = letters[i + 1];
      if (next && (next.charAt(0) === 'ו' || next.charAt(0) === 'א')) continue;
      return true;
    }
    return false;
  }

  // Distinct words in the lesson that may be in defective spelling.
  function haserWords(lesson) {
    var seen = {};
    var out = [];
    slots(lesson, true).forEach(function (s) {
      words(s.get()).forEach(function (w) {
        if (seen[w] || !looksHaser(w) || isHaserException(w)) return;
        seen[w] = true;
        out.push(w);
      });
    });
    return out;
  }

  /* ---------- 2. Nikud check against Dicta ---------- */

  // All lesson text without nikud, one field per line (the story keeps its paragraphs).
  function plainText(lesson) {
    return slots(lesson, true)
      .map(function (s) { return H.stripNikud(s.get()).trim(); })
      .filter(Boolean)
      .join('\n');
  }

  function words(text) {
    return H.tokenize(text).filter(function (t) { return t.isWord; }).map(function (t) { return t.text; });
  }

  // Meteg and cantillation differences are not worth the teacher's attention.
  var IGNORE_RE = /[\u0591-\u05AF\u05BD]/g;
  function sameNikud(a, b) {
    return H.normalize(a).replace(IGNORE_RE, '') === H.normalize(b).replace(IGNORE_RE, '');
  }

  // Letters without matres lectionis: ktiv male (דיקטה) and ktiv haser (הבינה) compare equal.
  function looseLetters(w) {
    return H.bare(w).replace(/[וי]/g, '');
  }

  // Does any lesson text have nikud? A lesson straight from the AI has none.
  function hasAnyNikud(lesson) {
    return slots(lesson, true).some(function (s) { return H.hasNikud(s.get()); });
  }

  // Lines up the lesson words with the text pasted from Dicta.
  // Words without nikud just take Dicta's word (same letters required): fills.
  // Vocalized words that differ are left for the teacher to choose: diffs.
  // Returns {error, details} or {fills: [{slot, index, word}],
  // diffs: [{slot, index, ai, dicta, spelling, before, after, choice}]}.
  // spelling: the words differ only in ו/י (ktiv male vs. haser).
  function compareNikud(lesson, pasted) {
    var ours = [];
    slots(lesson, true).forEach(function (slot) {
      words(slot.get()).forEach(function (w, index) { ours.push({ slot: slot, index: index, text: w }); });
    });
    var theirs = words(pasted);

    if (!theirs.length) return { error: 'לא הודבק טקסט.', details: [] };
    if (ours.length !== theirs.length) {
      var details = [];
      var ourLines = plainText(lesson).split('\n').filter(function (l) { return l.trim(); });
      var theirLines = String(pasted).split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (ourLines.length === theirLines.length) {
        for (var i = 0; i < ourLines.length; i++) {
          if (words(ourLines[i]).length !== words(theirLines[i]).length) {
            details.push('ההבדל הראשון בשורה ' + (i + 1) + ':');
            details.push('בטקסט ששלחנו: ' + ourLines[i]);
            details.push('בטקסט שהודבק: ' + theirLines[i]);
            break;
          }
        }
      } else {
        details.push('גם מספר השורות שונה: ' + ourLines.length + ' בטקסט ששלחנו, ' + theirLines.length + ' בטקסט שהודבק.');
      }
      return {
        error: 'מספר המילים לא תואם: בטקסט ששלחנו יש ' + ours.length + ' מילים, ובטקסט שהודבק ' + theirs.length + '. ' +
          'ודאו שהעתקתם את כל הטקסט מדיקטה, ושהטקסט לא השתנה מאז שהעתקתם אותו.',
        details: details
      };
    }

    var letterDiffs = [];
    ours.forEach(function (o, i) {
      // Our unvocalized words must match exactly; vocalized ones may be in ktiv haser.
      var same = H.hasNikud(o.text) ? looseLetters(o.text) === looseLetters(theirs[i]) : H.bare(o.text) === H.bare(theirs[i]);
      if (!same) letterDiffs.push('"' + H.stripNikud(o.text) + '" מול "' + H.stripNikud(theirs[i]) + '"');
    });
    if (letterDiffs.length) {
      return {
        error: 'הטקסט שהודבק שונה באותיות מהטקסט ששלחנו (' + letterDiffs.length + ' מילים). ' +
          'ודאו שהדבקתם בדיקטה בדיוק את הטקסט שהעתקתם מכאן.',
        details: letterDiffs.slice(0, 5)
      };
    }

    var fills = [];
    var diffs = [];
    ours.forEach(function (o, i) {
      if (!H.hasNikud(o.text)) {
        if (H.hasNikud(theirs[i])) fills.push({ slot: o.slot, index: o.index, word: H.normalize(theirs[i]) });
        return;
      }
      var spelling = H.bare(o.text) !== H.bare(theirs[i]);
      if (!spelling && sameNikud(o.text, theirs[i])) return;
      var slotWords = words(o.slot.get());
      diffs.push({
        slot: o.slot,
        index: o.index,
        ai: o.text,
        dicta: H.normalize(theirs[i]),
        spelling: spelling,
        before: slotWords.slice(Math.max(0, o.index - 3), o.index).join(' '),
        after: slotWords.slice(o.index + 1, o.index + 4).join(' '),
        choice: 'ai'
      });
    });
    return { fills: fills, diffs: diffs };
  }

  // Replace words of one slot: byIndex maps word index → new word (each a single word).
  function setWords(slot, byIndex) {
    for (var key in byIndex) if (words(byIndex[key]).length !== 1) return false;
    var k = -1;
    slot.set(H.tokenize(slot.get()).map(function (seg) {
      if (!seg.isWord) return seg.text;
      k++;
      return byIndex.hasOwnProperty(k) ? byIndex[k] : seg.text;
    }).join(''));
    return true;
  }

  // Replace the index-th word of a slot. The new word must be a single word.
  function setWord(slot, index, word) {
    var byIndex = {};
    byIndex[index] = word;
    return setWords(slot, byIndex);
  }

  // Apply compareNikud fills, one pass per slot. Returns the number of words replaced.
  function applyFills(fills) {
    var groups = {};
    var order = [];
    fills.forEach(function (f) {
      if (!groups[f.slot.key]) { groups[f.slot.key] = { slot: f.slot, byIndex: {} }; order.push(f.slot.key); }
      groups[f.slot.key].byIndex[f.index] = f.word;
    });
    var n = 0;
    order.forEach(function (key) {
      var g = groups[key];
      if (setWords(g.slot, g.byIndex)) n += Object.keys(g.byIndex).length;
    });
    return n;
  }

  window.Review = {
    slots: slots,
    signature: signature,
    buildReviewPrompt: buildReviewPrompt,
    parseSuggestions: parseSuggestions,
    findLoose: findLoose,
    locate: locate,
    applySuggestion: applySuggestion,
    plainText: plainText,
    hasAnyNikud: hasAnyNikud,
    compareNikud: compareNikud,
    applyFills: applyFills,
    haserWords: haserWords,
    setWord: setWord
  };
})();
