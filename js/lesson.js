/* Lesson schema: parsing, coercion, validation, link encode/decode. Exposes window.Lesson. */
(function () {
  'use strict';

  var H = window.Hebrew;
  var NIKUD_MODES = ['full', 'partial', 'none'];
  var TYPE_NAMES = { mcq: 'שאלה אמריקאית', tf: 'נכון / לא נכון', fill: 'השלמת מילה', order: 'סידור משפטים' };
  var TYPE_ALIASES = {
    mcq: 'mcq', multiple: 'mcq', multiplechoice: 'mcq', choice: 'mcq', question: 'mcq',
    tf: 'tf', truefalse: 'tf', boolean: 'tf',
    fill: 'fill', cloze: 'fill', fillblank: 'fill', blank: 'fill', fillintheblank: 'fill',
    order: 'order', sequence: 'order', ordering: 'order', sort: 'order'
  };

  /* ---------- Extract JSON from an AI chat response ---------- */

  function extractJson(text) {
    var s = String(text || '').replace(/^\uFEFF/, '');
    s = s.replace(/```(?:json|JSON)?/g, '');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return { error: 'no-json' };
    s = s.slice(start, end + 1);
    var attempts = [
      s,
      // Smart quotes some chat UIs produce, and trailing commas.
      s.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/,\s*([}\]])/g, '$1')
    ];
    var lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      try { return { value: JSON.parse(attempts[i]) }; } catch (e) { lastErr = e; }
    }
    return { error: 'bad-json', detail: lastErr && lastErr.message };
  }

  /* ---------- Coerce into the canonical shape ---------- */

  function str(v) {
    return v == null ? '' : H.normalize(String(v)).trim();
  }

  function strList(v) {
    return Array.isArray(v) ? v.map(str) : [];
  }

  function toIndex(answer, options) {
    if (typeof answer === 'number') return answer;
    if (typeof answer === 'string') {
      var t = answer.trim();
      if (/^\d+$/.test(t)) return parseInt(t, 10);
      var b = H.bare(t);
      for (var i = 0; i < options.length; i++) if (H.bare(options[i]) === b) return i;
    }
    return -1;
  }

  function toBool(answer) {
    if (typeof answer === 'boolean') return answer;
    var t = H.stripNikud(String(answer == null ? '' : answer)).trim().toLowerCase();
    if (t === 'true' || t === 'נכון' || t === '1') return true;
    if (t === 'false' || t === 'לא נכון' || t === '0') return false;
    return null;
  }

  function coerceExercise(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var typeKey = String(raw.type || '').toLowerCase().replace(/[^a-z]/g, '');
    var type = TYPE_ALIASES[typeKey];
    var options;
    switch (type) {
      case 'mcq':
        options = strList(raw.options);
        return { type: 'mcq', question: str(raw.question), options: options, answer: toIndex(raw.answer, options) };
      case 'tf':
        return { type: 'tf', statement: str(raw.statement || raw.question || raw.sentence), answer: toBool(raw.answer) };
      case 'fill':
        options = strList(raw.options);
        return {
          type: 'fill',
          sentence: str(raw.sentence || raw.question).replace(/_{2,}/g, '___'),
          options: options,
          answer: toIndex(raw.answer, options)
        };
      case 'order':
        // Drop numbering some AIs add ("1. ...").
        return { type: 'order', sentences: strList(raw.sentences || raw.items).map(function (s) {
          return s.replace(/^\d+[.)]\s*/, '');
        }) };
      default:
        return { type: String(raw.type || ''), unknown: true };
    }
  }

  // Emoji plus their modifiers (skin tones, variation selector, keycap, ZWJ).
  var EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3\u200D]/gu;

  // A run of emoji together with the spaces around it.
  var EMOJI_RUN_RE = new RegExp('[ \\t]*(?:' + EMOJI_RE.source + ')+([ \\t]*)', 'gu');

  function stripEmoji(text) {
    if (!EMOJI_RE.test(text)) return { text: text, removed: false };
    EMOJI_RE.lastIndex = 0;
    var cleaned = text.replace(EMOJI_RUN_RE, function (run, after, offset, all) {
      var prev = all.charAt(offset - 1);
      var next = all.charAt(offset + run.length);
      if (!prev || /\s/.test(prev)) return '';
      // Keep one space between words ("כלב 🐕 רץ"), none before closing punctuation ("טוב! 👍"").
      if (/[\p{L}\p{N}]/u.test(next)) return ' ';
      return after && next && !/[.,!?:;)\]]/.test(next) ? ' ' : '';
    });
    cleaned = cleaned.split('\n').map(function (line) { return line.trim(); }).join('\n');
    return { text: cleaned, removed: true };
  }

  // Returns {lesson, fatal: [messages], notes: [messages]}. A lesson is returned whenever
  // it can be previewed/edited; fatal lists problems that make that impossible;
  // notes lists automatic fixes that were applied.
  function coerce(raw) {
    var fatal = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { lesson: null, fatal: ['התשובה אינה אובייקט JSON של שיעור.'], notes: [] };
    }
    var story = raw.story;
    if (Array.isArray(story)) story = story.join('\n');
    if (typeof story !== 'string' || !story.trim()) fatal.push('חסר השדה "story" (הסיפור).');
    if (!Array.isArray(raw.targetWords)) fatal.push('חסר השדה "targetWords" (מילות היעד) או שהוא אינו רשימה.');
    if (!Array.isArray(raw.exercises)) fatal.push('חסר השדה "exercises" (התרגילים) או שהוא אינו רשימה.');
    if (fatal.length) return { lesson: null, fatal: fatal, notes: [] };

    var notes = [];
    var cleanStory = stripEmoji(H.normalize(story));
    if (cleanStory.removed) notes.push('הוסרו אימוג׳י מתוך הסיפור.');

    var lesson = {
      version: 1,
      title: str(raw.title),
      topic: str(raw.topic),
      nikudMode: NIKUD_MODES.indexOf(raw.nikudMode) !== -1 ? raw.nikudMode : 'full',
      targetWords: raw.targetWords.map(function (t) {
        if (typeof t === 'string') return { word: str(t), emoji: '' };
        t = t || {};
        return { word: str(t.word || t.text), emoji: str(t.emoji) };
      }),
      story: cleanStory.text.replace(/\r\n?/g, '\n').trim(),
      exercises: raw.exercises.map(coerceExercise)
    };
    return { lesson: lesson, fatal: [], notes: notes };
  }

  /* ---------- Validation ---------- */

  function exLabel(i, ex) {
    return 'תרגיל ' + (i + 1) + (TYPE_NAMES[ex.type] ? ' (' + TYPE_NAMES[ex.type] + ')' : '');
  }

  function checkOptions(label, ex, errors, warnings) {
    if (ex.options.length < 2) errors.push(label + ': צריך לפחות 2 אפשרויות.');
    if (ex.options.length > 4) warnings.push(label + ': יש יותר מ-4 אפשרויות.');
    if (ex.options.some(function (o) { return !o; })) errors.push(label + ': יש אפשרות ריקה.');
    var bares = ex.options.map(H.bare);
    if (bares.some(function (b, i) { return b && bares.indexOf(b) !== i; })) warnings.push(label + ': יש אפשרויות כפולות.');
    if (!(Number.isInteger(ex.answer) && ex.answer >= 0 && ex.answer < ex.options.length)) {
      errors.push(label + ': התשובה הנכונה ("answer") חייבת להיות מספר האפשרות, בין 0 ל-' + (ex.options.length - 1) + '.');
    }
  }

  /* ---------- Sentences in the story ---------- */

  // Words without nikud or punctuation, for comparing a sentence with the story.
  function bareWords(text) {
    return H.tokenize(text)
      .filter(function (s) { return s.isWord; })
      .map(function (s) { return H.bare(s.text); })
      .filter(Boolean);
  }

  // Word index where the sentence starts in the story, or -1.
  function findSentence(storyWords, sentence) {
    var sw = bareWords(sentence);
    if (!sw.length) return -1;
    outer:
    for (var i = 0; i + sw.length <= storyWords.length; i++) {
      for (var j = 0; j < sw.length; j++) {
        if (storyWords[i + j] !== sw[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  // Sort each order exercise by where its sentences appear in the story.
  // Sentences not found keep their slot. Returns notes about changes made.
  function sortOrderExercises(lesson) {
    var notes = [];
    var storyWords = bareWords(lesson.story);
    lesson.exercises.forEach(function (ex, i) {
      if (ex.type !== 'order') return;
      var found = [];
      ex.sentences.forEach(function (s, slot) {
        var pos = findSentence(storyWords, s);
        if (pos !== -1) found.push({ slot: slot, pos: pos, text: s });
      });
      var sorted = found.slice().sort(function (a, b) { return a.pos - b.pos || a.slot - b.slot; });
      var changed = false;
      found.forEach(function (f, k) {
        if (sorted[k].text !== f.text) changed = true;
        ex.sentences[f.slot] = sorted[k].text;
      });
      if (changed) notes.push(exLabel(i, ex) + ': סדר המשפטים תוקן לפי הסדר בסיפור.');
    });
    return notes;
  }

  // Unique Hebrew words with no nikud, across all lesson text.
  function unvocalizedWords(lesson) {
    var texts = [lesson.title, lesson.story];
    lesson.targetWords.forEach(function (t) { texts.push(t.word); });
    lesson.exercises.forEach(function (ex) {
      if (ex.unknown) return;
      texts.push(ex.question, ex.statement, ex.sentence);
      texts = texts.concat(ex.options || [], ex.sentences || []);
    });
    var seen = {};
    var out = [];
    texts.forEach(function (t) {
      if (!t) return;
      H.tokenize(t).forEach(function (seg) {
        if (seg.isWord && H.isUnvocalized(seg.text) && !seen[seg.text]) {
          seen[seg.text] = true;
          out.push(seg.text);
        }
      });
    });
    return out;
  }

  // request (optional): {length: number, wordsMode: 'number'|'list', wordCount: n, words: [..]}
  // Returns {errors, warnings, wordCount, missingWords, unvocalized}.
  function check(lesson, request) {
    var errors = [];
    var warnings = [];
    var targets = lesson.targetWords.map(function (t) { return t.word; });

    if (!lesson.title) warnings.push('אין כותרת לשיעור.');
    if (!lesson.story) errors.push('הסיפור ריק.');

    var wordCount = H.countWords(lesson.story);
    if (request && request.length) {
      var min = Math.round(request.length * 0.85);
      var max = Math.round(request.length * 1.15);
      if (wordCount < min || wordCount > max) {
        warnings.push('אורך הסיפור ' + wordCount + ' מילים (התבקשו בערך ' + request.length + ').');
      }
    }

    var n = lesson.targetWords.length;
    if (n < 2 || n > 10) errors.push('צריך בין 2 ל-10 מילות יעד (יש ' + n + ').');
    lesson.targetWords.forEach(function (t, i) {
      if (!t.word) errors.push('מילת יעד ' + (i + 1) + ' ריקה.');
      else if (!t.emoji) errors.push('חסר אימוג׳י למילה "' + t.word + '".');
    });
    var bareTargets = targets.map(H.bare);
    bareTargets.forEach(function (b, i) {
      if (b && bareTargets.indexOf(b) !== i) warnings.push('מילת היעד "' + targets[i] + '" מופיעה פעמיים.');
    });

    if (request) {
      var expected = request.wordsMode === 'list' ? request.words.length : request.wordCount;
      if (expected && n !== expected) warnings.push('התבקשו ' + expected + ' מילות יעד, התקבלו ' + n + '.');
      if (request.wordsMode === 'list') {
        // The teacher may type full spelling (גינה) while the AI returns vocalized defective spelling (גִּנָּה).
        var loose = function (s) { return H.bare(s).replace(/[וי]/g, ''); };
        request.words.forEach(function (w) {
          var found = targets.some(function (t) { return loose(t) === loose(w); });
          if (!found) warnings.push('המילה שביקשת "' + w + '" אינה ברשימת מילות היעד.');
        });
      }
    }

    var storyWords = H.tokenize(lesson.story).filter(function (s) { return s.isWord; }).map(function (s) { return s.text; });
    var missingWords = targets.filter(function (t) {
      return t && !storyWords.some(function (w) { return H.matchesWord(w, t); });
    });
    missingWords.forEach(function (t) {
      // Same letters, different nikud: say so, it is usually a vocalization slip.
      var seen = {};
      var variants = storyWords.filter(function (w) {
        if (seen[w] || !H.matchesWord(w, t, true)) return false;
        seen[w] = true;
        return true;
      });
      errors.push(variants.length
        ? 'מילת היעד "' + t + '" מופיעה בסיפור רק בניקוד אחר: ' + variants.slice(0, 3).join(', ') + '.'
        : 'מילת היעד "' + t + '" לא מופיעה בסיפור.');
    });

    var unvocalized = lesson.nikudMode === 'full' ? unvocalizedWords(lesson) : [];
    if (unvocalized.length) {
      var shown = unvocalized.slice(0, 15).join(', ');
      warnings.push('מילים בלי ניקוד (מסומנות באדום בתצוגה): ' + shown +
        (unvocalized.length > 15 ? ' ועוד ' + (unvocalized.length - 15) : '') + '.');
    }

    var storyBare = bareWords(lesson.story);
    if (!lesson.exercises.length) errors.push('אין תרגילים.');
    lesson.exercises.forEach(function (ex, i) {
      var label = exLabel(i, ex);
      if (ex.unknown) { errors.push(label + ': סוג תרגיל לא מוכר "' + ex.type + '".'); return; }
      if (ex.type === 'mcq') {
        if (!ex.question) errors.push(label + ': חסרה שאלה.');
        checkOptions(label, ex, errors, warnings);
      } else if (ex.type === 'tf') {
        if (!ex.statement) errors.push(label + ': חסר משפט.');
        if (typeof ex.answer !== 'boolean') errors.push(label + ': התשובה חייבת להיות true או false.');
      } else if (ex.type === 'fill') {
        if (!ex.sentence) errors.push(label + ': חסר משפט.');
        else if (ex.sentence.indexOf('___') === -1) errors.push(label + ': המשפט חייב לכלול ___ במקום המילה החסרה.');
        checkOptions(label, ex, errors, warnings);
      } else if (ex.type === 'order') {
        if (ex.sentences.length < 2) errors.push(label + ': צריך לפחות 2 משפטים.');
        if (ex.sentences.some(function (s) { return !s; })) errors.push(label + ': יש משפט ריק.');
        ex.sentences.forEach(function (s) {
          if (s && findSentence(storyBare, s) === -1) warnings.push(label + ': המשפט "' + s + '" לא נמצא בסיפור.');
        });
      }
    });

    return { errors: errors, warnings: warnings, wordCount: wordCount, missingWords: missingWords, unvocalized: unvocalized };
  }

  // A short message the teacher can send back to her AI.
  function fixMessage(problems) {
    if (!problems.length) return '';
    return 'יש כמה בעיות בתשובה שלך:\n' +
      problems.map(function (p) { return '- ' + p; }).join('\n') +
      '\n\nתקן אותן והחזר את ה-JSON המלא והמתוקן בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, באותו מבנה ובניקוד מלא.';
  }

  /* ---------- Link encode / decode ---------- */

  function clean(lesson) {
    return {
      version: 1,
      title: lesson.title,
      topic: lesson.topic,
      nikudMode: lesson.nikudMode,
      targetWords: lesson.targetWords.map(function (t) { return { word: t.word, emoji: t.emoji }; }),
      story: lesson.story,
      exercises: lesson.exercises.filter(function (ex) { return !ex.unknown; })
    };
  }

  function encode(lesson) {
    return window.LZString.compressToEncodedURIComponent(JSON.stringify(clean(lesson)));
  }

  function decode(hash) {
    try {
      var data = String(hash || '').replace(/^#/, '');
      if (!data) return null;
      var json = window.LZString.decompressFromEncodedURIComponent(data);
      if (!json) return null;
      return coerce(JSON.parse(json)).lesson;
    } catch (e) {
      return null;
    }
  }

  window.Lesson = {
    NIKUD_MODES: NIKUD_MODES,
    TYPE_NAMES: TYPE_NAMES,
    extractJson: extractJson,
    coerce: coerce,
    check: check,
    sortOrderExercises: sortOrderExercises,
    fixMessage: fixMessage,
    clean: clean,
    encode: encode,
    decode: decode
  };
})();
