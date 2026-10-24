/* Check step logic: AI text review (spelling/grammar), nikud comparison with Dicta, and the second opinion
   on Dicta's nikud from Gemini.
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
    var genre = lesson.genre === 'info' ? 'info' : 'story';
    var levelLines = level ? [
      '- רמת הקריאה של השיעור: ' + level.label + '. בדוק שהטקסט מתאים לרמה הזו:',
      '  - ' + level.sentence
    ].concat(window.Levels.textLines(level, genre).map(function (l) { return '  - ' + l; }),
      level.avoid.map(function (l) { return '  - לא מתאים לרמה: ' + l; }), [
      '  - בשאלות: ' + level.questions,
      '- משפט או מילה שלא מתאימים לרמה (ארוכים, קשים או פשוטים מדי): הצע תיקון מסוג style, ובשדה reason כתוב "לא מתאים לרמה" והסבר קצר.'
    ]) : ['- שמור על שפה פשוטה וקצרה שמתאימה לילדים.'];
    var targets = lesson.targetWords.map(function (t) { return H.stripNikud(t.word); }).filter(Boolean);
    return [
      'אתה עורך לשון ועורך ספרי ילדים, שבודק תוכן לימודי לילדים בעברית.',
      'בדוק את הטקסטים שלמטה (כותרת, ' + (genre === 'info' ? 'טקסט' : 'סיפור') + ' ותרגילים): איות, דקדוק, ניסוח, איכות הכתיבה והתאמה לרמת הקריאה.',
      'הטקסט צריך להיראות כאילו סופר מקצועי לילדים כתב אותו.',
      '',
      'הנחיות:',
      '- אל תשכתב את הסיפור כולו. הצע רק תיקונים נקודתיים: כל תיקון הוא מילה, כמה מילים, או משפט אחד או שניים לכל היותר.',
      '- סוג הטקסט: ' + (genre === 'info' ? 'טקסט מידעי (נושא אחד, פתיחה, פסקה לכל תת-נושא, סיכום; בלי עלילה ובלי דמויות בדיוניות)'
        : 'סיפור (דמות מרכזית, רצון או בעיה, ניסיונות, שיא ופתרון)') + '.'
    ].concat(levelLines, [
      '',
      'בדיקות עריכה. כל ממצא הוא הצעה עם תיקון והסבר בשדה reason: מסוג error אם זו טעות של ממש (סתירה, מילה במשמעות שגויה), ומסוג style אם זה שיפור ניסוח:',
      '- רצף ומילות קישור: משפטים קצרים ונפרדים שנשמעים כמו רשימה. הצע לחבר אותם (ו, אבל, כי, אז, פתאום, כש-, ש-).',
      '- משפטי מילוי שלא מקדמים את הטקסט: הצע לאחד אותם עם המשפט שלפניהם או אחריהם (original: שני המשפטים, fix: הנוסח המאוחד).',
      '- היגיון ועקביות: בעלילה, בזמן (עבר והווה), במקום ובמה שהדמויות יודעות ועושות. סתירה היא error.',
      '- ז׳רגון (של ספורט, מדע וכו׳) ושפה ספרותית גבוהה מדי לרמה: הצע מילים פשוטות.',
      '- צירופים לא טבעיים, שנשמעים כמו תרגום: הצע את הניסוח שילד ישראלי היה שומע בספר.',
      '- מילות יעד (' + targets.join(', ') + '): מילה שמופיעה במשמעות שגויה היא error; מילה שמופיעה במקום מאולץ היא style. ' +
        'בתיקון, השאר את מילת היעד בטקסט.',
      '- ערבוב סוגי טקסט: ' + (genre === 'info' ? 'עלילה או דמויות בדיוניות בתוך טקסט מידעי' : 'פסקה של מידע או הסבר בתוך סיפור') +
        '. הצע ניסוח שמתאים לסוג הטקסט.',
      '',
      'הנחיות לתשובה:',
      '- הטקסטים נשלחים בלי ניקוד. אל תוסיף ניקוד, הוא נבדק בנפרד.',
      '- בדוק שכל מילה כתובה בכתיב מלא תקני, כמו בטקסט רגיל בלי ניקוד (למשל שישי ולא ששי, בוקר ולא בקר). כל מילה בכתיב חסר היא הצעה מסוג error, עם reason "כתיב חסר".',
      '- בשדה field כתוב את שם השדה מהרשימה, למשל "story" או "exercises[2].question".',
      '- שדה sentence של תרגיל איתור מידע הוא משפט מתוך הסיפור, והוא חייב להישאר זהה לו. אם אתה מתקן משפט כזה, הצע את אותו תיקון גם בשדה story, ולהפך.',
      '- בתשובה לדוגמה (sampleAnswer) בדוק שהיא נכונה לפי הסיפור, קצרה, ומתאימה לשאלה.',
      '- בדוק שכל משפט הגיוני וברור מבחינת המשמעות. משפט לא הגיוני או מוזר (למשל "אנשים שמחים ועצובים בתוך ארבעה קירות ביתם"): הצע ניסוח ברור והגיוני, מסוג style, ובשדה reason הסבר מה לא הגיוני או מוזר בו.',
      '- בשדה original העתק את הקטע בדיוק כפי שהוא מופיע בטקסט.',
      '- בשדה fix כתוב את הקטע המתוקן, בלי ניקוד.',
      '- בשדה reason כתוב הסבר קצר בעברית.',
      '- בשדה type כתוב "error" אם זו שגיאה (איות, דקדוק, סתירה או מילה במשמעות שגויה), או "style" אם זו הצעת ניסוח, עריכה או התאמה לרמה.',
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

  /* ---------- 3. Second opinion on the nikud (Gemini, automatic mode only) ---------- */

  // The lines sent to Dicta (plainText), each with its words' places in the lesson:
  // [{text (without nikud), vocal (as it is now), refs: [{key, index}]}].
  // A slot's lines are split at its newlines (the story keeps its paragraphs), empty lines left out, as in plainText.
  function nikudLines(lesson) {
    var out = [];
    slots(lesson, true).forEach(function (slot) {
      var k = 0;
      slot.get().split('\n').forEach(function (line) {
        var ws = words(line);
        var plain = H.stripNikud(line).trim();
        if (plain && ws.length) {
          out.push({ text: plain, vocal: H.normalize(line).trim(), refs: ws.map(function (w, j) { return { key: slot.key, index: k + j }; }) });
        }
        k += ws.length;
      });
    });
    return out;
  }

  // Groups of lines for one call each, up to maxChars of text per group (a longer line is a group of its own).
  function nikudChunks(lines, maxChars) {
    var out = [];
    var cur = null;
    lines.forEach(function (l) {
      if (!cur || (cur.chars && cur.chars + l.text.length > maxChars)) { cur = { lines: [], chars: 0 }; out.push(cur); }
      cur.lines.push(l);
      cur.chars += l.text.length;
    });
    return out.map(function (c) { return c.lines; });
  }

  var NIKUD_INTRO = [
    'אתה מנקד טקסט בעברית לילדים שלומדים לקרוא.',
    'הוסף ניקוד מלא לכל מילה בכל אחת מהשורות שלמטה, לפי ההקשר, בכתיב מלא (כמו הנקדן של דיקטה בסגנון מודרני).',
    '',
    'הנחיות:',
    '- הוסף רק סימני ניקוד. אל תשנה אף אות, אף סימן פיסוק, אף רווח ואף מילה. אל תוסיף ואל תמחק מילים.',
    '- בלי טעמים ובלי מתג.'
  ];

  // For Gemini (structured output): the lines as a JSON array, back in the field lines.
  function buildNikudPrompt(texts) {
    return NIKUD_INTRO.concat([
      '- החזר את השורות באותו סדר, שורה מנוקדת אחת לכל שורה שקיבלת: ' + texts.length + ' שורות בדיוק, בשדה lines.',
      '',
      'השורות:',
      JSON.stringify(texts, null, 2)
    ]).join('\n');
  }

  // For any chat (the manual second opinion): the lines in a code block, back the same way.
  function buildManualNikudPrompt(texts) {
    return NIKUD_INTRO.concat([
      '- החזר את השורות באותו סדר: ' + texts.length + ' שורות בדיוק, שורה מנוקדת אחת לכל שורה שקיבלת, בלי מספור ובלי שורות ריקות.',
      '- החזר את כל השורות בתוך בלוק קוד אחד (```), בלי שום טקסט לפניו או אחריו.',
      '',
      'השורות:',
      '```',
      texts.join('\n'),
      '```'
    ]).join('\n');
  }

  // The lines of a chat's answer to buildManualNikudPrompt: the first code block (or the whole text), one line per
  // line, empty lines left out. A JSON array (or {lines: [...]}) is accepted too, and numbering on every line is dropped.
  function parseManualNikud(text) {
    var t = String(text || '').replace(/\r\n?/g, '\n');
    var block = t.match(/```[^\n]*\n([\s\S]*?)```/);
    var body = (block ? block[1] : t.replace(/```[^\n]*/g, '')).trim();
    try {
      var data = JSON.parse(body);
      var arr = Array.isArray(data) ? data : data && Array.isArray(data.lines) ? data.lines : null;
      if (arr && arr.every(function (x) { return typeof x === 'string'; })) return arr.map(function (x) { return H.normalize(x).trim(); });
    } catch (e) { /* plain lines */ }
    var lines = body.split('\n').map(function (l) { return H.normalize(l).trim(); }).filter(Boolean);
    var numbered = /^\d+[.)]\s+/;
    if (lines.length > 1 && lines.every(function (l) { return numbered.test(l); })) lines = lines.map(function (l) { return l.replace(numbered, ''); });
    return lines;
  }

  function bareLine(text) {
    return words(H.stripNikud(text)).map(H.bare).join(' ');
  }

  // Lines back from a chat against the lines sent ([{text}]): {error, details} when the number of lines differs,
  // else {bad: [indices of lines whose letters or words differ]}. details: the first line that differs.
  function checkManualNikud(sent, got) {
    var first = -1;
    for (var i = 0; i < Math.min(sent.length, got.length); i++) {
      if (bareLine(sent[i].text) !== bareLine(got[i])) { first = i; break; }
    }
    var at = first === -1 ? Math.min(sent.length, got.length) : first;
    var details = ['ההבדל הראשון בשורה ' + (at + 1) + ':',
      'בטקסט ששלחנו: ' + (sent[at] ? sent[at].text : '(אין שורה כזו)'),
      'בתשובה: ' + (got[at] != null ? H.stripNikud(got[at]) : '(אין שורה כזו)')];
    if (got.length !== sent.length) {
      return { error: 'מספר השורות לא תואם: שלחנו ' + sent.length + ' שורות, ובתשובה ' + got.length + '.', details: details };
    }
    var bad = [];
    sent.forEach(function (l, j) { if (bareLine(l.text) !== bareLine(got[j])) bad.push(j); });
    return { bad: bad, details: bad.length ? details : [] };
  }

  // How a reader says the word: one {c, v} per letter. c: the consonant ('' when the letter is silent: a ו or
  // a י that only carries the vowel of the letter before); v: the vowel sound. Only what changes the reading
  // counts: dagesh only in ב כ פ (b/v, k/kh, p/f) and in ו (shuruk); shin / sin dot; vowels by their sound in
  // modern Hebrew (patah = qamats = hataf patah, tsere = segol = hataf segol, holam on the letter or on the ו,
  // qamats qatan = qamats: the same sign on the page). Sheva is 'ə': read as nothing or as e.
  var VOWEL_SOUND = { '\u05B0': 'ə', '\u05B1': 'e', '\u05B2': 'a', '\u05B3': 'o', '\u05B4': 'i', '\u05B5': 'e', '\u05B6': 'e',
    '\u05B7': 'a', '\u05B8': 'a', '\u05C7': 'a', '\u05B9': 'o', '\u05BA': 'o', '\u05BB': 'u' };
  var FINAL_FORM = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  var DAGESH = '\u05BC';

  function clustersOf(word) {
    return H.graphemes(word).filter(function (c) { return /[\p{L}\p{N}]/u.test(c.charAt(0)); });
  }

  function vowelOf(marks) {
    var v = '';
    for (var i = 0; i < marks.length; i++) if (VOWEL_SOUND[marks[i]]) v = VOWEL_SOUND[marks[i]];
    return v;
  }

  function pronunciation(word) {
    var out = [];
    clustersOf(word).forEach(function (cl) {
      var letter = FINAL_FORM[cl.charAt(0)] || cl.charAt(0);
      var marks = cl.slice(1).replace(/[^\p{M}]/gu, '').replace(/[\u0591-\u05AF\u05BD\u05BF]/g, ''); // no meteg, cantillation, rafe
      var dagesh = marks.indexOf(DAGESH) !== -1;
      var v = vowelOf(marks);
      var prev = out[out.length - 1];
      if (letter === 'ו') {
        // holam male (וֹ) or shuruk (וּ): the vowel of the letter before; a bare ו after o / u carries it too
        var u = dagesh && !v;
        if ((v === 'o' && marks.replace(/[\u05B9\u05BA]/g, '') === '') || u) {
          if (prev && !prev.v) { prev.v = u ? 'u' : 'o'; out.push({ c: '', v: '' }); } else out.push({ c: '', v: u ? 'u' : 'o' });
          return;
        }
        if (!marks && prev && (prev.v === 'o' || prev.v === 'u')) { out.push({ c: '', v: '' }); return; }
        out.push({ c: 'ו', v: v });
        return;
      }
      if (letter === 'י' && !marks && prev && (prev.v === 'i' || prev.v === 'e')) { out.push({ c: '', v: '' }); return; }
      var c = letter;
      if ('בכפ'.indexOf(letter) !== -1) c = letter + (dagesh ? '!' : '');
      else if (letter === 'ש') c = marks.indexOf('\u05C1') !== -1 ? 'ש' : marks.indexOf('\u05C2') !== -1 ? 'ס' : 'ש?';
      out.push({ c: c, v: v });
    });
    return out;
  }

  function sameVowel(a, b) {
    if (a === b) return true;
    return (a === 'ə' && (b === '' || b === 'e')) || (b === 'ə' && (a === '' || a === 'e'));
  }

  // Do two vocalizations of the same letters read the same? (A ש without a dot fits shin and sin.)
  function sameReading(a, b) {
    var pa = pronunciation(a);
    var pb = pronunciation(b);
    if (pa.length !== pb.length) return false;
    for (var i = 0; i < pa.length; i++) {
      var ca = pa[i].c, cb = pb[i].c;
      if (ca !== cb && !(ca === 'ש?' && (cb === 'ש' || cb === 'ס')) && !(cb === 'ש?' && (ca === 'ש' || ca === 'ס'))) return false;
      if (!sameVowel(pa[i].v, pb[i].v)) return false;
    }
    return true;
  }

  /* Kinds of difference between two vocalizations of the same letters (for the report on the second opinion). */
  var SHEVA = '\u05B0';
  var HATAF = /[\u05B1-\u05B3]/;
  var A_CLASS = /[\u05B2\u05B7\u05B8\u05C7]/;
  var E_CLASS = /[\u05B1\u05B5\u05B6]/;
  var O_SIGNS = /[\u05B9\u05BA]/;
  var VOWEL_RE = /[\u05B0-\u05BB\u05C7]/g;
  var TEAMIM_RE = /[\u0591-\u05AF\u05BD\u05BF]/g;

  function diffKinds(a, b) {
    var ca = clustersOf(a), cb = clustersOf(b);
    var kinds = {};
    if (ca.length !== cb.length) return ['אותיות שונות'];
    for (var i = 0; i < ca.length; i++) {
      var letter = ca[i].charAt(0);
      var ma = ca[i].slice(1), mb = cb[i].slice(1);
      if ((ma.match(TEAMIM_RE) || []).sort().join('') !== (mb.match(TEAMIM_RE) || []).sort().join('')) kinds['מתג / טעמים'] = 1;
      var da = ma.indexOf(DAGESH) !== -1, db = mb.indexOf(DAGESH) !== -1;
      if (da !== db) {
        kinds[letter === 'ו' ? 'חולם / שורוק' : 'בכפךף'.indexOf(letter) !== -1 ? 'דגש בבכ״פ' : 'דגש (באות אחרת)'] = 1;
      }
      if (letter === 'ש' && (ma.indexOf('\u05C1') !== -1) !== (mb.indexOf('\u05C1') !== -1)) kinds['שי״ן / שׂי״ן'] = 1;
      var va = (ma.match(VOWEL_RE) || []).join(''), vb = (mb.match(VOWEL_RE) || []).join('');
      if (va === vb) continue;
      var both = va + vb;
      if (O_SIGNS.test(both) || letter === 'ו' || (cb[i + 1] && cb[i + 1].charAt(0) === 'ו')) kinds['חולם / שורוק'] = 1;
      else if ((va === SHEVA && HATAF.test(vb)) || (vb === SHEVA && HATAF.test(va))) kinds['שווא / חטף'] = 1;
      else if ((va === SHEVA && !vb) || (vb === SHEVA && !va)) kinds['שווא / בלי סימן'] = 1;
      else if (/\u05C7/.test(both)) kinds['קמץ קטן'] = 1;
      else if (A_CLASS.test(va) && A_CLASS.test(vb)) kinds['פתח / קמץ'] = 1;
      else if (E_CLASS.test(va) && E_CLASS.test(vb)) kinds['צירה / סגול'] = 1;
      else if (!va || !vb) kinds['תנועה חסרה'] = 1;
      else if (va === SHEVA || vb === SHEVA) kinds['שווא / תנועה'] = 1;
      else kinds['תנועה אחרת'] = 1;
    }
    return Object.keys(kinds);
  }

  // Compares the lesson's words (Dicta's nikud, as they are now) with Gemini's vocalized lines.
  // sent: the lines sent (nikudLines); got: Gemini's lines, in the same order.
  // Words whose letters differ at Gemini's (or that changed here meanwhile), Gemini words with no nikud,
  // and words the child sees without nikud (partial mode) are not compared.
  // Only differences in the reading are marked (sameReading); every difference is listed in diffs, with its kinds.
  // Returns {marks: [{key, index, word, dicta, gemini}], diffs: [{key, index, dicta, gemini, kinds, reading}],
  // compared, skippedLines}.
  function compareSecond(lesson, sent, got) {
    var byKey = {};
    slots(lesson, true).forEach(function (s) { byKey[s.key] = words(s.get()); });
    var targets = lesson.targetWords.map(function (t) { return t.word; });
    var marks = [];
    var diffs = [];
    var compared = 0;
    var skippedLines = 0;
    sent.forEach(function (line, i) {
      var theirs = words(String(got[i] == null ? '' : got[i]));
      if (theirs.length !== line.refs.length) { skippedLines++; return; }
      line.refs.forEach(function (ref, j) {
        var ours = (byKey[ref.key] || [])[ref.index];
        var gem = H.normalize(theirs[j]);
        if (!ours || H.bare(ours) !== H.bare(gem) || !H.hasNikud(gem) || !H.hasNikud(ours)) return;
        if (!H.hasNikud(H.displayText(ours, lesson.nikudMode, targets))) return;
        compared++;
        if (H.normalize(ours) === gem) return;
        var reading = !sameReading(ours, gem);
        diffs.push({ key: ref.key, index: ref.index, dicta: ours, gemini: gem, kinds: diffKinds(ours, gem), reading: reading });
        if (reading) marks.push({ key: ref.key, index: ref.index, word: ours, dicta: ours, gemini: gem });
      });
    });
    return { marks: marks, diffs: diffs, compared: compared, skippedLines: skippedLines };
  }

  /* ---------- Nikud after Dicta: only the lines that need it ---------- */

  function hasUnvocalized(text) {
    return words(text).some(function (w) { return H.isUnvocalized(w); });
  }

  // The lines that go to Dicta again after a first run: lines that changed since then (snapshot: the vocalized
  // lines as Dicta's nikud left them, see nikudLines().vocal), and lines with Hebrew words that have no nikud
  // (text that came in later, or words Dicta left without nikud). Without a snapshot: the second kind only.
  function linesToNikud(lesson, snapshot) {
    var left = null;
    if (snapshot) {
      left = {};
      snapshot.forEach(function (v) { left[v] = (left[v] || 0) + 1; });
    }
    return nikudLines(lesson).filter(function (l) {
      if (left && left[l.vocal]) { left[l.vocal]--; return hasUnvocalized(l.vocal); }
      return left ? true : hasUnvocalized(l.vocal);
    });
  }

  // Dicta's answer for some lines (pasted, or from the bridge), word by word, as compareNikud does for the whole
  // text: words without nikud take Dicta's word (same letters required); vocalized words that differ are listed
  // for the teacher's choice. Returns {fills: [{slot, index, word}], diffs: [...as compareNikud]} or {error, details}.
  function lineFills(lesson, lines, pasted) {
    var bySlot = {};
    slots(lesson, true).forEach(function (s) { bySlot[s.key] = { slot: s, words: words(s.get()) }; });
    var ours = [];
    lines.forEach(function (l) { l.refs.forEach(function (r) { ours.push(r); }); });
    var theirs = words(pasted);
    if (ours.length !== theirs.length) {
      return {
        error: 'מספר המילים לא תואם: בשורות ששלחנו יש ' + ours.length + ' מילים, ובטקסט מדיקטה ' + theirs.length + '.',
        details: ['ודאו שניקדתם בדיקטה בדיוק את השורות שהועתקו מכאן.']
      };
    }
    var fills = [];
    var diffs = [];
    var bad = [];
    ours.forEach(function (r, i) {
      var s = bySlot[r.key];
      var w = s && s.words[r.index];
      var vocal = w && H.hasNikud(w);
      var same = w && (vocal ? looseLetters(w) === looseLetters(theirs[i]) : H.bare(w) === H.bare(theirs[i]));
      if (!same) { bad.push('"' + H.stripNikud(w || '') + '" מול "' + H.stripNikud(theirs[i]) + '"'); return; }
      if (!vocal) {
        if (H.hasNikud(theirs[i])) fills.push({ slot: s.slot, index: r.index, word: H.normalize(theirs[i]) });
        return;
      }
      var spelling = H.bare(w) !== H.bare(theirs[i]);
      if (!spelling && sameNikud(w, theirs[i])) return;
      diffs.push({
        slot: s.slot, index: r.index, ai: w, dicta: H.normalize(theirs[i]), spelling: spelling,
        before: s.words.slice(Math.max(0, r.index - 3), r.index).join(' '),
        after: s.words.slice(r.index + 1, r.index + 4).join(' '),
        choice: 'ai'
      });
    });
    if (bad.length) {
      return { error: 'הטקסט מדיקטה שונה באותיות מהשורות ששלחנו (' + bad.length + ' מילים).', details: bad.slice(0, 5) };
    }
    return { fills: fills, diffs: diffs };
  }

  // The marks still on the word they were made for; a word edited since then loses its mark.
  function liveMarks(lesson, marks) {
    var byKey = {};
    slots(lesson, true).forEach(function (s) { byKey[s.key] = words(s.get()); });
    return marks.filter(function (m) { return (byKey[m.key] || [])[m.index] === m.word; });
  }

  // The slot with this key, or null.
  function slotByKey(lesson, key) {
    return slots(lesson, true).filter(function (s) { return s.key === key; })[0] || null;
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
    setWord: setWord,
    nikudLines: nikudLines,
    nikudChunks: nikudChunks,
    buildNikudPrompt: buildNikudPrompt,
    buildManualNikudPrompt: buildManualNikudPrompt,
    parseManualNikud: parseManualNikud,
    checkManualNikud: checkManualNikud,
    sameReading: sameReading,
    compareSecond: compareSecond,
    liveMarks: liveMarks,
    pronunciation: pronunciation,
    diffKinds: diffKinds,
    linesToNikud: linesToNikud,
    lineFills: lineFills,
    slotByKey: slotByKey,
    words: words
  };
})();
