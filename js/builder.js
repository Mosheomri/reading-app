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
  var MAX_STORY_WORDS = 2000;
  var LONG_LINK = 8000; // characters; above this the link step suggests checking it before sending

  var state = {
    step: 1,
    maxStep: 1,
    settings: null,   // last submitted form values
    request: null,    // what was asked from the AI, for validation; null for loaded files
    lesson: null,
    nikudVerified: null, // Review.signature of the text that was last vocalized with Dicta
    nikudOnce: false,    // Dicta was applied to this lesson before: later, only the lines that need it go to Dicta
    nikudLines: null,    // the vocalized lines (Review.nikudLines().vocal) when Dicta's nikud was last valid
    second: null,        // second opinion on Dicta's nikud from Gemini (see startSecondOpinion)
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
      if (state.lesson) {
        save(STORE_DRAFT, { lesson: state.lesson, request: state.request, nikudVerified: state.nikudVerified, nikudOnce: state.nikudOnce, nikudLines: state.nikudLines,
          second: state.second && state.second.status === 'done' ? { status: 'done', marks: state.second.marks, source: state.second.source } : null });
      }
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
      level: document.querySelector('input[name="level"]:checked').value,
      genre: currentGenre(),
      exercises: readExerciseCounts()
    };
  }

  /* Question types: a checkbox and a count per type (js/levels.js). */

  function exerciseRows() {
    return window.Levels.TYPES.map(function (t) {
      var count = el('input', { type: 'number', class: 'narrow', min: 0, max: window.Levels.MAX_PER_TYPE, step: 1,
        inputmode: 'numeric', 'data-count': t.id, 'aria-label': 'כמה שאלות: ' + t.label });
      var box = el('input', { type: 'checkbox', 'data-type': t.id });
      box.addEventListener('change', function () {
        if (box.checked && !(+count.value > 0)) count.value = window.Levels.exerciseDefaults(currentLevel(), currentGenre())[t.id] || 1;
        if (!box.checked) count.value = 0;
      });
      count.addEventListener('input', function () { box.checked = +count.value > 0; });
      return el('div', { class: 'ex-type', 'data-type': t.id },
        el('label', { class: 'choice' }, box, ' ' + t.label), count);
    });
  }

  function currentLevel() {
    var lv = document.querySelector('input[name="level"]:checked');
    return lv ? lv.value : window.Levels.DEFAULT;
  }

  function currentGenre() {
    var g = document.querySelector('input[name="genre"]:checked');
    return window.Levels.genre(g && g.value);
  }

  // The default question counts for the level and kind of text chosen in the form.
  function defaultCounts() {
    return window.Levels.exerciseDefaults(currentLevel(), currentGenre());
  }

  // Radio buttons for the kinds of text (story / informational). Returns the label elements.
  function genreRadios(name, checkedId, onChange) {
    return window.Levels.GENRES.map(function (g) {
      var radio = el('input', { type: 'radio', name: name, value: g.id, checked: g.id === checkedId });
      if (onChange) radio.addEventListener('change', function () { onChange(g.id); });
      return el('label', { class: 'choice' }, radio, ' ' + g.label);
    });
  }

  function setExerciseCounts(counts) {
    window.Levels.TYPES.forEach(function (t) {
      var n = Math.max(0, Math.min(window.Levels.MAX_PER_TYPE, parseInt(counts[t.id], 10) || 0));
      document.querySelector('[data-count="' + t.id + '"]').value = n;
      document.querySelector('input[data-type="' + t.id + '"]').checked = n > 0;
    });
  }

  function readExerciseCounts() {
    var out = {};
    window.Levels.TYPES.forEach(function (t) {
      var v = parseInt(document.querySelector('[data-count="' + t.id + '"]').value, 10);
      out[t.id] = isFinite(v) ? v : 0;
    });
    return out;
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
    var gn = document.querySelector('input[name="genre"][value="' + window.Levels.genre(s.genre) + '"]');
    if (gn) gn.checked = true;
    // Saved before question types could be chosen: the level's defaults.
    setExerciseCounts(s.exercises || defaultCounts());
    syncWordsMode();
  }

  function syncWordsMode() {
    var list = document.querySelector('input[name="wordsMode"]:checked').value === 'list';
    $('wordsListBox').hidden = !list;
    $('wordsNumberBox').hidden = list;
  }

  function submitSettings(e) {
    e.preventDefault();
    cancelAuto();
    if (readSettings()) showStep(2);
  }

  // Validates the form and builds the prompt (state.request, #promptText). Returns false on errors.
  function readSettings() {
    var f = readForm();
    var errors = [];
    if (!f.topic) errors.push('כתבו נושא לסיפור.');
    if (!(f.length >= 20 && f.length <= MAX_STORY_WORDS)) errors.push('אורך הסיפור צריך להיות בין 20 ל-' + MAX_STORY_WORDS + ' מילים.');
    var words = parseWordList(f.wordListText);
    if (f.wordsMode === 'number' && !(f.wordCount >= 2 && f.wordCount <= 10)) errors.push('מספר מילות היעד צריך להיות בין 2 ל-10.');
    if (f.wordsMode === 'list' && (words.length < 2 || words.length > 10)) errors.push('כתבו בין 2 ל-10 מילות יעד (כתבתם ' + words.length + ').');
    var counts = f.exercises;
    var bad = window.Levels.TYPES.filter(function (t) {
      var n = counts[t.id];
      return !(Number.isInteger(n) && n >= 0 && n <= window.Levels.MAX_PER_TYPE);
    });
    if (bad.length) errors.push('מספר השאלות מכל סוג צריך להיות בין 0 ל-' + window.Levels.MAX_PER_TYPE + ' (' + bad.map(function (t) { return t.label; }).join(', ') + ').');
    else if (!window.Levels.TYPES.some(function (t) { return counts[t.id] > 0; })) errors.push('בחרו לפחות סוג שאלות אחד.');

    var msgs = U.clear($('settingsMsgs'));
    if (errors.length) { msgs.appendChild(msgBox('error', null, errors)); return false; }

    save(STORE_SETTINGS, f);
    state.settings = f;
    state.request = { topic: f.topic, length: f.length, level: f.level, genre: f.genre, wordsMode: f.wordsMode, wordCount: f.wordCount,
      words: words, exercises: f.exercises };
    $('promptText').textContent = window.buildPrompt(state.request);
    return true;
  }

  /* ---------- Step 3: parse response ---------- */

  var pendingLesson = null;

  // The checks on an AI response, pasted or from Gemini.
  // Returns {error, items, fix} when there is no lesson to edit, else {lesson, errors, warnings, problems}.
  function analyzeResponse(text) {
    if (!text.trim()) return { error: 'לא הודבקה תשובה.' };

    var ex = L.extractJson(text);
    if (ex.error) {
      var noJson = ex.error === 'no-json';
      return {
        error: noJson ? 'לא מצאתי JSON בתשובה. ודאו שהעתקתם את כל התשובה.' : 'ה-JSON בתשובה לא תקין. ייתכן שהתשובה נקטעה באמצע.',
        fix: noJson
          ? 'החזר את התשובה כ-JSON בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו, במבנה שביקשתי.'
          : 'ה-JSON ששלחת לא תקין או נקטע באמצע. החזר שוב את ה-JSON המלא בתוך בלוק קוד אחד (```json), בלי שום טקסט לפניו או אחריו.'
      };
    }

    var c = L.coerce(ex.value);
    if (!c.lesson) return { error: 'חסרים חלקים בשיעור:', items: c.fatal, fix: L.fixMessage(c.fatal) };

    var lesson = c.lesson;
    if (state.settings) {
      lesson.nikudMode = state.settings.nikud;
      lesson.level = state.settings.level;
      lesson.genre = window.Levels.genre(state.settings.genre);
      if (!lesson.topic) lesson.topic = state.settings.topic;
    }
    // Automatic fixes are shown as warnings but not sent back to the AI.
    var notes = c.notes.concat(L.sortOrderExercises(lesson));
    var res = L.check(lesson, state.request);
    return { lesson: lesson, errors: res.errors, warnings: notes.concat(res.warnings), problems: res.errors.concat(res.warnings) };
  }

  function parseResponse() {
    cancelAuto();
    var msgs = U.clear($('parseMsgs'));
    $('fixBox').hidden = true;
    $('continueAnyway').hidden = true;
    pendingLesson = null;

    var a = analyzeResponse($('response').value);
    if (a.error) {
      msgs.appendChild(msgBox('error', a.error, a.items));
      if (a.fix) showFix(a.fix);
      return;
    }
    var lesson = a.lesson;
    var res = { errors: a.errors };
    var warnings = a.warnings;
    if (!res.errors.length && !warnings.length) {
      acceptLesson(lesson, state.request);
      return;
    }
    if (res.errors.length) msgs.appendChild(msgBox('error', 'צריך לתקן:', res.errors));
    if (warnings.length) msgs.appendChild(msgBox('warn', 'שימו לב:', warnings));
    var problems = a.problems;
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
    state.nikudOnce = !!nikudVerified;
    state.nikudLines = nikudVerified ? vocalLines() : null;
    cancelSecondOpinion();
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
      cancelAuto();
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
    // A focused field removed by a re-render still fires "change"; by then the lesson may hold a newer value.
    input.addEventListener('change', function () {
      if (!input.isConnected) return;
      onChange(H.normalize(input.value).trim());
      changed();
    });
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
    root.appendChild(el('div', { class: 'field' },
      el('span', { class: 'label' }, 'סוג הטקסט'),
      el('div', { class: 'choices' }, genreRadios('edGenre', lesson.genre, function (id) { lesson.genre = id; changed(); }))));

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
      window.Levels.TYPES.map(function (t) {
        return el('button', { type: 'button', class: 'btn small', onclick: function () {
          lesson.exercises.push(newExercise(t.id)); changed(true);
        } }, '+ ' + L.TYPE_NAMES[t.id]);
      })));

    refreshPreview();
  }

  function newPart(style) {
    return style === 'open' ? { question: '', sampleAnswer: '' } : { question: '', options: ['', '', ''], answer: 0 };
  }

  function newExercise(type) {
    if (type === 'mcq') return { type: 'mcq', question: '', options: ['', '', ''], answer: 0 };
    if (type === 'tf') return { type: 'tf', statement: '', answer: true };
    if (type === 'fill') return { type: 'fill', sentence: '___', options: ['', '', ''], answer: 0 };
    if (type === 'open') return { type: 'open', question: '', sampleAnswer: '' };
    if (type === 'locate') return { type: 'locate', question: '', sentence: '' };
    if (type === 'message') {
      // The parts' kind follows the lesson's level (multiple choice up to ב׳, open from ג׳).
      var level = window.Levels.get(state.lesson.level);
      var style = level ? level.messageStyle : 'mcq';
      return { type: 'message', visible: newPart(style), hidden: newPart(style) };
    }
    return { type: 'order', sentences: ['', '', '', ''] };
  }

  // Options with a radio for the right one, for mcq / fill and multiple-choice message parts.
  function optionsEditor(q) {
    var opts = el('div', { class: 'field' }, el('span', { class: 'label' }, 'אפשרויות (סמנו את הנכונה)'));
    var group = 'ans_' + Math.random().toString(36).slice(2, 9);
    q.options.forEach(function (o, j) {
      var radio = el('input', { type: 'radio', name: group, checked: q.answer === j, 'aria-label': 'תשובה נכונה' });
      radio.addEventListener('change', function () { q.answer = j; changed(); });
      opts.appendChild(el('div', { class: 'opt-row' },
        radio,
        textInput(o, function (v) { q.options[j] = v; }),
        removeBtn('מחיקת אפשרות', function () {
          q.options.splice(j, 1);
          if (q.answer === j) q.answer = -1; else if (q.answer > j) q.answer--;
          changed(true);
        })));
    });
    if (q.options.length < 4) {
      opts.appendChild(el('button', { type: 'button', class: 'btn small', onclick: function () {
        q.options.push(''); changed(true);
      } }, '+ אפשרות'));
    }
    return opts;
  }

  function textArea(value, onChange, rows) {
    var ta = el('textarea', { rows: rows || 2, value: value || '', spellcheck: 'true', lang: 'he' });
    ta.addEventListener('input', function () { onChange(H.normalize(ta.value)); changed(); });
    return ta;
  }

  function fieldOf(label, input) {
    return el('div', { class: 'field' }, el('label', null, label), input);
  }

  // The answer sentence of a locate exercise: typed, or picked from the story's sentences.
  function locateEditor(box, ex) {
    var lesson = state.lesson;
    var status = el('div', { class: 'hint' });
    var input = textInput(ex.sentence, function (v) { ex.sentence = v; syncStatus(); });
    var pick = el('select', { 'aria-label': 'בחירת משפט מהסיפור' });
    function syncStatus() {
      var found = ex.sentence && L.findSentence(L.bareWords(lesson.story), ex.sentence) !== -1;
      status.textContent = !ex.sentence ? 'כתבו את המשפט מהסיפור שעונה על השאלה, או בחרו אותו מהרשימה.'
        : found ? 'המשפט נמצא בסיפור ✓' : '⚠️ המשפט לא נמצא בסיפור. הילד צריך ללחוץ עליו בסיפור, אז הוא חייב להופיע בו.';
      status.className = 'hint' + (ex.sentence && !found ? ' bad' : '');
    }
    pick.appendChild(el('option', { value: '' }, 'בחירה מתוך הסיפור…'));
    L.sentencesOf(lesson.story).forEach(function (s) { pick.appendChild(el('option', { value: s }, H.stripNikud(s))); });
    pick.addEventListener('change', function () {
      if (!pick.value) return;
      // A field still focused would report its own value after the re-render below; let it do so first.
      var active = document.activeElement;
      if (active && active !== pick && active.blur) active.blur();
      ex.sentence = pick.value;
      changed(true);
    });
    box.appendChild(fieldOf('שאלה', textInput(ex.question, function (v) { ex.question = v; })));
    box.appendChild(el('div', { class: 'field' }, el('label', null, 'משפט התשובה (מתוך הסיפור)'), input, pick, status));
    syncStatus();
  }

  // The two parts of a message, each with a choice between multiple choice and open.
  function messageEditor(box, ex) {
    [['visible', 'המסר הגלוי (מה כתוב בסיפור)'], ['hidden', 'המסר הסמוי (מה הסיפור מלמד)']].forEach(function (k) {
      var part = ex[k[0]];
      var isMcq = !!part.options;
      var group = 'style_' + Math.random().toString(36).slice(2, 9);
      var styles = el('div', { class: 'choices' }, [['mcq', 'אמריקאית'], ['open', 'פתוחה']].map(function (st) {
        var radio = el('input', { type: 'radio', name: group, checked: (st[0] === 'mcq') === isMcq });
        radio.addEventListener('change', function () {
          var q = part.question;
          var fresh = newPart(st[0]);
          fresh.question = q;
          ex[k[0]] = fresh;
          changed(true);
        });
        return el('label', { class: 'choice' }, radio, ' ' + st[1]);
      }));
      var pbox = el('div', { class: 'part-edit' }, el('h4', null, k[1]), styles,
        fieldOf('שאלה', textInput(part.question, function (v) { part.question = v; })));
      if (isMcq) pbox.appendChild(optionsEditor(part));
      else pbox.appendChild(fieldOf('תשובה לדוגמה', textArea(part.sampleAnswer, function (v) { part.sampleAnswer = v; })));
      box.appendChild(pbox);
    });
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
      box.appendChild(optionsEditor(ex));
    } else if (ex.type === 'open') {
      box.appendChild(fieldOf('שאלה', textInput(ex.question, function (v) { ex.question = v; })));
      box.appendChild(fieldOf('תשובה לדוגמה (הילד יראה אותה אחרי שיענה)', textArea(ex.sampleAnswer, function (v) { ex.sampleAnswer = v; })));
    } else if (ex.type === 'locate') {
      locateEditor(box, ex);
    } else if (ex.type === 'message') {
      messageEditor(box, ex);
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
    if (res.warnings.length) msgs.appendChild(msgBox('warn', 'שימו לב:', res.warnings.map(function (w) {
      if (w !== L.LINES_WARNING) return w;
      return el('span', null, w + ' ', el('button', { type: 'button', class: 'btn small', id: 'joinParagraphs', onclick: joinParagraphs }, 'אחד לפסקאות'));
    })));
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
    p.appendChild(el('h2', { style: 'text-align:center' }, slotText(lesson, 'title', lesson.title, mark)));
    p.appendChild(el('div', { class: 'target-chips' }, lesson.targetWords.map(function (t, i) {
      return el('span', { class: 'chip' }, U.emojiShown(t.emoji) ? t.emoji + ' ' : null, slotText(lesson, 'targetWords[' + i + '].word', t.word, mark));
    })));
    var second = secondBox(true);
    if (second) p.appendChild(second);
    var storyMarks = marksOf('story');
    p.appendChild(el('div', { class: 'story' }, R.story(lesson, null, mark, storyMarks && function (span, index) {
      if (storyMarks[index]) decorateMark(span, storyMarks[index]);
    })));
    p.appendChild(el('h3', { style: 'margin-top:16px' }, 'תרגילים'));
    lesson.exercises.forEach(function (ex, i) {
      if (ex.unknown) return;
      p.appendChild(exercisePreview(lesson, ex, i, mark));
    });
  }

  // Joins the one-sentence lines of the story into paragraphs (the button on the "lines" warning).
  function joinParagraphs() {
    state.lesson.story = L.joinParagraphs(state.lesson.story);
    changed(true);
    toast('השורות אוחדו לפסקאות.');
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
      var list = [missing.slice(0, 15).join(', ') + (missing.length > 15 ? ' ועוד ' + (missing.length - 15) : '')];
      return state.nikudOnce
        ? msgBox('info', 'מילים בלי ניקוד (מסומנות באדום), שנוספו אחרי הניקוד או שדיקטה לא ניקדה. ' +
            'הן ינוקדו בדיקטה במעבר לשלב הבדיקה (רק השורות שלהן):', list)
        : msgBox('info', 'מילים בלי ניקוד (מסומנות באדום). הן ינוקדו בשלב הניקוד בדיקטה:', list);
    }
    if (!nikudDone()) {
      return msgBox('info', state.nikudOnce
        ? 'הטקסט השתנה מאז הניקוד בדיקטה. בשלב הבא בודקים אותו שוב.'
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
    var base = 'exercises[' + i + ']';
    // field: the key of the text in Review.slots, for the second-opinion marks.
    function t(field, s) { return slotText(lesson, base + '.' + field, s, mark); }
    function optionList() {
      return el('ol', null, ex.options.map(function (o, j) {
        return el('li', { class: j === ex.answer ? 'correct' : '' }, t('options[' + j + ']', o), j === ex.answer ? ' ✓' : '');
      }));
    }
    if (ex.type === 'mcq') {
      box.appendChild(el('div', null, num, t('question', ex.question)));
      box.appendChild(optionList());
    } else if (ex.type === 'tf') {
      box.appendChild(el('div', null, num, t('statement', ex.statement)));
      box.appendChild(el('div', { class: 'correct' }, ex.answer === true ? 'נכון ✓' : ex.answer === false ? 'לא נכון ✓' : ''));
    } else if (ex.type === 'fill') {
      box.appendChild(el('div', null, num, fillText(lesson, base + '.sentence', ex.sentence, mark)));
      box.appendChild(optionList());
    } else if (ex.type === 'order') {
      box.appendChild(el('div', null, num + 'סידור משפטים (הילד יקבל אותם מעורבבים):'));
      box.appendChild(el('ol', null, ex.sentences.map(function (s, j) { return el('li', null, t('sentences[' + j + ']', s)); })));
    } else if (ex.type === 'open') {
      box.appendChild(el('div', null, num, t('question', ex.question)));
      box.appendChild(el('div', { class: 'sample' }, el('span', { class: 'muted' }, 'תשובה לדוגמה: '), t('sampleAnswer', ex.sampleAnswer)));
    } else if (ex.type === 'locate') {
      var found = ex.sentence && L.findSentence(L.bareWords(lesson.story), ex.sentence) !== -1;
      box.appendChild(el('div', null, num, t('question', ex.question)));
      box.appendChild(el('div', { class: found ? 'correct' : 'bad' },
        el('span', { class: 'muted' }, 'הילד לוחץ בסיפור על: '), t('sentence', ex.sentence), found ? ' ✓' : ' ⚠️ לא נמצא בסיפור'));
    } else if (ex.type === 'message') {
      box.appendChild(el('div', null, num + 'מסר גלוי ומסר סמוי:'));
      [['visible', 'גלוי'], ['hidden', 'סמוי']].forEach(function (k) {
        var part = ex[k[0]];
        var pb = el('div', { class: 'part' }, el('strong', null, k[1] + ': '), t(k[0] + '.question', part.question));
        if (part.options) {
          pb.appendChild(el('ol', null, part.options.map(function (o, j) {
            return el('li', { class: j === part.answer ? 'correct' : '' }, t(k[0] + '.options[' + j + ']', o), j === part.answer ? ' ✓' : '');
          })));
        } else {
          pb.appendChild(el('div', { class: 'sample' }, el('span', { class: 'muted' }, 'תשובה לדוגמה: '), t(k[0] + '.sampleAnswer', part.sampleAnswer)));
        }
        box.appendChild(pb);
      });
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

  // Dicta's nikud is on the text as it is now (also after choosing between versions of a word).
  function markNikudVerified() {
    state.nikudVerified = RV.signature(state.lesson);
    state.nikudOnce = true;
    state.nikudLines = vocalLines();
  }

  function vocalLines() {
    return RV.nikudLines(state.lesson).map(function (l) { return l.vocal; });
  }

  // After a first Dicta run: the lines to send to Dicta now (changed since then, or with words without nikud).
  function linesToDicta() {
    return RV.linesToNikud(state.lesson, state.nikudLines);
  }

  // The Dicta result is tied to the text it was applied to.
  function nikudIsStale() {
    return state.nikudVerified !== null && state.nikudVerified !== RV.signature(state.lesson);
  }

  // A change after Dicta: only the changed lines (and lines with words without nikud) go to Dicta again
  // (renikudIfNeeded). A change undone leaves nothing to send, and the nikud is valid again.
  function dropStaleNikud() {
    if (!nikudIsStale()) return;
    var lines = linesToDicta();
    if (state.nikudOnce && !lines.length) { markNikudVerified(); saveDraftSoon(); return; }
    state.nikudVerified = null;
    saveDraftSoon();
    clearNikudResults();
    $('nikudMsgs').appendChild(staleNikudMsg(lines.length));
  }

  function linesLabel(n) { return n === 1 ? 'שורה אחת' : n + ' שורות'; }

  // What to do after a change, in the words of this step.
  function staleNikudMsg(n) {
    if (!state.nikudOnce) return msgBox('info', 'הטקסט השתנה מאז הניקוד. נקדו שוב בדיקטה.');
    return msgBox('info', 'הטקסט השתנה אחרי הניקוד (' + linesLabel(n) + '). בדיקטה ינוקדו רק השורות שהשתנו:',
      [DB.known() ? 'זה קורה אוטומטית בלחיצה הבאה (סיום אישור ההצעות, מעבר לבדיקה או יצירת קישור), או בכפתור "נקד אוטומטית בדיקטה".'
        : 'לחצו על "נקד אוטומטית בדיקטה", או העתיקו (רק השורות שהשתנו) ונקדו ידנית.']);
  }

  // Inside a click (window.open needs one) and with the Dicta bridge known: vocalize the lines that need it now.
  function renikudIfNeeded() {
    if (!state.lesson || !nikudRequired() || !state.nikudOnce || DB.running() || !DB.known()) return;
    if (!linesToDicta().length) return;
    if ($('reviewList').querySelector('.review-item:not(.accepted):not(.rejected)')) return; // after the last decision
    var activation = navigator.userActivation;
    if (activation && !activation.isActive) return;
    autoNikud();
  }

  // Words Dicta left without nikud: listed, and the button sends only their lines.
  function warnUnvocalized(box) {
    if (state.lesson.nikudMode !== 'full') return;
    var missing = L.unvocalizedWords(state.lesson);
    if (!missing.length) return;
    box.appendChild(msgBox('warn', 'דיקטה לא ניקדה ' + (missing.length === 1 ? 'מילה אחת' : missing.length + ' מילים') + ':',
      [missing.slice(0, 15).join(', ') + (missing.length > 15 ? ' ועוד ' + (missing.length - 15) : ''),
        'לחצו שוב על "נקד אוטומטית בדיקטה": יישלחו רק השורות שלהן.']));
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
    renikudIfNeeded();
    if (nikudRequired() && nikudDone() && !$('nikudMsgs').children.length) {
      $('nikudMsgs').appendChild(msgBox('ok', 'הטקסט מנוקד ✓'));
    }
  }

  function goToLink() {
    dropStaleNikud();
    var blockers = linkBlockers();
    if (blockers.indexOf('NIKUD') !== -1 && state.nikudOnce && DB.known() && !DB.running()) {
      showStep(5); // vocalizes the changed lines (enterCheckStep), then the teacher makes the link
      return;
    }
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

  // Returns the number of suggestions shown, or -1 when the response could not be read.
  function parseReview() {
    var msgs = U.clear($('reviewMsgs'));
    var list = U.clear($('reviewList'));
    var text = $('reviewResponse').value;
    if (!text.trim()) { msgs.appendChild(msgBox('error', 'לא הודבקה תשובה.')); return -1; }
    var r = RV.parseSuggestions(text);
    if (r.error) { msgs.appendChild(msgBox('error', r.error, ['ודאו שהעתקתם את כל התשובה, או בקשו מהבינה להחזיר JSON בבלוק קוד.'])); return -1; }
    if (!r.items.length) { msgs.appendChild(msgBox('ok', 'הבינה לא מצאה מה לתקן ✓')); return 0; }
    msgs.appendChild(msgBox('info', 'נמצאו ' + r.items.length + ' הצעות. אשרו או דחו כל הצעה.'));
    r.items.forEach(function (item) { list.appendChild(reviewCard(item)); });
    return r.items.length;
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
        ? el('p', { class: 'small fix-note' }, 'ℹ️ התיקון בלי ניקוד. אחרי האישור השורה שלו תנוקד שוב בדיקטה (רק השורות שהשתנו).')
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
      reviewDecided();
    }
    approve.addEventListener('click', function () {
      if (!RV.applySuggestion(state.lesson, item)) { warn.hidden = false; approve.disabled = true; return; }
      changed();
      dropStaleNikud();
      done('אושר ✓', 'accepted');
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
    // After a first Dicta run: only the lines that need it. Nothing changed: the whole text again (the teacher asked).
    var lines = state.nikudOnce ? linesToDicta() : null;
    if (lines && !lines.length) lines = null;
    btn.disabled = true;
    var what = lines ? 'את ' + (lines.length === 1 ? 'השורה שהשתנתה' : 'השורות שהשתנו (' + lines.length + ')') : 'את הטקסט';
    if (auto && auto.stages.nikud.state !== 'active') stage('nikud', 'active', lines ? 'מנקד בדיקטה ' + what + '…' : '');
    DB.start(lines ? lines.map(function (l) { return l.text; }).join('\n') : RV.plainText(state.lesson), {
      status: function (kind, info) {
        status.textContent = kind === 'opening' ? 'פותחים את דיקטה בחלון חדש…'
          : 'דיקטה מנקדת ' + what + '…' + (info.parts > 1 ? ' (חלק ' + info.part + ' מתוך ' + info.parts + ')' : '');
        if (!status.parentNode) msgs.appendChild(status);
      },
      result: function (text) {
        btn.disabled = false;
        U.clear(msgs);
        if (RV.signature(state.lesson) !== sig) {
          msgs.appendChild(msgBox('warn', 'הטקסט השתנה בזמן הניקוד. לחצו שוב על "נקד אוטומטית בדיקטה".'));
          nikudStageFailed();
          return;
        }
        $('dictaText').value = text;
        if (lines) applyLineNikud(lines, text); else compareNikud();
      },
      fail: function (reason, message) {
        btn.disabled = false;
        U.clear(msgs).appendChild(autoNikudFailure(reason, message));
        nikudStageFailed();
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
  // After a first Dicta run, the pasted text is the lines that needed nikud ("העתק" copies only them).
  function compareNikud() {
    if (state.nikudOnce) {
      var lines = linesToDicta();
      var n = 0;
      lines.forEach(function (l) { n += l.refs.length; });
      // The pasted text is the changed lines (what "העתק" copies now), or else the whole text as before.
      if (lines.length && RV.words($('dictaText').value).length === n) { applyLineNikud(lines, $('dictaText').value); return; }
    }
    var msgs = U.clear($('nikudMsgs'));
    var list = U.clear($('nikudList'));
    U.clear($('checkStepMsgs'));
    var r = RV.compareNikud(state.lesson, $('dictaText').value);
    if (r.error) { msgs.appendChild(msgBox('error', r.error, r.details)); nikudStageFailed(); return; }
    var filled = RV.applyFills(r.fills);
    markNikudVerified();
    changed();
    syncCheckStep();
    nikudStageDone();
    warnUnvocalized(msgs);
    startSecondOpinion(); // only with a Gemini key; in the background
    if (filled) msgs.appendChild(msgBox('ok', 'הניקוד של דיקטה הוחל על ' + (filled === 1 ? 'מילה אחת' : filled + ' מילים') + ' ✓'));
    if (!r.diffs.length) {
      if (!filled) msgs.appendChild(msgBox('ok', 'הניקוד זהה לניקוד של דיקטה ✓'));
      return;
    }

    showNikudDiffs(r.diffs, msgs, list);
  }

  // Vocalized words whose nikud (or spelling) differs from Dicta's: the teacher picks a version for each.
  function showNikudDiffs(diffs, msgs, list) {
    msgs.appendChild(msgBox('info', 'נמצאו ' + diffs.length + ' מילים מנוקדות שהניקוד שלהן שונה (או הכתיב). בחרו לכל מילה את הגרסה הנכונה.'));
    var acceptAll = el('button', { type: 'button', class: 'btn small' }, 'קבל את כל דיקטה');
    list.appendChild(el('div', { class: 'row', style: 'margin-bottom:10px' }, acceptAll));
    var rows = diffs.map(nikudRow);
    rows.forEach(function (row) { list.appendChild(row.node); });
    acceptAll.addEventListener('click', function () {
      rows.forEach(function (row) { row.pick('dicta'); });
    });
  }

  // Dicta's nikud for some lines only (text added after the first run, or words Dicta left without nikud).
  function applyLineNikud(lines, text) {
    var msgs = U.clear($('nikudMsgs'));
    var list = U.clear($('nikudList'));
    U.clear($('checkStepMsgs'));
    var r = RV.lineFills(state.lesson, lines, text);
    if (r.error) { msgs.appendChild(msgBox('error', r.error, r.details)); nikudStageFailed(); return; }
    var filled = RV.applyFills(r.fills);
    markNikudVerified();
    changed();
    syncCheckStep();
    nikudStageDone();
    msgs.appendChild(msgBox('ok', 'דיקטה ניקדה ' + (lines.length === 1 ? 'את השורה שהשתנתה' : 'את ' + lines.length + ' השורות שהשתנו') +
      ' (' + (filled === 1 ? 'מילה אחת' : filled + ' מילים') + ') ✓'));
    warnUnvocalized(msgs);
    if (r.diffs.length) showNikudDiffs(r.diffs, msgs, list);
    // The second opinion on these lines only; marks elsewhere stay.
    var ids = {};
    lines.forEach(function (l) { ids[l.refs[0].key + '#' + l.refs[0].index] = true; });
    startSecondOpinion(RV.nikudLines(state.lesson).filter(function (l) { return ids[l.refs[0].key + '#' + l.refs[0].index]; }));
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
      markNikudVerified();
      show();
      changed();
    }
    aiBtn.addEventListener('click', function () { pick('ai'); });
    dictaBtn.addEventListener('click', function () { pick('dicta'); });
    show();
    return { node: node, pick: pick };
  }

  /* 3. Second opinion on Dicta's nikud: another AI vocalizes the same lines, words read differently are marked
     in the preview for the teacher. Automatic with a Gemini key (in the background, never blocking the lesson),
     or by hand in any chat (copy a prompt, paste the answer), always available. */

  var secondRuns = 0;
  var lastMark = null; // the mark opened last, for "הבאה"

  // state.second: null, or {status: 'running' | 'done' | 'failed', message, source: 'gemini' | 'manual',
  //   marks: [{key, index, word, dicta, gemini (the other AI's word), checked}]}
  // only: some lines (Review.nikudLines entries) after a partial Dicta run; the marks on other lines stay.
  function startSecondOpinion(only) {
    var key = G.getKey();
    if (!key || !state.lesson || !nikudRequired() || !nikudDone()) return;
    if (only && !only.length) return;
    var run = ++secondRuns;
    var lesson = state.lesson;
    var before = only && state.second && state.second.status === 'done' ? state.second : null;
    var chunks = RV.nikudChunks(only || RV.nikudLines(lesson), G.config.nikudChunkChars);
    var sent = [];
    var got = [];
    var i = 0;
    var current = function () { return run === secondRuns && state.lesson === lesson; };
    state.second = { status: 'running', marks: [] };
    renderSecond();
    function next() {
      if (i >= chunks.length) return Promise.resolve();
      var chunk = chunks[i++];
      var texts = chunk.map(function (l) { return l.text; });
      return G.checkNikud(key, RV.buildNikudPrompt(texts)).then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { /* not JSON: this chunk is not compared */ }
        var back = data && Array.isArray(data.lines) && data.lines.length === texts.length ? data.lines : null;
        if (!back) console.warn('[Gemini] nikud-check: the answer does not have the ' + texts.length + ' lines sent; that part is not compared.');
        chunk.forEach(function (l, j) { sent.push(l); got.push(back ? back[j] : null); });
        if (current()) return next();
      });
    }
    next().then(function () {
      if (!current()) return;
      if (!got.some(function (g) { return g != null; })) throw new Error('Gemini החזיר מספר שורות שונה מהטקסט ששלחנו.');
      finishSecond(sent, got, before, 'gemini');
    }).catch(function (e) {
      if (!current()) return;
      state.second = { status: 'failed', message: (e && e.message) || '', marks: [], source: 'gemini' };
      renderSecond();
      // The manual way, right away: a chat needs no key and no quota.
      $('secondManual').open = true;
    });
  }

  // Compares the lines sent with the other AI's lines and marks the words that read differently (both ways).
  // before: the earlier result whose marks on other lines stay (a partial run), or null.
  function finishSecond(sent, got, before, source) {
    var r = RV.compareSecond(state.lesson, sent, got);
    r.marks.forEach(function (m) { m.checked = false; });
    var marks = r.marks;
    var diffs = r.diffs;
    if (before) {
      var redone = {};
      sent.forEach(function (l) { l.refs.forEach(function (ref) { redone[ref.key + '#' + ref.index] = true; }); });
      var keep = function (m) { return !redone[m.key + '#' + m.index]; };
      marks = RV.liveMarks(state.lesson, before.marks).filter(keep).concat(marks);
      diffs = (before.diffs || []).filter(keep).concat(diffs);
    }
    state.second = { status: 'done', marks: marks, diffs: diffs, compared: r.compared + (before ? before.compared || 0 : 0), source: source };
    logSecond(state.second);
    saveDraftSoon();
    renderSecond();
  }

  /* The manual way: the same lines (Review.nikudLines, as sent to Dicta) in a prompt for any chat. */

  var manualLines = null; // the lines in the prompt copied last; the answer is compared with them

  function copySecondPrompt() {
    var msgs = U.clear($('secondManualMsgs'));
    if (!state.lesson || !nikudDone()) {
      msgs.appendChild(msgBox('warn', 'קודם נקדו את הטקסט בדיקטה (למעלה). הבדיקה הכפולה משווה לניקוד של דיקטה.'));
      return;
    }
    manualLines = RV.nikudLines(state.lesson);
    copy(RV.buildManualNikudPrompt(manualLines.map(function (l) { return l.text; })),
      'הפרומפט הועתק (' + manualLines.length + ' שורות). הדביקו אותו בצ׳אט, ואת התשובה כאן.');
  }

  function compareSecondManual() {
    var msgs = U.clear($('secondManualMsgs'));
    if (!state.lesson || !nikudDone()) {
      msgs.appendChild(msgBox('warn', 'קודם נקדו את הטקסט בדיקטה (למעלה). הבדיקה הכפולה משווה לניקוד של דיקטה.'));
      return;
    }
    var got = RV.parseManualNikud($('secondResponse').value);
    if (!got.length) { msgs.appendChild(msgBox('error', 'לא הודבקה תשובה.')); return; }
    // The lines of the prompt copied last; after a reload (or if the text changed since), the lines as they are now.
    var now = RV.nikudLines(state.lesson);
    var sent = manualLines && manualLines.length === now.length && manualLines.every(function (l, i) { return l.text === now[i].text; }) ? manualLines : now;
    var c = RV.checkManualNikud(sent, got);
    if (c.error) {
      msgs.appendChild(msgBox('error', c.error, c.details.concat(['ודאו שהעתקתם את כל התשובה, ושהטקסט לא השתנה מאז שהעתקתם את הפרומפט (אם השתנה, העתיקו אותו שוב).'])));
      return;
    }
    if (c.bad.length === sent.length) {
      msgs.appendChild(msgBox('error', 'האותיות בתשובה שונות מהטקסט ששלחנו בכל השורות.', c.details));
      return;
    }
    var back = got.map(function (g, i) { return c.bad.indexOf(i) === -1 ? g : null; });
    secondRuns++; // an automatic run still going would overwrite this result
    finishSecond(sent, back, null, 'manual');
    if (c.bad.length) {
      msgs.appendChild(msgBox('warn', 'הבינה שינתה אותיות או מילים ב' + (c.bad.length === 1 ? 'שורה אחת' : '-' + c.bad.length + ' שורות') +
        '; השורות האלה לא נבדקו.', c.details));
    }
  }

  function secondName() {
    return state.second && state.second.source === 'manual' ? 'הבינה' : 'Gemini';
  }

  // The differences by kind, for the console and the downloaded report: {kind: {count, reading, examples}}.
  function secondSummary(sec) {
    var out = {};
    (sec.diffs || []).forEach(function (d) {
      d.kinds.forEach(function (k) {
        var o = out[k] || (out[k] = { count: 0, reading: 0, examples: [] });
        o.count++;
        if (d.reading) o.reading++;
        if (o.examples.length < 5) o.examples.push(H.stripNikud(d.dicta) + ': ' + d.dicta + ' / ' + d.gemini);
      });
    });
    return out;
  }

  function logSecond(sec) {
    console.info('[Gemini] nikud-check: ' + sec.compared + ' words compared, ' + (sec.diffs || []).length + ' differ, ' +
      sec.marks.length + ' read differently (marked)');
    var sum = secondSummary(sec);
    if (console.table && Object.keys(sum).length) {
      console.table(Object.keys(sum).map(function (k) { return { kind: k, count: sum[k].count, marked: sum[k].reading, example: sum[k].examples[0] }; }));
    }
  }

  // Every difference between Dicta and Gemini, with its kinds, as a JSON file (tests/nikud_diff_report.py sums them up).
  function downloadSecondReport() {
    var sec = state.second;
    var data = {
      title: H.stripNikud(state.lesson.title || ''), level: state.lesson.level || '', nikudMode: state.lesson.nikudMode,
      words: L.check(state.lesson, state.request).wordCount, compared: sec.compared, summary: secondSummary(sec),
      diffs: (sec.diffs || []).map(function (d) { return { field: d.key, index: d.index, dicta: d.dicta, gemini: d.gemini, kinds: d.kinds, marked: d.reading }; })
    };
    var a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
      download: 'nikud-compare-' + (data.title.replace(/[\\/:*?"<>|\s]+/g, '-') || 'lesson') + '.json' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function cancelSecondOpinion() {
    secondRuns++;
    state.second = null;
    lastMark = null;
    closeMarkDialog();
    U.clear($('secondMsgs'));
  }

  // Marks still to check. Marks on words edited since the comparison are dropped for good.
  function pendingMarks() {
    if (!state.second || state.second.status !== 'done' || !state.lesson) return [];
    state.second.marks = RV.liveMarks(state.lesson, state.second.marks);
    return state.second.marks.filter(function (m) { return !m.checked; });
  }

  // {index: mark} for one slot's words, or null.
  function marksOf(key) {
    var out = null;
    pendingMarks().forEach(function (m) {
      if (m.key !== key) return;
      out = out || {};
      out[m.index] = m;
    });
    return out;
  }

  function markId(m) { return m.key + '#' + m.index; }

  function renderSecond() {
    var box = $('secondMsgs');
    if (box) {
      U.clear(box);
      var b = secondBox(false);
      if (b) box.appendChild(b);
    }
    if (state.step === 4) refreshPreview();
  }

  // The status line: in step 5 (inPreview false) and above the story in the preview.
  function secondBox(inPreview) {
    var s = state.second;
    if (!s) return null;
    if (s.status === 'running') {
      return el('div', { class: 'msg info small second-status' }, 'בדיקה כפולה של הניקוד עם Gemini… (אפשר להמשיך בינתיים)');
    }
    if (s.status === 'failed') {
      return el('div', { class: 'msg warn small second-status' },
        el('div', { class: 'second-bar' },
          el('strong', null, 'הבדיקה הכפולה האוטומטית לא רצה'),
          el('button', { type: 'button', class: 'btn small', onclick: function () { startSecondOpinion(); } }, '↻ נסה שוב')),
        s.message ? el('div', { class: 'muted small' }, s.message) : null,
        el('div', { class: 'small', style: 'margin-top:6px' }, 'אפשר לבדוק ידנית בכל צ׳אט, בלי מפתח ובלי מכסה: ',
          el('button', { type: 'button', class: 'linkish small', onclick: function () {
            if (state.step !== 5) showStep(5);
            $('secondManual').open = true;
            $('secondManual').scrollIntoView({ block: 'start', behavior: 'smooth' });
          } }, 'לבדיקה הידנית')));
    }
    var n = pendingMarks().length;
    var report = s.diffs && s.diffs.length
      ? el('button', { type: 'button', class: 'linkish small', onclick: downloadSecondReport }, 'פירוט כל ההבדלים (קובץ)')
      : null;
    if (!n) {
      return el('div', { class: 'msg ok small second-status' }, s.marks.length
        ? 'הבדיקה הכפולה: כל המילים נבדקו ✓'
        : 'הבדיקה הכפולה: ' + secondName() + ' ניקד' + (secondName() === 'הבינה' ? 'ה' : '') + ' כמו דיקטה ✓', report ? ' ' : null, report);
    }
    var count = n === 1 ? 'מילה אחת לבדיקה' : n + ' מילים לבדיקה';
    return el('div', { class: 'msg warn small second-status' },
      el('div', { class: 'second-bar' },
        el('strong', { class: 'second-count' }, count),
        inPreview ? el('button', { type: 'button', class: 'btn small', onclick: nextMark }, 'הבאה ←') : null,
        inPreview ? el('button', { type: 'button', class: 'btn small quiet', onclick: markAllChecked }, 'סמן הכול כבדוק') : null,
        inPreview ? null : el('button', { type: 'button', class: 'btn small', onclick: function () { showStep(4); } }, 'לתצוגה המקדימה')),
      el('div', { class: 'muted small' }, 'דיקטה ו' + (secondName() === 'Gemini' ? '-' : '') + secondName() + ' ניקדו אותן כך שהן נקראות אחרת. המילים מסומנות בקו כתום' +
        (inPreview ? '; לחצו על מילה כדי לבחור.' : ' בתצוגה המקדימה.') + ' עד שתבחרו, נשאר הניקוד של דיקטה. ', report));
  }

  function markAllChecked() {
    pendingMarks().forEach(function (m) { m.checked = true; });
    saveDraftSoon();
    renderSecond();
  }

  function nextMark() {
    var list = pendingMarks();
    if (!list.length) return;
    var at = list.indexOf(lastMark);
    var m = list[(at + 1) % list.length];
    var node = document.querySelector('#preview .nikud-check[data-mark="' + markId(m) + '"]');
    if (node) node.scrollIntoView({ block: 'center' });
    openMark(m);
  }

  // A word of the preview that has a mark: orange underline, opens the choice.
  function decorateMark(span, m) {
    span.classList.add('nikud-check');
    span.setAttribute('data-mark', markId(m));
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.title = 'דיקטה ו' + (secondName() === 'Gemini' ? '-' : '') + secondName() + ' ניקדו את המילה הזו אחרת. לחצו כדי לבחור.';
    span.addEventListener('click', function () { openMark(m); });
    span.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMark(m); }
    });
  }

  function closeMarkDialog() {
    var d = $('nikudCheckDialog');
    if (!d) return;
    if (d.open) d.close();
    d.remove();
  }

  function openMark(m) {
    var slot = RV.slotByKey(state.lesson, m.key);
    if (!slot) return;
    closeMarkDialog();
    lastMark = m;
    var ws = RV.words(slot.get());
    var error = el('div', { class: 'msg error small', hidden: true });
    var input = el('input', { type: 'text', value: m.word, lang: 'he', spellcheck: 'false', class: 'nikud-input', 'aria-label': 'עריכה ידנית של הניקוד' });
    function choose(word) {
      var problem = resolveMark(m, word);
      if (problem) { error.textContent = problem; error.hidden = false; return; }
      closeMarkDialog();
    }
    function pick(label, word) {
      return el('button', { type: 'button', class: 'pick' + (word === m.word ? ' selected' : ''), onclick: function () { choose(word); } },
        el('span', { class: 'pick-label' }, label), el('span', { class: 'pick-word' }, word));
    }
    var dlg = el('dialog', { class: 'nikud-dialog', id: 'nikudCheckDialog', 'aria-label': 'בדיקת ניקוד' },
      el('div', { class: 'nikud-context' },
        el('span', { class: 'muted small' }, slot.label + ': '),
        ws.slice(Math.max(0, m.index - 4), m.index).join(' ') + ' ', el('mark', null, m.word), ' ' + ws.slice(m.index + 1, m.index + 5).join(' ')),
      el('div', { class: 'row' }, pick('דיקטה', m.dicta), pick(secondName(), m.gemini)),
      el('p', { class: 'small', style: 'margin:12px 0 4px' }, el('strong', null, 'או עריכה ידנית'), ' (רק הניקוד, האותיות נשארות):'),
      el('div', { class: 'row' }, input,
        el('button', { type: 'button', class: 'btn small primary', onclick: function () { choose(input.value); } }, 'שמירה')),
      error,
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { type: 'button', class: 'btn small quiet', onclick: closeMarkDialog }, 'סגירה')));
    dlg.addEventListener('close', function () { if (dlg.isConnected) dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  // The teacher's choice for a marked word: Dicta's, Gemini's or her own nikud. Returns an error message or null.
  function resolveMark(m, word) {
    var slot = RV.slotByKey(state.lesson, m.key);
    word = H.normalize(word).trim();
    if (!slot || RV.liveMarks(state.lesson, [m]).length !== 1) return 'המילה השתנתה בינתיים.';
    if (RV.words(word).length !== 1 || word !== RV.words(word)[0] || H.bare(word) !== H.bare(m.word)) {
      return 'אפשר לשנות כאן רק את הניקוד של המילה, בלי לשנות אותיות.';
    }
    if (word !== m.word) {
      var verified = nikudDone();
      if (!RV.setWord(slot, m.index, word)) return 'לא הצלחתי להחליף את המילה.';
      m.word = word;
      if (verified) markNikudVerified(); // still Dicta-checked: only nikud chosen
    }
    m.checked = true;
    changed();
    renderSecond();
    return null;
  }

  // Preview text of one slot with its marked words; offset: word index of s inside the slot (fill sentences).
  function slotText(lesson, key, s, mark, offset) {
    var marks = marksOf(key);
    if (!marks) return previewText(lesson, s, mark);
    var out = el('span');
    var k = (offset || 0) - 1;
    H.tokenize(R.text(lesson, s || '')).forEach(function (seg) {
      if (!seg.isWord) { out.appendChild(document.createTextNode(seg.text)); return; }
      k++;
      var span = el('span', { class: mark && lesson.nikudMode === 'full' && H.isUnvocalized(seg.text) ? 'no-nikud' : null }, seg.text);
      if (marks[k]) decorateMark(span, marks[k]);
      out.appendChild(span);
    });
    return out;
  }

  // A fill sentence ("___" for the blank) with its marked words.
  function fillText(lesson, key, sentence, mark) {
    if (!marksOf(key)) return R.fillSentence(lesson, sentence, null, mark);
    var out = el('span');
    var offset = 0;
    String(sentence || '').split('___').forEach(function (part, i, parts) {
      out.appendChild(slotText(lesson, key, part, mark, offset));
      offset += RV.words(part).length;
      if (i < parts.length - 1) out.appendChild(el('span', { class: 'blank' }, ' '));
    });
    return out;
  }

  /* ---------- Gemini: key and the automatic flow ---------- */

  var G = window.Gemini;

  function syncGemini() {
    var has = !!G.getKey();
    $('autoCreate').hidden = !has;
    $('autoCreateHint').hidden = !has;
    $('geminiState').hidden = !has;
    $('makePrompt').classList.toggle('primary', !has);
    $('makePrompt').classList.toggle('big', !has);
    $('deleteKey').disabled = !has;
    $('geminiKey').placeholder = has ? 'מפתח שמור (…' + G.getKey().slice(-4) + '). אפשר להדביק מפתח אחר.' : 'הדביקו כאן את המפתח';
  }

  function checkKey() {
    var msgs = U.clear($('geminiMsgs'));
    var key = $('geminiKey').value.trim() || G.getKey();
    if (!key) { msgs.appendChild(msgBox('error', 'הדביקו קודם את המפתח בשדה.')); return; }
    var btn = $('checkKey');
    btn.disabled = true;
    msgs.appendChild(msgBox('info', 'בודקים את המפתח…'));
    G.checkKey(key).then(function () {
      G.setKey(key);
      $('geminiKey').value = '';
      U.clear(msgs).appendChild(msgBox('ok', 'המפתח תקין ונשמר בדפדפן הזה ✓ עכשיו אפשר ללחוץ על "✨ צור שיעור".'));
      syncGemini();
    }, function (e) {
      U.clear(msgs).appendChild(msgBox('error', (e && e.message) || 'לא הצלחתי לבדוק את המפתח.',
        e && e.kind === 'key' ? [el('span', null, 'ראו ', el('a', { href: 'gemini-setup.html', target: '_blank', rel: 'noopener' }, 'איך מקבלים מפתח'), '.')] : null));
    }).then(function () { btn.disabled = false; });
  }

  function deleteKey() {
    G.clearKey();
    $('geminiKey').value = '';
    U.clear($('geminiMsgs')).appendChild(msgBox('ok', 'המפתח נמחק מהדפדפן הזה.'));
    syncGemini();
  }

  // Stage states: '' (not yet), active, done, fail, skip, wait (the teacher's turn).
  var STAGES = [
    { id: 'write', active: 'כותב סיפור…', done: 'הסיפור נכתב' },
    { id: 'edit', active: 'עורך את הסיפור…', done: 'הסיפור נערך' },
    { id: 'exercises', active: 'כותב תרגילים…', done: 'התרגילים נכתבו' },
    { id: 'check', active: 'בודק את השיעור…', done: 'השיעור עבר את הבדיקות' },
    { id: 'review', active: 'בודק טקסט…', done: 'בדיקת הטקסט הסתיימה' },
    { id: 'approve', active: 'מחכה לאישור ההצעות שלכם', done: 'ההצעות טופלו' },
    { id: 'nikud', active: 'מנקד בדיקטה…', done: 'הטקסט מנוקד' }
  ];
  var ICONS = { '': '○', active: '⏳', done: '✓', fail: '✕', skip: '–', wait: '👆' };

  var auto = null; // {stages: {id: {state, note}}, waitingApproval, fallback, reviewError, story (kept to retry the exercises)}
  var autoRuns = 0;

  function renderStages() {
    var ol = U.clear($('autoStages'));
    STAGES.forEach(function (st) {
      var s = auto.stages[st.id];
      var text = s.note || (s.state === 'done' ? st.done : st.active.replace(/…$/, ''));
      ol.appendChild(el('li', { class: s.state || 'todo', 'data-stage': st.id },
        el('span', { class: 'icon', 'aria-hidden': 'true' }, ICONS[s.state]),
        el('span', null, s.state === 'active' && !s.note ? st.active : text)));
    });
  }

  function stage(id, st, note) {
    if (!auto) return;
    auto.stages[id] = { state: st, note: note || '' };
    renderStages();
  }

  function cancelAuto() {
    if (!auto) return;
    autoRuns++;
    auto = null;
    $('autoFlow').hidden = true;
    $('autoCreate').disabled = false;
  }

  function flowMsg(box) {
    U.clear($('autoFlowMsgs'));
    if (box) $('autoFlowMsgs').appendChild(box);
  }

  function actionBtn(label, onClick, primary) {
    return el('button', { type: 'button', class: 'btn small' + (primary ? ' primary' : ''), onclick: onClick }, label);
  }

  function autoCreate() {
    cancelAuto();
    if (!readSettings()) return;
    var key = G.getKey();
    if (!key) { syncGemini(); return; }
    var run = ++autoRuns;
    G.resetModel(); // every new lesson starts with the main model
    auto = { stages: {}, waitingApproval: false, fallback: false, reviewError: null, story: null };
    STAGES.forEach(function (st) { auto.stages[st.id] = { state: '', note: '' }; });
    if (state.settings.nikud === 'none') auto.stages.nikud = { state: 'skip', note: 'בלי ניקוד' };
    $('autoFlow').hidden = false;
    flowMsg(null);
    $('autoCreate').disabled = true;
    stage('write', 'active');
    var current = function () { return auto && run === autoRuns; };

    // Three calls: a draft of the story, an editor's rewrite of it, then the exercises on the edited story
    // (a smaller answer each, so each comes faster).
    G.writeStory(key, window.buildStoryPrompt(state.request), streamOpts('write', 'כותב סיפור…', current)).then(function (text) {
      if (!current()) return;
      var story = readJson(text);
      if (!story || typeof story.story !== 'string' || !story.story.trim()) {
        writeFailed({ message: 'Gemini החזיר סיפור לא שלם.' });
        return;
      }
      auto.story = story;
      stage('write', 'done', auto.fallback ? 'הסיפור נכתב (במודל הגיבוי ' + G.currentModel() + ')' : '');
      autoEdit(key, run);
    }, function (e) {
      if (current()) writeFailed(e);
    });
  }

  function readJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // The story was not written: nothing to keep; try again or copy-paste.
  function writeFailed(e) {
    $('autoCreate').disabled = false;
    stage('write', 'fail', 'הכתיבה לא הצליחה');
    markRest('write');
    showStep(2);
    flowMsg(el('div', null,
      msgBox('error', (e && e.message) || 'Gemini לא הצליח לכתוב את השיעור.',
        e && e.kind === 'key' ? [el('span', null, 'בדקו את המפתח בשלב 1, או ראו ', el('a', { href: 'gemini-setup.html', target: '_blank', rel: 'noopener' }, 'איך מקבלים מפתח'), '.')] : null),
      msgBox('info', 'אפשר להמשיך בהעתק-הדבק: הפרומפט מוכן כאן למטה. העתיקו אותו לכל צ׳אט (Gemini, ChatGPT ואחרים).'),
      el('div', { class: 'row' }, actionBtn('↻ לנסות שוב', autoCreate, true))));
  }

  // The second call: an editor rewrites the draft. The edit replaces the draft only if every target word is still
  // in it and its length changed by no more than the editor was allowed (with a little room); otherwise, or if
  // the call fails, the flow goes on with the draft.
  function autoEdit(key, run) {
    var current = function () { return auto && run === autoRuns; };
    var draft = auto.story;
    stage('edit', 'active');
    G.editStory(key, window.buildEditPrompt(state.request, draft), streamOpts('edit', 'עורך את הסיפור…', current)).then(function (text) {
      if (!current()) return;
      var edited = readJson(text);
      var why = editProblem(draft, edited && edited.story);
      if (why) {
        console.warn('[Gemini] edit-story: the edit was not used (' + why + ').');
        stage('edit', 'skip', 'העריכה לא נשמרה (' + why + '); ממשיכים עם הטיוטה');
      } else {
        auto.story = Object.assign({}, draft, { story: edited.story.trim() });
        stage('edit', 'done');
      }
      autoExercises(key, run);
    }, function (e) {
      if (!current()) return;
      stage('edit', 'skip', 'העריכה לא הצליחה (' + ((e && e.message) || 'שגיאה') + '); ממשיכים עם הטיוטה');
      autoExercises(key, run);
    });
  }

  // Why an edited story cannot replace the draft, or '' if it can.
  var EDIT_LENGTH_LIMIT = 0.3; // the editor may change the length by 20%; a bit more is tolerated
  function editProblem(draft, story) {
    if (typeof story !== 'string' || !story.trim()) return 'תשובה ריקה';
    var words = H.tokenize(story).filter(function (t) { return t.isWord; }).map(function (t) { return t.text; });
    var lost = (draft.targetWords || []).map(function (t) { return t.word; }).filter(function (t) {
      return t && !words.some(function (w) { return H.matchesWord(w, t); });
    });
    if (lost.length) return (lost.length === 1 ? 'נעלמה מילת היעד ' : 'נעלמו מילות היעד ') + lost.join(', ');
    var before = H.countWords(draft.story);
    if (Math.abs(words.length - before) > before * EDIT_LENGTH_LIMIT) return 'האורך השתנה מ-' + before + ' ל-' + words.length + ' מילים';
    return '';
  }

  // The last call: exercises on auto.story. If it fails, the story is kept and only this call can be tried again.
  function autoExercises(key, run) {
    var current = function () { return auto && run === autoRuns; };
    var story = auto.story;
    $('autoCreate').disabled = true;
    flowMsg(null);
    stage('exercises', 'active');
    G.writeExercises(key, window.buildExercisesPrompt(state.request, story), streamOpts('exercises', 'כותב תרגילים…', current)).then(function (text) {
      if (!current()) return;
      var ex = readJson(text);
      if (!ex || !Array.isArray(ex.exercises)) {
        exercisesFailed(key, run, { message: 'Gemini החזיר תרגילים לא שלמים.' });
        return;
      }
      stage('exercises', 'done', auto.fallback ? 'התרגילים נכתבו (במודל הגיבוי ' + G.currentModel() + ')' : '');
      var lesson = { version: 1, title: story.title, topic: story.topic, targetWords: story.targetWords, story: story.story, exercises: ex.exercises };
      autoCheck(key, run, JSON.stringify(lesson, null, 2));
    }, function (e) {
      if (current()) exercisesFailed(key, run, e);
    });
  }

  function exercisesFailed(key, run, e) {
    $('autoCreate').disabled = false;
    stage('exercises', 'fail', 'כתיבת התרגילים לא הצליחה');
    markRest('exercises');
    flowMsg(el('div', null,
      msgBox('error', (e && e.message) || 'Gemini לא הצליח לכתוב את התרגילים.'),
      msgBox('info', 'הסיפור נשמר. אפשר לנסות שוב רק את התרגילים, או להתחיל שיעור חדש.'),
      el('div', { class: 'row' },
        actionBtn('↻ לנסות שוב את התרגילים', function () { retryExercises(key, run); }, true),
        actionBtn('שיעור חדש', autoCreate))));
    $('autoFlow').scrollIntoView({ block: 'start', behavior: 'smooth' }); // the message and its button are up there
  }

  function retryExercises(key, run) {
    if (!auto || run !== autoRuns || !auto.story) return;
    var after = false;
    STAGES.forEach(function (st) {
      if (st.id === 'exercises') after = true;
      if (after && !(st.id === 'nikud' && state.settings.nikud === 'none')) auto.stages[st.id] = { state: '', note: '' };
    });
    autoExercises(key, run);
  }

  // The whole lesson (story + exercises) goes through the same checks as a pasted answer.
  function autoCheck(key, run, text) {
    stage('check', 'active');
    $('response').value = text; // the answer is there for step 3, as if pasted
    var a = analyzeResponse(text);
    if (a.error || a.errors.length) {
      $('autoCreate').disabled = false;
      stage('check', 'fail', 'השיעור שהתקבל לא עבר את הבדיקות');
      markRest('check');
      showStep(2);
      flowMsg(el('div', null,
        msgBox('error', 'השיעור ש-Gemini כתב לא עבר את הבדיקות:', a.error ? [a.error].concat(a.items || []) : a.errors),
        msgBox('info', 'אפשר לנסות שוב, לתקן בעצמכם, או להמשיך בהעתק-הדבק: הפרומפט מוכן כאן למטה, לכל צ׳אט.'),
        el('div', { class: 'row' },
          actionBtn('↻ לנסות שוב', autoCreate, true),
          actionBtn('לראות את התשובה ולתקן', function () { showStep(3); parseResponse(); }))));
      return;
    }
    acceptLesson(a.lesson, state.request);
    stage('check', 'done', a.warnings.length ? 'השיעור עבר את הבדיקות (יש הערות בתצוגה)' : '');
    autoReview(key, run);
  }

  // Progress while Gemini streams its answer, and the retry / fallback notes.
  function streamOpts(id, label, current) {
    var retrying = false;
    return {
      onRetry: function (e, info) {
        retrying = true;
        if (!current()) return;
        stage(id, 'active', info && info.busy
          ? 'השרת של גוגל עמוס, מנסה שוב… (ניסיון ' + info.attempt + ' מתוך ' + info.of + ')'
          : 'תקלה זמנית, מנסים שוב…');
      },
      onFallback: function (model) {
        retrying = true;
        if (!current()) return;
        auto.fallback = true;
        stage(id, 'active', 'השרת של גוגל עמוס; ממשיכים עם מודל קל יותר (' + model + ')…');
      },
      // Thought summaries come before the answer: "חושב…" until its first characters.
      onProgress: function (chars, info) {
        var thinking = !chars && info && info.thinking;
        if (!current() || (!chars && !thinking && retrying)) return;
        stage(id, 'active', thinking ? label.replace(/…$/, '') + ': חושב…'
          : label + (chars ? ' (נכתבו כבר ' + chars.toLocaleString('he-IL') + ' תווים)' : ''));
      }
    };
  }

  // Stages after a failed one will not run.
  function markRest(afterId) {
    var after = false;
    STAGES.forEach(function (st) {
      if (after && !auto.stages[st.id].state) auto.stages[st.id] = { state: 'skip', note: '' };
      if (st.id === afterId) after = true;
    });
    renderStages();
  }

  function autoReview(key, run) {
    var current = function () { return auto && run === autoRuns; };
    showStep(5);
    stage('review', 'active');
    $('autoCreate').disabled = false;
    var prompt = RV.buildReviewPrompt(state.lesson);
    $('reviewPromptText').textContent = prompt;
    var sig = RV.signature(state.lesson);
    G.reviewLesson(key, prompt, streamOpts('review', 'בודק טקסט…', current)).then(function (text) {
      if (!current()) return;
      $('reviewResponse').value = text; // kept in the (closed) paste box, as if pasted
      var n = parseReview();
      if (RV.signature(state.lesson) !== sig) flowMsg(msgBox('info', 'השיעור השתנה בזמן הבדיקה; ייתכן שחלק מההצעות כבר לא מתאימות.'));
      if (n < 0) {
        reviewFailed(key, run, 'לא הצלחתי לקרוא את התשובה של בדיקת הטקסט.');
        return;
      }
      auto.reviewError = null;
      stage('review', 'done', n ? 'נמצאו ' + (n === 1 ? 'הצעה אחת' : n + ' הצעות') : 'לא נמצא מה לתקן');
      if (n > 0) {
        auto.waitingApproval = true;
        stage('approve', 'wait', 'אשרו או דחו כל הצעה (בחלק 1 למטה)');
        return;
      }
      stage('approve', 'skip');
      readyForNikud(false);
    }, function (e) {
      if (!current()) return;
      reviewFailed(key, run, 'בדיקת הטקסט האוטומטית נכשלה: ' + ((e && e.message) || 'שגיאה לא ידועה.'));
    });
  }

  // The review did not work: a clear message with "נסה ביקורת שוב", at the top and in part 1.
  // The flow goes on (nikud is the teacher's turn), without scrolling away from the message.
  function reviewFailed(key, run, message) {
    stage('review', 'fail', 'בדיקת הטקסט לא הצליחה');
    stage('approve', 'skip');
    auto.reviewError = function () {
      return el('div', { class: 'review-failed' },
        msgBox('error', message, ['אפשר לנסות שוב, לבדוק ידנית ("יצירת פרומפט ביקורת" בחלק 1, והדבקה לכל צ׳אט), או לדלג על הבדיקה.']),
        el('div', { class: 'row' }, actionBtn('↻ נסה ביקורת שוב', function () { retryReview(key, run); }, true)));
    };
    flowMsg(auto.reviewError());
    U.clear($('reviewMsgs')).appendChild(auto.reviewError());
    readyForNikud(false, true);
  }

  function retryReview(key, run) {
    if (!auto || run !== autoRuns) return;
    auto.reviewError = null;
    flowMsg(null);
    U.clear($('reviewMsgs'));
    U.clear($('reviewList'));
    stage('approve', '');
    if (auto.stages.nikud.state === 'wait') stage('nikud', '');
    autoReview(key, run);
  }

  // Called after every approve / reject. The last decision is a click, so Dicta may open in a new window.
  function reviewDecided() {
    if (!auto || !auto.waitingApproval) { dropStaleNikud(); renikudIfNeeded(); return; }
    if ($('reviewList').querySelector('.review-item:not(.accepted):not(.rejected)')) return;
    auto.waitingApproval = false;
    stage('approve', 'done');
    readyForNikud(true);
  }

  // gesture: inside a click, so window.open is allowed. stay: do not scroll to the nikud part.
  function readyForNikud(gesture, stay) {
    if (!auto) return;
    if (!nikudRequired()) { stage('nikud', 'skip', 'בלי ניקוד'); autoFinished(); return; }
    if (nikudDone()) { nikudStageDone(); return; }
    if (gesture && DB.known()) {
      stage('nikud', 'active');
      autoNikud();
      return;
    }
    stage('nikud', 'wait', DB.known()
      ? 'לחצו על "נקד אוטומטית בדיקטה" (חלק 2)'
      : 'נקדו בדיקטה (חלק 2): בכפתור האוטומטי אם התוסף מותקן, או ידנית');
    var btn = $('autoNikud');
    btn.classList.remove('pop');
    void btn.offsetWidth;
    btn.classList.add('pop');
    if (!stay) $('nikudPart').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function nikudStageDone() {
    if (!auto || !nikudRequired() || !nikudDone()) return;
    stage('nikud', 'done');
    autoFinished();
  }

  function nikudStageFailed() {
    if (!auto || !auto.stages.nikud.state || auto.stages.nikud.state === 'done') return;
    stage('nikud', 'wait', 'הניקוד האוטומטי לא הושלם: אפשר לנסות שוב או לנקד ידנית (חלק 2)');
  }

  function autoFinished() {
    if (!auto || auto.waitingApproval) return;
    if (auto.stages.approve.state === 'wait') return;
    // A failed review keeps its message and retry button above.
    flowMsg(el('div', null,
      auto.reviewError ? auto.reviewError() : null,
      msgBox('ok', auto.reviewError ? 'השיעור מוכן לקישור, גם בלי בדיקת הטקסט.' : 'השיעור מוכן ✓'),
      el('div', { class: 'row' }, actionBtn('יצירת קישור ←', goToLink, true))));
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
      (state.link.length > LONG_LINK ? ' הקישור ארוך. בוואטסאפ ובמכשירים מסוימים קישור ארוך מאוד עלול להיחתך: שלחו אותו קודם לעצמכם ובדקו שהוא נפתח. אם לא, קצרו את הסיפור.' : '');
    var title = H.stripNikud(lesson.title || 'שיעור קריאה');
    $('waLink').href = 'https://wa.me/?text=' + encodeURIComponent('📖 ' + title + '\n' + state.link);
    $('openLink').href = state.link;
  }

  /* ---------- Wire up ---------- */

  function init() {
    // A new level or kind of text brings its default question counts.
    levelRadios('level', window.Levels.DEFAULT, function () { setExerciseCounts(defaultCounts()); })
      .forEach(function (n) { $('levelChoices').appendChild(n); });
    genreRadios('genre', window.Levels.DEFAULT_GENRE, function () { setExerciseCounts(defaultCounts()); })
      .forEach(function (n) { $('genreChoices').appendChild(n); });
    exerciseRows().forEach(function (n) { $('exTypes').appendChild(n); });
    setExerciseCounts(defaultCounts());
    $('exDefaults').addEventListener('click', function () { setExerciseCounts(defaultCounts()); });
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
      var lines = state.nikudOnce ? linesToDicta() : [];
      if (lines.length) {
        copy(lines.map(function (l) { return l.text; }).join('\n'), 'הועתקו בלי ניקוד רק השורות שצריך לנקד (' + lines.length + '). הדביקו אותן בדיקטה.');
        return;
      }
      copy(RV.plainText(state.lesson), 'הטקסט הועתק בלי ניקוד. עכשיו הדביקו אותו בנקדן של דיקטה.');
    });
    $('autoNikud').addEventListener('click', autoNikud);
    $('copySecondPrompt').addEventListener('click', copySecondPrompt);
    $('compareSecond').addEventListener('click', compareSecondManual);
    $('autoCreate').addEventListener('click', autoCreate);
    $('checkKey').addEventListener('click', checkKey);
    $('deleteKey').addEventListener('click', deleteKey);
    $('autoFlowClose').addEventListener('click', function () { $('autoFlow').hidden = true; });
    syncGemini();
    $('compareNikud').addEventListener('click', compareNikud);
    $('copyLink').addEventListener('click', function () { copy(state.link, 'הקישור הועתק!'); });
    $('downloadJson').addEventListener('click', downloadJson);
    $('printBtn').addEventListener('click', function () {
      var sheet = window.Print.build(state.lesson, { answers: $('printAnswers').checked });
      U.clear($('printArea')).appendChild(sheet);
      window.Print.ready(sheet).then(function () { window.print(); });
    });
    $('newLesson').addEventListener('click', function () {
      cancelAuto();
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
          state.nikudOnce = !!(draft.nikudOnce || draft.nikudVerified);
          if (Array.isArray(draft.nikudLines)) state.nikudLines = draft.nikudLines;
          if (draft.second && Array.isArray(draft.second.marks)) { state.second = draft.second; renderSecond(); }
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
