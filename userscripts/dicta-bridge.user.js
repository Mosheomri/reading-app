// ==UserScript==
// @name         קוראים ביחד – גשר לדיקטה
// @namespace    https://mosheomri.github.io/reading-app/
// @version      1.1.0
// @description  מנקד בנקדן של דיקטה את הטקסט שנשלח מאתר "קוראים ביחד" ומחזיר אותו לאתר. פועל רק כשהאתר פתח את דיקטה.
// @match        https://nakdan.dicta.org.il/*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  https://mosheomri.github.io/reading-app/dicta-setup.html
// @updateURL    https://mosheomri.github.io/reading-app/userscripts/dicta-bridge.user.js
// @downloadURL  https://mosheomri.github.io/reading-app/userscripts/dicta-bridge.user.js
// ==/UserScript==

/* Protocol (window.postMessage, both sides check the origin):
     Dicta → site  {source: 'dicta-bridge', type: 'ready', version}            (repeated until a request arrives)
     site → Dicta  {source: 'reading-app', type: 'nikud', id, text}
     Dicta → site  {source: 'dicta-bridge', type: 'progress', id, part, parts}
                   {source: 'dicta-bridge', type: 'result', id, text}           then the window closes
                   {source: 'dicta-bridge', type: 'error', id, message}         the window stays open for manual use
   The script does nothing unless the page was opened by another window (window.opener). */
(function () {
  'use strict';

  /* ---------- Dicta's page. If Dicta changes its site, fix these. ---------- */
  var SEL = {
    textarea: '#input-textarea',                     // the text box
    result: '#nikud-text',                           // the vocalized text, shown over the text box
    settingsButton: 'button:has(.fa-gear), button[aria-haspopup="menu"]', // the gear; opens the settings menu
    styleModern: 'input[type="radio"][value="modern"]',  // סגנון: מודרני (only in the DOM while the menu is open)
    spellingMale: 'input[type="radio"][value="maleh"]',  // ניקוד בכתיב מלא
    nikudButton: null                                // Dicta vocalizes as you type; set a selector if a "נקד" button returns
  };

  var VERSION = '1.0.0';
  var ALLOWED = ['https://mosheomri.github.io', 'http://localhost:8000'];
  var MAX_CHARS = 5000;        // Dicta's limit per text (the text box has maxlength=5000)
  var ELEMENT_TIMEOUT = 15000; // waiting for Dicta's page / menu to appear
  var PART_TIMEOUT = 30000;    // waiting for one part to be vocalized
  var STABLE_MS = 800;         // the result must not change for this long
  var STABLE_PARTIAL_MS = 4000; // the same when some Hebrew words still have no nikud: Dicta may not be done yet
  var READY_EVERY = 1000;

  var opener = window.opener;
  if (!opener) return;

  var NIKUD_RE = /[\u0591-\u05BD\u05BF-\u05C2\u05C4\u05C5\u05C7]/g; // marks, not maqaf / sof pasuq
  var HAS_NIKUD_RE = /[\u0591-\u05BD\u05BF-\u05C2\u05C4\u05C5\u05C7]/;
  var LETTERS_RE = /[\u05D0-\u05EA]/;

  /* ---------- Messages ---------- */

  function post(msg, origin) {
    msg.source = 'dicta-bridge';
    (origin ? [origin] : ALLOWED).forEach(function (o) {
      try { opener.postMessage(msg, o); } catch (e) { /* opener gone or another origin */ }
    });
  }

  var busy = false;
  var readyTimer = null;

  window.addEventListener('message', function (e) {
    if (ALLOWED.indexOf(e.origin) < 0 || e.source !== opener) return;
    var d = e.data;
    if (!d || d.source !== 'reading-app' || d.type !== 'nikud' || typeof d.text !== 'string' || busy) return;
    busy = true;
    clearInterval(readyTimer);
    run(d.text, d.id, e.origin);
  });

  /* ---------- Helpers ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(selector, ms, what) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var node = document.querySelector(selector);
        if (node) return resolve(node);
        if (Date.now() - t0 > ms) return reject(new Error('לא מצאתי בדיקטה את ' + what + '. ייתכן שהאתר של דיקטה השתנה.'));
        setTimeout(poll, 100);
      })();
    });
  }

  // Set the value the way typing would, so Dicta's app (Vue) sees it.
  function setValue(ta, text) {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function resultText() {
    var node = document.querySelector(SEL.result);
    if (!node) return '';
    return node.textContent.replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  }

  // At least 90% of the Hebrew words have nikud: the whole text is done, not an update on the way.
  function mostlyVocalized(s) {
    var words = s.split(/\s+/).filter(function (w) { return LETTERS_RE.test(w); });
    var done = words.filter(function (w) { return HAS_NIKUD_RE.test(w); }).length;
    return words.length > 0 && done >= Math.ceil(words.length * 0.9);
  }

  function allVocalized(s) {
    return s.split(/\s+/).filter(function (w) { return LETTERS_RE.test(w); }).every(function (w) { return HAS_NIKUD_RE.test(w); });
  }

  // Letters only, without ו/י: Dicta's ktiv male may add a mater lectionis. The site checks the exact letters.
  function skeleton(s) {
    return String(s).replace(NIKUD_RE, '').replace(/[^\u05D0-\u05EA]/g, '').replace(/[וי]/g, '');
  }

  // Split at line ends into parts of at most max characters. A longer line is split at a space.
  // Returns [{text, join}]: join is what goes before the part when the results are put together.
  function split(text, max) {
    var parts = [];
    var cur = null;
    text.split('\n').forEach(function (line) {
      if (cur !== null && cur.length + 1 + line.length <= max) { cur += '\n' + line; return; }
      if (cur !== null) parts.push({ text: cur, join: '\n' });
      cur = null;
      var join = '\n';
      while (line.length > max) {
        var cut = line.lastIndexOf(' ', max);
        if (cut <= 0) cut = max;
        parts.push({ text: line.slice(0, cut), join: join });
        line = line.slice(cut).replace(/^ /, '');
        join = ' ';
      }
      if (join === ' ') { parts.push({ text: line, join: ' ' }); return; }
      cur = line;
    });
    if (cur !== null) parts.push({ text: cur, join: '\n' });
    if (parts.length) parts[0].join = '';
    return parts;
  }

  /* ---------- Steps ---------- */

  function menuOpen() { return !!document.querySelector(SEL.styleModern); }

  function closeMenu() {
    if (!menuOpen()) return;
    var esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
  }

  function settingsOk() {
    var a = document.querySelector(SEL.styleModern);
    var b = document.querySelector(SEL.spellingMale);
    return !!(a && b && a.checked && b.checked);
  }

  async function applySettings() {
    if (!menuOpen()) {
      var gear = await waitFor(SEL.settingsButton, ELEMENT_TIMEOUT, 'כפתור ההגדרות (גלגל השיניים)');
      gear.click();
    }
    var modern = await waitFor(SEL.styleModern, ELEMENT_TIMEOUT, 'הבחירה "סגנון מודרני"');
    if (!modern.checked) modern.click();
    var male = await waitFor(SEL.spellingMale, ELEMENT_TIMEOUT, 'הבחירה "ניקוד בכתיב מלא"');
    if (!male.checked) male.click();
    await sleep(200);
    if (!settingsOk()) throw new Error('לא הצלחתי לבחור בדיקטה "סגנון מודרני" ו"ניקוד בכתיב מלא".');
    closeMenu();
    await sleep(200);
    if (menuOpen()) { var g = document.querySelector(SEL.settingsButton); if (g) g.click(); }
    await sleep(200);
  }

  // Put one part in the text box and wait until its vocalized text is shown and stays the same.
  function vocalize(ta, text) {
    if (!LETTERS_RE.test(text)) return Promise.resolve(text);
    var want = skeleton(text);
    return new Promise(function (resolve, reject) {
      var last = null;
      var stableTimer = null;
      var observer = null;
      var timeout = setTimeout(function () {
        finish();
        reject(new Error('דיקטה לא החזירה ניקוד בזמן (' + Math.round(PART_TIMEOUT / 1000) + ' שניות).'));
      }, PART_TIMEOUT);

      function finish() {
        clearTimeout(timeout);
        clearTimeout(stableTimer);
        clearInterval(poll);
        if (observer) observer.disconnect();
      }
      function check() {
        var now = resultText();
        if (now === last) return;
        last = now;
        clearTimeout(stableTimer);
        if (!now || !mostlyVocalized(now) || skeleton(now) !== want) return;
        stableTimer = setTimeout(function () {
          if (resultText() !== last) { check(); return; }
          finish();
          resolve(last);
        }, allVocalized(now) ? STABLE_MS : STABLE_PARTIAL_MS);
      }
      // The result node may be replaced, so watch the whole page, and poll as a backup.
      observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      var poll = setInterval(check, 250);

      setValue(ta, text);
      if (SEL.nikudButton) {
        var btn = document.querySelector(SEL.nikudButton);
        if (btn) btn.click();
      }
      check();
    });
  }

  async function run(text, id, origin) {
    try {
      var ta = await waitFor(SEL.textarea, ELEMENT_TIMEOUT, 'תיבת הטקסט');
      await applySettings();
      var parts = split(text.replace(/\r\n?/g, '\n'), MAX_CHARS);
      var out = '';
      for (var i = 0; i < parts.length; i++) {
        post({ type: 'progress', id: id, part: i + 1, parts: parts.length }, origin);
        out += parts[i].join + await vocalize(ta, parts[i].text);
      }
      post({ type: 'result', id: id, text: out }, origin);
      setTimeout(function () { window.close(); }, 300);
    } catch (err) {
      post({ type: 'error', id: id, message: (err && err.message) || String(err) }, origin);
      busy = false;
    }
  }

  /* ---------- Start: tell the opener we are here once Dicta's page is up ---------- */

  waitFor(SEL.textarea, ELEMENT_TIMEOUT, 'תיבת הטקסט').then(function () {
    if (busy) return;
    post({ type: 'ready', version: VERSION });
    readyTimer = setInterval(function () {
      if (busy || opener.closed) { clearInterval(readyTimer); return; }
      post({ type: 'ready', version: VERSION });
    }, READY_EVERY);
  }, function () { /* not Dicta's editor page */ });
})();
