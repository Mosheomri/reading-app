/* Small shared helpers. Exposes window.Util. */
(function () {
  'use strict';

  // el('div', {class: 'x', onclick: fn}, child1, 'text', ...)
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'value') node.value = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (k in node && typeof v !== 'string') node[k] = v;
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Shuffle, trying to avoid returning the original order.
  function shuffleChanged(arr, same) {
    same = same || function (a, b) { return a === b; };
    if (arr.length < 2) return arr.slice();
    for (var tries = 0; tries < 10; tries++) {
      var s = shuffle(arr);
      for (var i = 0; i < s.length; i++) if (!same(s[i], arr[i])) return s;
    }
    return arr.slice().reverse();
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = el('textarea', { readonly: true, style: 'position:fixed;top:0;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  /* ---------- Speech (Web Speech API, he-IL) ---------- */
  var voice = null;
  var voicePromise = null;

  function findHebrewVoice() {
    if (!('speechSynthesis' in window)) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    for (var i = 0; i < voices.length; i++) {
      var lang = (voices[i].lang || '').toLowerCase().replace('_', '-');
      if (lang.indexOf('he') === 0 || lang.indexOf('iw') === 0) return voices[i];
    }
    return null;
  }

  // Resolves to true if a Hebrew voice exists. Voices may load asynchronously.
  function speechReady() {
    if (voicePromise) return voicePromise;
    voicePromise = new Promise(function (resolve) {
      if (!('speechSynthesis' in window)) { resolve(false); return; }
      voice = findHebrewVoice();
      if (voice) { resolve(true); return; }
      var done = false;
      function finish() {
        if (done) return;
        voice = findHebrewVoice();
        if (!voice && !timedOut) return;
        done = true;
        resolve(!!voice);
      }
      var timedOut = false;
      window.speechSynthesis.addEventListener('voiceschanged', finish);
      setTimeout(function () { timedOut = true; finish(); }, 1500);
    });
    return voicePromise;
  }

  // Speaks the text; resolves when it ends (or fails). Some browsers never fire "end", so it also resolves
  // after a generous time for the text's length.
  function speak(text) {
    if (!voice) return Promise.resolve(false);
    var synth = window.speechSynthesis;
    synth.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang || 'he-IL';
    u.rate = 0.8;
    return new Promise(function (resolve) {
      var done = false;
      function finish(ok) { if (!done) { done = true; clearTimeout(t); resolve(ok); } }
      var t = setTimeout(function () { finish(true); }, 1500 + String(text).length * 150);
      u.onend = function () { finish(true); };
      u.onerror = function () { finish(false); };
      synth.speak(u);
    });
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  window.Util = {
    el: el,
    clear: clear,
    shuffle: shuffle,
    shuffleChanged: shuffleChanged,
    copyText: copyText,
    speechReady: speechReady,
    speak: speak,
    stopSpeaking: stopSpeaking
  };
})();
