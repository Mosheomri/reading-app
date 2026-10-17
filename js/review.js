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
    slots(lesson, false).forEach(function (s) { if (s.get()) texts[s.key] = s.get(); });
    return [
      'אתה עורך לשון שבודק תוכן לימודי לילדים בעברית.',
      'בדוק את הטקסטים שלמטה (כותרת, סיפור ותרגילים): איות, דקדוק וניסוח.',
      '',
      'הנחיות:',
      '- אל תשכתב את הסיפור כולו. הצע רק תיקונים נקודתיים: כל תיקון הוא מילה אחת או כמה מילים.',
      '- שמור על שפה פשוטה וקצרה שמתאימה לילדים.',
      '- אין צורך לבדוק ניקוד, הוא נבדק בנפרד.',
      '- בשדה field כתוב את שם השדה מהרשימה, למשל "story" או "exercises[2].question".',
      '- בשדה original העתק את הקטע בדיוק כפי שהוא מופיע בטקסט, כולל הניקוד.',
      '- בשדה fix כתוב את הקטע המתוקן, בניקוד מלא.',
      '- בשדה reason כתוב הסבר קצר בעברית.',
      '- בשדה type כתוב "error" אם זו שגיאה (איות או דקדוק), או "style" אם זו הצעת ניסוח.',
      '- אם אין מה לתקן, החזר רשימה ריקה: [].',
      '',
      'החזר JSON בלבד בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, במבנה הזה:',
      '[',
      '  { "field": "story", "type": "error", "original": "הקטע המקורי", "fix": "הקטע המתוקן", "reason": "הסבר קצר" }',
      ']',
      '',
      'הטקסטים לבדיקה:',
      JSON.stringify(texts, null, 2)
    ].join('\n');
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

  // Find `needle` in `text`: exactly, or else ignoring nikud. Returns {start, end} or null.
  function findLoose(text, needle) {
    text = H.normalize(text);
    needle = H.normalize(needle);
    if (!needle) return null;
    var idx = text.indexOf(needle);
    if (idx !== -1) return { start: idx, end: idx + needle.length };

    var stripped = '';
    var map = [];
    for (var i = 0; i < text.length; i++) {
      if (H.hasNikud(text[i])) continue;
      stripped += text[i];
      map.push(i);
    }
    var n = H.stripNikud(needle);
    if (!n) return null;
    var k = stripped.indexOf(n);
    if (k === -1) return null;
    var start = map[k];
    var end = map[k + n.length - 1] + 1;
    while (end < text.length && H.hasNikud(text[end])) end++;
    return { start: start, end: end };
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

  // Returns {error, details} or {diffs: [{slot, index, ai, dicta, spelling, before, after, choice}]}.
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
      if (looseLetters(o.text) !== looseLetters(theirs[i])) letterDiffs.push('"' + H.stripNikud(o.text) + '" מול "' + H.stripNikud(theirs[i]) + '"');
    });
    if (letterDiffs.length) {
      return {
        error: 'הטקסט שהודבק שונה באותיות מהטקסט ששלחנו (' + letterDiffs.length + ' מילים). ' +
          'ודאו שהדבקתם בדיקטה בדיוק את הטקסט שהעתקתם מכאן.',
        details: letterDiffs.slice(0, 5)
      };
    }

    var diffs = [];
    ours.forEach(function (o, i) {
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
    return { diffs: diffs };
  }

  // Replace the index-th word of a slot. The new word must be a single word.
  function setWord(slot, index, word) {
    if (words(word).length !== 1) return false;
    var k = -1;
    slot.set(H.tokenize(slot.get()).map(function (seg) {
      if (!seg.isWord) return seg.text;
      k++;
      return k === index ? word : seg.text;
    }).join(''));
    return true;
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
    compareNikud: compareNikud,
    setWord: setWord
  };
})();
