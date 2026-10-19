/* Teacher flow: settings → prompt → paste → preview/edit → link. */
(function () {
  'use strict';

  var H = window.Hebrew;
  var U = window.Util;
  var L = window.Lesson;
  var R = window.Render;
  var el = U.el;

  var STORE_SETTINGS = 'readingApp.settings';
  var STORE_DRAFT = 'readingApp.draft';

  var state = {
    step: 1,
    maxStep: 1,
    settings: null,   // last submitted form values
    request: null,    // what was asked from the AI, for validation; null for loaded files
    lesson: null,
    nikudVerified: null, // Review.signature of the text that was last vocalized with Dicta
    link: ''
  };

  function $(id) { return document.getElementById(id); }

  /* ---------- localStorage (teacher conveniences only) ---------- */

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  var saveDraftTimer = null;
  function saveDraftSoon() {
    clearTimeout(saveDraftTimer);
    saveDraftTimer = setTimeout(function () {
      if (state.lesson) save(STORE_DRAFT, { lesson: state.lesson, request: state.request, nikudVerified: state.nikudVerified });
    }, 400);
  }

  /* ---------- UI helpers ---------- */

  var toastTimer = null;
  function toast(text) {
    var t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function copy(text, okMsg) {
    U.copyText(text).then(function () { toast(okMsg || 'הועתק!'); },
      function () { toast('לא הצלחתי להעתיק. סמנו את הטקסט והעתיקו ידנית.'); });
  }

  // kind: error | warn | ok | info
  function msgBox(kind, title, items) {
    var box = el('div', { class: 'msg ' + kind });
    if (title) box.appendChild(el('div', null, el('strong', null, title)));
    if (items && items.length) {
      box.appendChild(el('ul', null, items.map(function (i) { return el('li', null, i); })));
    }
    return box;
  }

  function showStep(n) {
    if (n >= 4 && !state.lesson) n = 3;
    if (n === 6 && linkBlockers().length) { goToLink(); return; }
    if (n === 2 && !$('promptText').textContent) n = 1;
    state.step = n;
    state.maxStep = Math.max(state.maxStep, n);
    for (var i = 1; i <= 6; i++) $('step' + i).hidden = i !== n;
    $('wrap').classList.toggle('wide', n === 4);
    Array.prototype.forEach.call($('steps').children, function (li) {
      var s = +li.dataset.step;
      li.className = s === n ? 'active' : (s <= state.maxStep ? 'done' : '');
      li.style.cursor = s <= state.maxStep && s !== n ? 'pointer' : '';
    });
    if (n === 4) renderEditor();
    if (n === 5) enterCheckStep();
    if (n === 6) renderLink();
    window.scrollTo(0, 0);
  }

  /* ---------- Step 1: settings ---------- */

  function parseWordList(text) {
    return text.split(/[,،\n]+/).map(function (w) { return H.normalize(w).trim(); }).filter(Boolean);
  }

  function readForm() {
    return {
      topic: $('topic').value.trim(),
      length: parseInt($('length').value, 10),
      wordsMode: document.querySelector('input[name="wordsMode"]:checked').value,
      wordCount: parseInt($('wordCount').value, 10),
      wordListText: $('wordList').value,
      nikud: document.querySelector('input[name="nikud"]:checked').value,
      level: document.querySelector('input[name="level"]:checked').value
    };
  }

  // Radio buttons for the reading levels, from js/levels.js. Returns the label elements.
  function levelRadios(name, checkedId, onChange) {
    return window.Levels.LIST.map(function (lv) {
      var radio = el('input', { type: 'radio', name: name, value: lv.id, checked: lv.id === checkedId });
      if (onChange) radio.addEventListener('change', function () { onChange(lv.id); });
      return el('label', { class: 'choice' }, radio, ' ' + lv.label);
    });
  }

  function fillForm(s) {
    if (!s) return;
    if (s.topic) $('topic').value = s.topic;
    if (s.length) $('length').value = s.length;
    if (s.wordCount) $('wordCount').value = s.wordCount;
    if (s.wordListText) $('wordList').value = s.wordListText;
    var wm = document.querySelector('input[name="wordsMode"][value="' + s.wordsMode + '"]');
    if (wm) wm.checked = true;
    var nk = document.querySelector('input[name="nikud"][value="' + s.nikud + '"]');
    if (nk) nk.checked = true;
    var lv = document.querySelector('input[name="level"][value="' + s.level + '"]');
    if (lv) lv.checked = true;
    syncWordsMode();
  }

  function syncWordsMode() {
    var list = document.querySelector('input[name="wordsMode"]:checked').value === 'list';
    $('wordsListBox').hidden = !list;
    $('wordsNumberBox').hidden = list;
  }

  function submitSettings(e) {
    e.preventDefault();
    var f = readForm();
    var errors = [];
    if (!f.topic) errors.push('כתבו נושא לסיפור.');
    if (!(f.length >= 20 && f.length <= 400)) errors.push('אורך הסיפור צריך להיות בין 20 ל-400 מילים.');
    var words = parseWordList(f.wordListText);
    if (f.wordsMode === 'number' && !(f.wordCount >= 2 && f.wordCount <= 10)) errors.push('מספר מילות היעד צריך להיות בין 2 ל-10.');
    if (f.wordsMode === 'list' && (words.length < 2 || words.length > 10)) errors.push('כתבו בין 2 ל-10 מילות יעד (כתבתם ' + words.length + ').');

    var msgs = U.clear($('settingsMsgs'));
    if (errors.length) { msgs.appendChild(msgBox('error', null, errors)); return; }

    save(STORE_SETTINGS, f);
    state.settings = f;
    state.request = { topic: f.topic, length: f.length, level: f.level, wordsMode: f.wordsMode, wordCount: f.wordCount, words: words };
    $('promptText').textContent = window.buildPrompt(state.request);
    showStep(2);
  }

  /* ---------- Step 3: parse response ---------- */

  var pendingLesson = null;

  function parseResponse() {
    var msgs = U.clear($('parseMsgs'));
    $('fixBox').hidden = true;
    $('continueAnyway').hidden = true;
    pendingLesson = null;

    var text = $('response').value;
    if (!text.trim()) { msgs.appendChild(msgBox('error', 'לא הודבקה תשובה.')); return; }

    var ex = L.extractJson(text);
    if (ex.error) {
      var noJson = ex.error === 'no-json';
      msgs.appendChild(msgBox('error', noJson
        ? 'לא מצאתי JSON בתשובה. ודאו שהעתקתם את כל התשובה.'
        : 'ה-JSON בתשובה לא תקין. ייתכן שהתשובה נקטעה באמצע.'));
      showFix(noJson
        ? 'החזר את התשובה כ-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, במבנה שביקשתי.'
        : 'ה-JSON ששלחת לא תקין או נקטע באמצע. החזר שוב את ה-JSON המלא בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו.');
      return;
    }

    var c = L.coerce(ex.value);
    if (!c.lesson) {
      msgs.appendChild(msgBox('error', 'חסרים חלקים בשיעור:', c.fatal));
      showFix(L.fixMessage(c.fatal));
      return;
    }

    var lesson = c.lesson;
    if (state.settings) {
      lesson.nikudMode = state.settings.nikud;
      lesson.level = state.settings.level;
      if (!lesson.topic) lesson.topic = state.settings.topic;
    }
    // Automatic fixes are shown as warnings but not sent back to the AI.
    var notes = c.notes.concat(L.sortOrderExercises(lesson));
    var res = L.check(lesson, state.request);
    var warnings = notes.concat(res.warnings);
    if (!res.errors.length && !warnings.length) {
      acceptLesson(lesson, state.request);
      return;
    }
    if (res.errors.length) msgs.appendChild(msgBox('error', 'צריך לתקן:', res.errors));
    if (warnings.length) msgs.appendChild(msgBox('warn', 'שימו לב:', warnings));
    var problems = res.errors.concat(res.warnings);
    if (problems.length) {
      msgs.appendChild(msgBox('info', 'אפשר לשלוח לבינה הודעת תיקון, או להמשיך ולתקן בעצמכם בשלב העריכה.'));
      showFix(L.fixMessage(problems));
    }
    pendingLesson = lesson;
    $('continueAnyway').textContent = res.errors.length ? 'להמשיך לעריכה בכל זאת ←' : 'להמשיך לעריכה ←';
    $('continueAnyway').hidden = false;
  }

  function loadResponseFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      $('response').value = reader.result;
      parseResponse();
    };
    reader.onerror = function () {
      U.clear($('parseMsgs')).appendChild(msgBox('error', 'לא הצלחתי לקרוא את הקובץ.'));
    };
    reader.readAsText(file);
  }

  function showFix(text) {
    $('fixText').textContent = text;
    $('fixBox').hidden = false;
  }

  // nikudVerified: signature of text already vocalized with Dicta, or null.
  function acceptLesson(lesson, request, nikudVerified) {
    state.lesson = lesson;
    state.request = request;
    state.nikudVerified = nikudVerified || null;
    state.maxStep = Math.min(state.maxStep, 4);
    resetCheckStep();
    saveDraftSoon();
    showStep(4);
  }

  /* ---------- Load / download JSON ---------- */

  function loadJsonFile(file) {
    var msgs = U.clear($('loadMsgs'));
    var reader = new FileReader();
    reader.onload = function () {
      var ex = L.extractJson(reader.result);
      var c = ex.error ? { lesson: null, fatal: ['הקובץ אינו קובץ שיעור תקין.'] } : L.coerce(ex.value);
      if (!c.lesson) { msgs.appendChild(msgBox('error', 'לא הצלחתי לטעון את הקובץ:', c.fatal)); return; }
      state.maxStep = 3;
      // A saved lesson file came out of this app: if every word has nikud, it was already vocalized.
      var vocalized = RV.hasAnyNikud(c.lesson) && !L.unvocalizedWords(c.lesson).length;
      acceptLesson(c.lesson, null, vocalized ? RV.signature(c.lesson) : null);
    };
    reader.onerror = function () { msgs.appendChild(msgBox('error', 'לא הצלחתי לקרוא את הקובץ.')); };
    reader.readAsText(file);
  }

  function downloadJson() {
    var lesson = L.clean(state.lesson);
    var blob = new Blob([JSON.stringify(lesson, null, 2)], { type: 'application/json' });
    var name = (H.stripNikud(lesson.title || lesson.topic || 'שיעור').replace(/[\\/:*?"<>|]+/g, '').trim() || 'שיעור') + '.json';
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- Step 4: editor ---------- */

  var refreshTimer = null;
  function changed(rebuild) {
    saveDraftSoon();
    if (rebuild) { renderEditor(); return; }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshPreview, 200);
  }

  function textInput(value, onChange, attrs) {
    var input = el('input', Object.assign({ type: 'text', value: value, spellcheck: 'true', lang: 'he' }, attrs || {}));
    input.addEventListener('input', function () { onChange(H.normalize(input.value)); changed(); });
    input.addEventListener('change', function () { onChange(H.normalize(input.value).trim()); changed(); });
    return input;
  }

  function removeBtn(label, onClick) {
    return el('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onclick: onClick }, '✕');
  }

  function renderEditor() {
    var lesson = state.lesson;
    var root = U.clear($('editor'));

    root.appendChild(el('div', { class: 'field' },
      el('label', null, 'כותרת'),
      textInput(lesson.title, function (v) { lesson.title = v; })));

    var modeNames = { full: 'מלא', partial: 'חלקי (רק מילות היעד)', none: 'בלי ניקוד' };
    root.appendChild(el('div', { class: 'field' },
      el('span', { class: 'label' }, 'ניקוד אצל הילד'),
      el('div', { class: 'choices' }, L.NIKUD_MODES.map(function (m) {
        var radio = el('input', { type: 'radio', name: 'edNikud', value: m, checked: lesson.nikudMode === m });
        radio.addEventListener('change', function () { lesson.nikudMode = m; changed(); });
        return el('label', { class: 'choice' }, radio, ' ' + modeNames[m]);
      }))));

    // Used by the review prompt; empty for lesson files made before levels.
    root.appendChild(el('div', { class: 'field' },
      el('span', { class: 'label' }, 'רמת קריאה'),
      el('div', { class: 'choices' }, levelRadios('edLevel', lesson.level, function (id) { lesson.level = id; changed(); }))));

    // Target words
    var twBox = el('div', { class: 'field' }, el('span', { class: 'label' }, 'מילות יעד ואימוג׳י'));
    lesson.targetWords.forEach(function (t, i) {
      twBox.appendChild(el('div', { class: 'tw-row' },
        textInput(t.word, function (v) { t.word = v; }, { 'aria-label': 'מילת יעד ' + (i + 1) }),
        textInput(t.emoji, function (v) { t.emoji = v; }, { class: 'emoji', 'aria-label': 'אימוג׳י' }),
        removeBtn('מחיקת מילה', function () { lesson.targetWords.splice(i, 1); changed(true); })));
    });
    if (lesson.targetWords.length < 10) {
      twBox.appendChild(el('button', { type: 'button', class: 'btn small', onclick: function () {
        lesson.targetWords.push({ word: '', emoji: '' }); changed(true);
      } }, '+ מילה'));
    }
    root.appendChild(twBox);

    // Story
    var story = el('textarea', { rows: 12, value: lesson.story, spellcheck: 'true', lang: 'he' });
    story.addEventListener('input', function () { lesson.story = H.normalize(story.value); changed(); });
    root.appendChild(el('div', { class: 'field' },
      el('label', null, 'הסיפור'),
      story,
      el('div', { class: 'hint', id: 'wordCountHint' })));

    // Exercises
    root.appendChild(el('h3', null, 'תרגילים'));
    lesson.exercises.forEach(function (ex, i) { root.appendChild(exerciseEditor(ex, i)); });
    root.appendChild(el('div', { class: 'row' },
      el('span', { class: 'muted small' }, 'הוספת תרגיל:'),
      ['mcq', 'tf', 'fill', 'order'].map(function (type) {
        return el('button', { type: 'button', class: 'btn small', onclick: function () {
          lesson.exercises.push(newExercise(type)); changed(true);
        } }, '+ ' + L.TYPE_NAMES[type]);
      })));

    refreshPreview();
  }

  function newExercise(type) {
    if (type === 'mcq') return { type: 'mcq', question: '', options: ['', '', ''], answer: 0 };
    if (type === 'tf') return { type: 'tf', statement: '', answer: true };
    if (type === 'fill') return { type: 'fill', sentence: '___', options: ['', '', ''], answer: 0 };
    return { type: 'order', sentences: ['', '', '', ''] };
  }

  function exerciseEditor(ex, i) {
    var lesson = state.lesson;
    var box = el('div', { class: 'ex-item' });
    box.appendChild(el('h3', null,
      el('span', null, (i + 1) + '. ' + (L.TYPE_NAMES[ex.type] || 'סוג לא מוכר: ' + ex.type)),
      removeBtn('מחיקת תרגיל', function () { lesson.exercises.splice(i, 1); changed(true); })));

    if (ex.unknown) {
      box.appendChild(el('p', { class: 'muted small' }, 'התרגיל הזה לא ייכלל בשיעור. אפשר למחוק אותו.'));
      return box;
    }

    if (ex.type === 'mcq' || ex.type === 'fill') {
      var isFill = ex.type === 'fill';
      box.appendChild(el('div', { class: 'field' },
        el('label', null, isFill ? 'משפט (סמנו את החסר ב-___)' : 'שאלה'),
        textInput(isFill ? ex.sentence : ex.question, function (v) {
          if (isFill) ex.sentence = v.replace(/_{2,}/g, '___'); else ex.question = v;
        })));
      var opts = el('div', { class: 'field' }, el('span', { class: 'label' }, 'אפשרויות (סמנו את הנכונה)'));
      var group = 'ans' + i + '_' + Math.random().toString(36).slice(2, 7);
      ex.options.forEach(function (o, j) {
        var radio = el('input', { type: 'radio', name: group, checked: ex.answer === j, 'aria-label': 'תשובה נכונה' });
        radio.addEventListener('change', function () { ex.answer = j; changed(); });
        opts.appendChild(el('div', { class: 'opt-row' },
          radio,
          textInput(o, function (v) { ex.options[j] = v; }),
          removeBtn('מחיקת אפשרות', function () {
            ex.options.splice(j, 1);
            if (ex.answer === j) ex.answer = -1; else if (ex.answer > j) ex.answer--;
            changed(true);
          })));
      });
      if (ex.options.length < 4) {
        opts.appendChild(el('button', { type: 'button', class: 'btn small', onclick: function () {
          ex.options.push(''); changed(true);
        } }, '+ אפשרות'));
      }
      box.appendChild(opts);
    } else if (ex.type === 'tf') {
      box.appendChild(el('div', { class: 'field' },
        el('label', null, 'משפט'),
        textInput(ex.statement, function (v) { ex.statement = v; })));
      var tfGroup = 'tf' + i + '_' + Math.random().toString(36).slice(2, 7);
      box.appendChild(el('div', { class: 'choices' }, [true, false].map(function (val) {
        var radio = el('input', { type: 'radio', name: tfGroup, checked: ex.answer === val });
        radio.addEventListener('change', function () { ex.answer = val; changed(); });
        return el('label', { class: 'choice' }, radio, val ? ' נכון' : ' לא נכון');
      })));
    } else if (ex.type === 'order') {
      var list = el('div', { class: 'field' }, el('span', { class: 'label' }, 'משפטים, בסדר הנכון'));
      ex.sentences.forEach(function (s, j) {
        list.appendChild(el('div', { class: 'opt-row' },
          el('span', { class: 'muted' }, (j + 1) + '.'),
          textInput(s, function (v) { ex.sentences[j] = v; }),
          removeBtn('מחיקת משפט', function () { ex.sentences.splice(j, 1); changed(true); })));
      });
      list.appendChild(el('button', { type: 'button', class: 'btn small', onclick: function () {
        ex.sentences.push(''); changed(true);
      } }, '+ משפט'));
      box.appendChild(list);
    }
    return box;
  }

  function refreshPreview() {
    var lesson = state.lesson;
    if (!lesson) return;
    var res = L.check(lesson, state.request);

    var hint = $('wordCountHint');
    if (hint) {
      hint.textContent = res.wordCount + ' מילים' +
        (state.request ? ' (התבקשו בערך ' + state.request.length + ')' : '') +
        '. שורה חדשה = פסקה חדשה.';
    }

    var msgs = U.clear($('checkMsgs'));
    if (res.errors.length) msgs.appendChild(msgBox('error', 'צריך לתקן לפני יצירת קישור:', res.errors));
    if (res.warnings.length) msgs.appendChild(msgBox('warn', 'שימו לב:', res.warnings));
    var haser = haserBox();
    if (haser) msgs.appendChild(haser);
    if (!res.errors.length && !res.warnings.length && !haser) msgs.appendChild(msgBox('ok', 'הכל תקין ✓'));
    var nikudNote = nikudNoteBox();
    if (nikudNote) msgs.appendChild(nikudNote);
    $('makeLink').disabled = res.errors.length > 0;
    $('makeLink').textContent = nikudRequired() ? 'המשך לבדיקה ולניקוד ←' : 'המשך לבדיקה ←';
    var stepMsgs = U.clear($('haserMsgs'));
    if (haser) stepMsgs.appendChild(haserBox());

    // Before Dicta the whole lesson is unvocalized; marking every word would be noise.
    var mark = RV.hasAnyNikud(lesson);
    var p = U.clear($('preview'));
    p.appendChild(el('h2', { style: 'text-align:center' }, previewText(lesson, lesson.title, mark)));
    p.appendChild(el('div', { class: 'target-chips' }, lesson.targetWords.map(function (t) {
      return el('span', { class: 'chip' }, t.emoji + ' ', previewText(lesson, t.word, mark));
    })));
    p.appendChild(el('div', { class: 'story' }, R.story(lesson, null, mark)));
    p.appendChild(el('h3', { style: 'margin-top:16px' }, 'תרגילים'));
    lesson.exercises.forEach(function (ex, i) {
      if (ex.unknown) return;
      p.appendChild(exercisePreview(lesson, ex, i, mark));
    });
  }

  function previewText(lesson, s, mark) {
    return mark ? R.markedText(lesson, s) : document.createTextNode(R.text(lesson, s || ''));
  }

  // Where the lesson stands with nikud, for the preview. Not a warning: nikud comes in the next step.
  function nikudNoteBox() {
    var lesson = state.lesson;
    if (!nikudRequired()) return null;
    if (!RV.hasAnyNikud(lesson)) return msgBox('info', 'השיעור עדיין בלי ניקוד. הניקוד יתווסף בשלב הבא, בעזרת הנקדן של דיקטה.');
    var missing = lesson.nikudMode === 'full' ? L.unvocalizedWords(lesson) : [];
    if (missing.length) {
      return msgBox('info', 'מילים בלי ניקוד (מסומנות באדום). הן ינוקדו בשלב הניקוד בדיקטה:',
        [missing.slice(0, 15).join(', ') + (missing.length > 15 ? ' ועוד ' + (missing.length - 15) : '')]);
    }
    if (!nikudDone()) {
      return msgBox('info', state.nikudVerified
        ? 'הטקסט השתנה מאז הניקוד בדיקטה. צריך לנקד שוב בשלב הבא.'
        : 'בשלב הבא משווים את הניקוד לנקדן של דיקטה.');
    }
    return null;
  }

  // Not blocking: holam/qubuts without ו may be fine (כֹּל), so the teacher decides.
  function haserBox() {
    var list = window.Review.haserWords(state.lesson);
    return list.length ? msgBox('warn', 'ייתכן כתיב חסר (חולם או קובוץ בלי ו):', [list.join(', ')]) : null;
  }

  function exercisePreview(lesson, ex, i, mark) {
    var box = el('div', { class: 'ex-preview' });
    var num = (i + 1) + '. ';
    function t(s) { return previewText(lesson, s, mark); }
    function optionList() {
      return el('ol', null, ex.options.map(function (o, j) {
        return el('li', { class: j === ex.answer ? 'correct' : '' }, t(o), j === ex.answer ? ' ✓' : '');
      }));
    }
    if (ex.type === 'mcq') {
      box.appendChild(el('div', null, num, t(ex.question)));
      box.appendChild(optionList());
    } else if (ex.type === 'tf') {
      box.appendChild(el('div', null, num, t(ex.statement)));
      box.appendChild(el('div', { class: 'correct' }, ex.answer === true ? 'נכון ✓' : ex.answer === false ? 'לא נכון ✓' : ''));
    } else if (ex.type === 'fill') {
      box.appendChild(el('div', null, num, R.fillSentence(lesson, ex.sentence, null, mark)));
      box.appendChild(optionList());
    } else if (ex.type === 'order') {
      box.appendChild(el('div', null, num + 'סידור משפטים (הילד יקבל אותם מעורבבים):'));
      box.appendChild(el('ol', null, ex.sentences.map(function (s) { return el('li', null, t(s)); })));
    }
    return box;
  }

  /* ---------- Step 5: text review (optional) and nikud with Dicta ---------- */

  var RV = window.Review;

  // With full or partial nikud, the nikud must come from Dicta before a link is made.
  function nikudRequired() {
    return state.lesson.nikudMode !== 'none';
  }

  // Dicta was applied to the text as it is now.
  function nikudDone() {
    return !nikudRequired() || state.nikudVerified === RV.signature(state.lesson);
  }

  // Lesson errors, and a missing nikud step, block the link.
  function linkBlockers() {
    var out = L.check(state.lesson, state.request).errors.slice();
    if (!nikudDone()) out.push('NIKUD');
    return out;
  }

  function resetCheckStep() {
    $('reviewPromptBox').hidden = true;
    $('reviewResponse').value = '';
    $('dictaText').value = '';
    U.clear($('reviewMsgs'));
    U.clear($('reviewList'));
    U.clear($('checkStepMsgs'));
    clearNikudResults();
    resetAutoNikud();
  }

  function clearNikudResults() {
    U.clear($('nikudMsgs'));
    U.clear($('nikudList'));
  }

  // The Dicta result is tied to the text it was applied to.
  function nikudIsStale() {
    return state.nikudVerified !== null && state.nikudVerified !== RV.signature(state.lesson);
  }

  function dropStaleNikud() {
    if (!nikudIsStale()) return;
    state.nikudVerified = null;
    saveDraftSoon();
    clearNikudResults();
    $('nikudMsgs').appendChild(msgBox('info', 'הטקסט השתנה מאז הניקוד. העתיקו את הטקסט מחדש ונקדו שוב בדיקטה.'));
  }

  // Step 5 layout depends on the nikud mode and on whether the lesson has nikud yet.
  function syncCheckStep() {
    var required = nikudRequired();
    $('step5Title').textContent = required ? 'בדיקה וניקוד' : 'בדיקה (לא חובה)';
    $('step5Intro').textContent = required
      ? 'אפשר לבדוק את הטקסט (לא חובה). אחר כך מנקדים בנקדן של דיקטה: זה חובה לפני יצירת קישור.'
      : 'במצב בלי ניקוד אין צורך לנקד. אפשר לבדוק את הטקסט לפני שיוצרים קישור, או לדלג.';
    $('skipCheck').hidden = required;
    $('nikudPart').hidden = !required;
    $('compareNikud').textContent = RV.hasAnyNikud(state.lesson) ? 'השוואה' : 'החלת הניקוד';
  }

  function enterCheckStep() {
    U.clear($('checkStepMsgs'));
    dropStaleNikud();
    syncCheckStep();
    if (nikudRequired() && nikudDone() && !$('nikudMsgs').children.length) {
      $('nikudMsgs').appendChild(msgBox('ok', 'הטקסט מנוקד ✓'));
    }
  }

  function goToLink() {
    var blockers = linkBlockers();
    if (!blockers.length) { showStep(6); return; }
    if (state.step !== 5) showStep(5);
    var msgs = U.clear($('checkStepMsgs'));
    var errors = blockers.filter(function (b) { return b !== 'NIKUD'; });
    if (errors.length) {
      msgs.appendChild(msgBox('error', 'אחרי השינויים צריך לתקן כמה דברים לפני יצירת קישור (בשלב העריכה):', errors));
    }
    if (errors.length !== blockers.length) {
      msgs.appendChild(msgBox('error', 'לפני יצירת קישור צריך לנקד את הטקסט בדיקטה (חלק 2 למעלה).'));
    }
  }

  /* 1. Text review */

  function makeReviewPrompt() {
    $('reviewPromptText').textContent = RV.buildReviewPrompt(state.lesson);
    $('reviewPromptBox').hidden = false;
  }

  function parseReview() {
    var msgs = U.clear($('reviewMsgs'));
    var list = U.clear($('reviewList'));
    var text = $('reviewResponse').value;
    if (!text.trim()) { msgs.appendChild(msgBox('error', 'לא הודבקה תשובה.')); return; }
    var r = RV.parseSuggestions(text);
    if (r.error) { msgs.appendChild(msgBox('error', r.error, ['ודאו שהעתקתם את כל התשובה, או בקשו מהבינה להחזיר JSON בבלוק קוד.'])); return; }
    if (!r.items.length) { msgs.appendChild(msgBox('ok', 'הבינה לא מצאה מה לתקן ✓')); return; }
    msgs.appendChild(msgBox('info', 'נמצאו ' + r.items.length + ' הצעות. אשרו או דחו כל הצעה.'));
    r.items.forEach(function (item) { list.appendChild(reviewCard(item)); });
  }

  function reviewCard(item) {
    var loc = RV.locate(state.lesson, item);
    var ownSlot = RV.slots(state.lesson, false).filter(function (s) { return s.key === item.field; })[0];
    var label = loc ? loc.slot.label : ownSlot ? ownSlot.label : (item.field || 'שדה לא ידוע');
    var status = el('span', { class: 'review-status' });
    var actions = el('div', { class: 'row' });
    var isStyle = item.type === 'style';
    var card = el('div', { class: 'review-item ' + (isStyle ? 'style' : 'error') },
      el('div', { class: 'review-head' },
        el('span', null,
          el('strong', null, label),
          el('span', { class: 'kind' }, isStyle ? 'הצעת ניסוח' : 'שגיאה')),
        status),
      el('div', { class: 'review-diff' },
        el('del', null, item.original), el('span', { class: 'muted', 'aria-hidden': 'true' }, ' ← '), el('ins', null, item.fix)),
      item.reason ? el('p', { class: 'muted small' }, item.reason) : null,
      // A fix without nikud replaces vocalized text with plain letters.
      loc && !H.hasNikud(item.fix) && H.hasNikud(loc.slot.get().slice(loc.start, loc.end))
        ? el('p', { class: 'small fix-note' }, 'ℹ️ התיקון בלי ניקוד. אחרי האישור צריך לנקד שוב בדיקטה (חלק 2).')
        : null,
      actions);

    var approve = el('button', { type: 'button', class: 'btn small primary' }, '✓ אשר');
    var reject = el('button', { type: 'button', class: 'btn small quiet' }, '✕ דחה');
    actions.appendChild(approve);
    actions.appendChild(reject);

    var warn = el('div', { class: 'msg warn small', hidden: true }, 'הטקסט המקורי לא נמצא בשיעור (אולי כבר תוקן, או שהבינה שינתה אותו). אפשר לתקן ידנית בשלב העריכה.');
    card.insertBefore(warn, actions);
    if (!loc) { warn.hidden = false; approve.disabled = true; }

    function done(text, cls) {
      status.textContent = text;
      card.classList.add(cls);
      actions.hidden = true;
    }
    approve.addEventListener('click', function () {
      if (!RV.applySuggestion(state.lesson, item)) { warn.hidden = false; approve.disabled = true; return; }
      done('אושר ✓', 'accepted');
      changed();
      dropStaleNikud();
    });
    reject.addEventListener('click', function () { done('נדחה', 'rejected'); });
    return card;
  }

  /* 2. Nikud: automatic through Dicta (userscripts/dicta-bridge.user.js), or pasted by hand */

  var DB = window.DictaBridge;
  var MANUAL = 'אפשר לנקד ידנית לפי השלבים למטה.';

  function autoNikud() {
    var msgs = U.clear($('autoNikudMsgs'));
    clearNikudResults();
    U.clear($('checkStepMsgs'));
    var btn = $('autoNikud');
    var sig = RV.signature(state.lesson);
    var status = el('div', { class: 'msg info', role: 'status' });
    btn.disabled = true;
    DB.start(RV.plainText(state.lesson), {
      status: function (kind, info) {
        status.textContent = kind === 'opening' ? 'פותחים את דיקטה בחלון חדש…'
          : 'דיקטה מנקדת את הטקסט…' + (info.parts > 1 ? ' (חלק ' + info.part + ' מתוך ' + info.parts + ')' : '');
        if (!status.parentNode) msgs.appendChild(status);
      },
      result: function (text) {
        btn.disabled = false;
        U.clear(msgs);
        if (RV.signature(state.lesson) !== sig) {
          msgs.appendChild(msgBox('warn', 'הטקסט השתנה בזמן הניקוד. לחצו שוב על "נקד אוטומטית בדיקטה".'));
          return;
        }
        $('dictaText').value = text;
        compareNikud();
      },
      fail: function (reason, message) {
        btn.disabled = false;
        U.clear(msgs).appendChild(autoNikudFailure(reason, message));
      }
    });
  }

  function autoNikudFailure(reason, message) {
    var help = el('a', { href: 'dicta-setup.html', target: '_blank', rel: 'noopener' }, 'הוראות ההתקנה');
    if (reason === 'missing') {
      return msgBox('warn', 'לא התקבלה תשובה מדיקטה: נראה שהתוסף לניקוד אוטומטי לא מותקן או לא מופעל בדפדפן הזה.', [
        el('span', null, 'להתקנה (פעם אחת) ראו את ', help, '.'),
        'בינתיים אפשר לנקד ידנית בחלון של דיקטה שנפתח, לפי השלבים למטה.'
      ]);
    }
    var title = {
      blocked: 'הדפדפן חסם את פתיחת החלון של דיקטה.',
      closed: 'החלון של דיקטה נסגר לפני שהניקוד הסתיים.',
      timeout: 'דיקטה לא החזירה ניקוד בזמן.',
      error: 'הניקוד האוטומטי נכשל' + (message ? ': ' + message : '.')
    }[reason] || 'הניקוד האוטומטי נכשל.';
    var items = [];
    if (reason === 'blocked') items.push('אשרו חלונות קופצים לאתר הזה (בסמל שבצד שורת הכתובת) ונסו שוב.');
    if (reason === 'error') items.push(el('span', null, 'אם זה חוזר, בדקו ב-Tampermonkey שהסקריפט מעודכן (ראו ', help, ').'));
    items.push(MANUAL);
    return msgBox('error', title, items);
  }

  function resetAutoNikud() {
    DB.cancel();
    $('autoNikud').disabled = false;
    U.clear($('autoNikudMsgs'));
  }

  // Unvocalized words take Dicta's nikud directly; vocalized words that differ are listed for a choice.
  function compareNikud() {
    var msgs = U.clear($('nikudMsgs'));
    var list = U.clear($('nikudList'));
    U.clear($('checkStepMsgs'));
    var r = RV.compareNikud(state.lesson, $('dictaText').value);
    if (r.error) { msgs.appendChild(msgBox('error', r.error, r.details)); return; }
    var filled = RV.applyFills(r.fills);
    state.nikudVerified = RV.signature(state.lesson);
    changed();
    syncCheckStep();
    if (filled) msgs.appendChild(msgBox('ok', 'הניקוד של דיקטה הוחל על ' + (filled === 1 ? 'מילה אחת' : filled + ' מילים') + ' ✓'));
    if (!r.diffs.length) {
      if (!filled) msgs.appendChild(msgBox('ok', 'הניקוד זהה לניקוד של דיקטה ✓'));
      return;
    }

    msgs.appendChild(msgBox('info', 'נמצאו ' + r.diffs.length + ' מילים מנוקדות שהניקוד שלהן שונה (או הכתיב). בחרו לכל מילה את הגרסה הנכונה.'));
    var acceptAll = el('button', { type: 'button', class: 'btn small' }, 'קבל את כל דיקטה');
    list.appendChild(el('div', { class: 'row', style: 'margin-bottom:10px' }, acceptAll));
    var rows = r.diffs.map(nikudRow);
    rows.forEach(function (row) { list.appendChild(row.node); });
    acceptAll.addEventListener('click', function () {
      rows.forEach(function (row) { row.pick('dicta'); });
    });
  }

  function nikudRow(d) {
    var aiBtn = el('button', { type: 'button', class: 'pick' }, el('span', { class: 'pick-label' }, 'הבינה'), el('span', { class: 'pick-word' }, d.ai));
    var dictaBtn = el('button', { type: 'button', class: 'pick' }, el('span', { class: 'pick-label' }, 'דיקטה'), el('span', { class: 'pick-word' }, d.dicta));
    var node = el('div', { class: 'nikud-row' },
      el('div', { class: 'nikud-context' },
        el('span', { class: 'muted small' }, d.slot.label + ': '),
        d.before ? H.stripNikud(d.before) + ' ' : '', el('mark', null, H.stripNikud(d.ai)), d.after ? ' ' + H.stripNikud(d.after) : '',
        d.spelling ? el('span', { class: 'tag', title: 'המילים שונות רק ב-ו או ב-י (כתיב מלא מול כתיב חסר)' }, 'כתיב שונה') : null),
      el('div', { class: 'row' }, aiBtn, dictaBtn));

    function show() {
      aiBtn.classList.toggle('selected', d.choice === 'ai');
      dictaBtn.classList.toggle('selected', d.choice === 'dicta');
    }
    function pick(choice) {
      if (d.choice === choice) return;
      if (nikudIsStale()) { dropStaleNikud(); return; }
      if (!RV.setWord(d.slot, d.index, choice === 'ai' ? d.ai : d.dicta)) { toast('לא הצלחתי להחליף את המילה.'); return; }
      d.choice = choice;
      state.nikudVerified = RV.signature(state.lesson);
      show();
      changed();
    }
    aiBtn.addEventListener('click', function () { pick('ai'); });
    dictaBtn.addEventListener('click', function () { pick('dicta'); });
    show();
    return { node: node, pick: pick };
  }

  /* ---------- Step 6: link ---------- */

  function renderLink() {
    var lesson = state.lesson;
    var url = new URL('play.html', location.href);
    url.search = '';
    url.hash = L.encode(lesson);
    state.link = url.href;
    $('linkBox').textContent = state.link;
    $('linkInfo').textContent = 'אורך הקישור: ' + state.link.length.toLocaleString('he-IL') + ' תווים.' +
      (state.link.length > 8000 ? ' הקישור ארוך; אם הוא לא נפתח, נסו לקצר את הסיפור.' : '');
    var title = H.stripNikud(lesson.title || 'שיעור קריאה');
    $('waLink').href = 'https://wa.me/?text=' + encodeURIComponent('📖 ' + title + '\n' + state.link);
    $('openLink').href = state.link;
  }

  /* ---------- Wire up ---------- */

  function init() {
    levelRadios('level', window.Levels.DEFAULT).forEach(function (n) { $('levelChoices').appendChild(n); });
    fillForm(load(STORE_SETTINGS));
    document.querySelectorAll('input[name="wordsMode"]').forEach(function (r) { r.addEventListener('change', syncWordsMode); });
    $('settingsForm').addEventListener('submit', submitSettings);

    $('copyPrompt').addEventListener('click', function () { copy($('promptText').textContent, 'הפרומפט הועתק! עכשיו הדביקו בצ׳אט.'); });
    $('parseBtn').addEventListener('click', parseResponse);
    $('responseFileBtn').addEventListener('click', function () { $('responseFileInput').click(); });
    $('responseFileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadResponseFile(this.files[0]);
      this.value = '';
    });
    $('copyFix').addEventListener('click', function () { copy($('fixText').textContent); });
    $('continueAnyway').addEventListener('click', function () {
      if (pendingLesson) acceptLesson(pendingLesson, state.request);
    });

    $('makeLink').addEventListener('click', function () {
      if (L.check(state.lesson, state.request).errors.length) return;
      showStep(5);
    });
    $('skipCheck').addEventListener('click', goToLink);
    $('toLink').addEventListener('click', goToLink);
    $('makeReviewPrompt').addEventListener('click', makeReviewPrompt);
    $('copyReviewPrompt').addEventListener('click', function () { copy($('reviewPromptText').textContent, 'הפרומפט הועתק! הדביקו בצ׳אט.'); });
    $('parseReview').addEventListener('click', parseReview);
    $('copyPlain').addEventListener('click', function () {
      copy(RV.plainText(state.lesson), 'הטקסט הועתק בלי ניקוד. עכשיו הדביקו אותו בנקדן של דיקטה.');
    });
    $('autoNikud').addEventListener('click', autoNikud);
    $('compareNikud').addEventListener('click', compareNikud);
    $('copyLink').addEventListener('click', function () { copy(state.link, 'הקישור הועתק!'); });
    $('downloadJson').addEventListener('click', downloadJson);
    $('printBtn').addEventListener('click', function () {
      U.clear($('printArea')).appendChild(window.Print.build(state.lesson, { answers: $('printAnswers').checked }));
      window.print();
    });
    $('newLesson').addEventListener('click', function () {
      $('response').value = '';
      U.clear($('parseMsgs'));
      $('fixBox').hidden = true;
      $('continueAnyway').hidden = true;
      state.maxStep = 1;
      showStep(1);
    });

    $('loadJsonBtn').addEventListener('click', function () { $('loadJsonInput').click(); });
    $('loadJsonInput').addEventListener('change', function () {
      if (this.files && this.files[0]) loadJsonFile(this.files[0]);
      this.value = '';
    });

    var draft = load(STORE_DRAFT);
    if (draft && draft.lesson) {
      var c = L.coerce(draft.lesson);
      if (c.lesson) {
        $('resumeDraft').hidden = false;
        $('resumeDraft').addEventListener('click', function () {
          state.maxStep = 3;
          acceptLesson(c.lesson, draft.request || null, draft.nikudVerified);
        });
      }
    }

    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { showStep(+b.dataset.go); });
    });
    $('steps').addEventListener('click', function (e) {
      var li = e.target.closest('li');
      if (li && +li.dataset.step <= state.maxStep) showStep(+li.dataset.step);
    });

    showStep(1);
  }

  init();
})();
