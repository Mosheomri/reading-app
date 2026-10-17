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
      if (state.lesson) save(STORE_DRAFT, { lesson: state.lesson, request: state.request });
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
    if (n === 2 && !$('promptText').textContent) n = 1;
    state.step = n;
    state.maxStep = Math.max(state.maxStep, n);
    for (var i = 1; i <= 5; i++) $('step' + i).hidden = i !== n;
    $('wrap').classList.toggle('wide', n === 4);
    Array.prototype.forEach.call($('steps').children, function (li) {
      var s = +li.dataset.step;
      li.className = s === n ? 'active' : (s <= state.maxStep ? 'done' : '');
      li.style.cursor = s <= state.maxStep && s !== n ? 'pointer' : '';
    });
    if (n === 4) renderEditor();
    if (n === 5) renderLink();
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
      nikud: document.querySelector('input[name="nikud"]:checked').value
    };
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
    state.request = { topic: f.topic, length: f.length, wordsMode: f.wordsMode, wordCount: f.wordCount, words: words };
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

  function acceptLesson(lesson, request) {
    state.lesson = lesson;
    state.request = request;
    state.maxStep = Math.min(state.maxStep, 4);
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
      acceptLesson(c.lesson, null);
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
    var input = el('input', Object.assign({ type: 'text', value: value }, attrs || {}));
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
    var story = el('textarea', { rows: 12, value: lesson.story });
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
    if (!res.errors.length && !res.warnings.length) msgs.appendChild(msgBox('ok', 'הכל תקין ✓'));
    $('makeLink').disabled = res.errors.length > 0;

    var p = U.clear($('preview'));
    p.appendChild(el('h2', { style: 'text-align:center' }, R.markedText(lesson, lesson.title)));
    p.appendChild(el('div', { class: 'target-chips' }, lesson.targetWords.map(function (t) {
      return el('span', { class: 'chip' }, t.emoji + ' ', R.markedText(lesson, t.word));
    })));
    p.appendChild(el('div', { class: 'story' }, R.story(lesson, null, true)));
    p.appendChild(el('h3', { style: 'margin-top:16px' }, 'תרגילים'));
    lesson.exercises.forEach(function (ex, i) {
      if (ex.unknown) return;
      p.appendChild(exercisePreview(lesson, ex, i));
    });
  }

  function exercisePreview(lesson, ex, i) {
    var box = el('div', { class: 'ex-preview' });
    var num = (i + 1) + '. ';
    function t(s) { return R.markedText(lesson, s); }
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
      box.appendChild(el('div', null, num, R.fillSentence(lesson, ex.sentence, null, true)));
      box.appendChild(optionList());
    } else if (ex.type === 'order') {
      box.appendChild(el('div', null, num + 'סידור משפטים (הילד יקבל אותם מעורבבים):'));
      box.appendChild(el('ol', null, ex.sentences.map(function (s) { return el('li', null, t(s)); })));
    }
    return box;
  }

  /* ---------- Step 5: link ---------- */

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
    $('copyLink').addEventListener('click', function () { copy(state.link, 'הקישור הועתק!'); });
    $('downloadJson').addEventListener('click', downloadJson);
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
          acceptLesson(c.lesson, draft.request || null);
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
