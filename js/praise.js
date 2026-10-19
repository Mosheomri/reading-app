/* Encouragement on the child's page: what is shown and heard after a right answer (PRAISE) or a wrong one
   (TRY). Each sentence has its own recording; a recording that is not there yet falls back to the browser's
   Hebrew voice, and with no voice only the text is shown. Adding a file under assets/audio/ is enough.
   Exposes window.Praise. */
(function () {
  'use strict';

  var U = window.Util;

  // text: shown (may have emoji); say (optional): spoken instead of the text; audio: the recording.
  var PRAISE = [
    { text: 'כל הכבוד! 🌟', audio: 'assets/audio/praise-01.mp3' },
    { text: 'יופי! 👏', audio: 'assets/audio/praise-02.mp3' },
    { text: 'מצוין! ⭐', audio: 'assets/audio/praise-03.mp3' },
    { text: 'נהדר! 🎉', audio: 'assets/audio/praise-04.mp3' },
    { text: 'איזה יופי! 💫', audio: 'assets/audio/praise-05.mp3' },
    { text: 'עבודה טובה! 💪', audio: 'assets/audio/praise-06.mp3' },
    { text: 'בדיוק! ✨', audio: 'assets/audio/praise-07.mp3' },
    { text: 'אלופים! 🏅', audio: 'assets/audio/praise-08.mp3' }
  ];
  var TRY = [
    { text: 'כמעט! נסו שוב 🙂', audio: 'assets/audio/try-01.mp3' },
    { text: 'עוד קצת, נסו שוב 🙂', audio: 'assets/audio/try-02.mp3' },
    { text: 'לא נורא, נסו שוב 🙂', audio: 'assets/audio/try-03.mp3' },
    { text: 'כמעט הצלחתם! נסו עוד פעם 🙂', audio: 'assets/audio/try-04.mp3' }
  ];
  var LISTS = { praise: PRAISE, try: TRY };

  var NO_SOUND_MS = 2000;  // the pause before moving on when nothing is heard (muted, no recording, no voice)
  var AFTER_SOUND_MS = 300; // a short pause after the sound ends
  var MAX_AUDIO_MS = 10000; // a recording longer than this is not waited for
  var STORE_MUTED = 'readingApp.muted';

  var last = {};    // list name → index shown last, so the same sentence never comes twice in a row
  var missing = {}; // recordings that failed to load in this visit (not asked for again)
  var hasVoice = false;
  var current = null;

  function setVoice(on) { hasVoice = !!on; }

  // A random sentence from the list, never the one before.
  function next(kind) {
    var list = LISTS[kind];
    var i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === last[kind]) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    last[kind] = i;
    return list[i];
  }

  var EMOJI_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu;
  function spoken(item) { return (item.say || item.text).replace(EMOJI_RE, '').trim(); }

  function muted() {
    try { return localStorage.getItem(STORE_MUTED) === '1'; } catch (e) { return false; }
  }
  function setMuted(on) {
    try { if (on) localStorage.setItem(STORE_MUTED, '1'); else localStorage.removeItem(STORE_MUTED); } catch (e) { /* ignore */ }
    if (on) stop();
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Plays the recording; resolves true when it ended, false when it could not be played.
  function playFile(src, handle) {
    if (!src || missing[src] || typeof Audio !== 'function') return Promise.resolve(false);
    return new Promise(function (resolve) {
      var a = new Audio(src);
      handle.audio = a;
      var done = false;
      function finish(ok) { if (!done) { done = true; resolve(ok); } }
      a.addEventListener('ended', function () { finish(true); });
      a.addEventListener('error', function () { missing[src] = true; finish(false); });
      // A file that never reports its end: move on after its length (or MAX_AUDIO_MS) anyway.
      a.addEventListener('loadedmetadata', function () {
        if (isFinite(a.duration)) setTimeout(function () { finish(true); }, a.duration * 1000 + 1500);
      });
      setTimeout(function () { finish(true); }, MAX_AUDIO_MS);
      var p = a.play();
      if (p && p.catch) p.catch(function (e) { if (e && e.name !== 'AbortError') finish(false); });
    });
  }

  // Shows nothing itself: plays (or speaks) the sentence. Resolves when it is time to move on: after the sound,
  // or after NO_SOUND_MS when nothing could be heard. stop() ends it early (the promise then never resolves).
  function play(item) {
    stop();
    var handle = { stopped: false, audio: null };
    current = handle;
    var promise;
    if (muted()) promise = wait(NO_SOUND_MS);
    else {
      promise = playFile(item.audio, handle).then(function (ok) {
        if (handle.stopped) return;
        if (ok) return wait(AFTER_SOUND_MS);
        if (!hasVoice) return wait(NO_SOUND_MS);
        return U.speak(spoken(item)).then(function (spokenOk) { return wait(spokenOk ? AFTER_SOUND_MS : NO_SOUND_MS); });
      });
    }
    handle.promise = promise.then(function () {
      if (handle.stopped) return new Promise(function () {});
      if (current === handle) current = null;
    });
    return handle.promise;
  }

  function stop() {
    if (!current) return;
    current.stopped = true;
    if (current.audio) { try { current.audio.pause(); } catch (e) { /* ignore */ } }
    U.stopSpeaking();
    current = null;
  }

  window.Praise = {
    PRAISE: PRAISE,
    TRY: TRY,
    NO_SOUND_MS: NO_SOUND_MS,
    next: next,
    spoken: spoken,
    play: play,
    stop: stop,
    muted: muted,
    setMuted: setMuted,
    setVoice: setVoice
  };
})();
