/* Gemini API (Google AI Studio key), called straight from the browser. Structured output, so the reply is
   JSON that matches the schema. The key is kept in this browser's localStorage only.
   Exposes window.Gemini. */
(function () {
  'use strict';

  // Stable model with a free tier (ai.google.dev/gemini-api/docs/pricing, checked October 2026).
  var MODEL = 'gemini-3.8-flash';
  // Used when MODEL stays overloaded (503) after its retries: a lighter stable model, also free tier,
  // with structured outputs (ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).
  var FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  // Thinking makes answers slower; each model's lowest level (ai.google.dev/gemini-api/docs/thinking):
  // gemini-3.8-flash has low / medium / high, gemini-3.5-flash-lite also minimal.
  var THINKING_LEVEL = 'low';
  var FALLBACK_THINKING_LEVEL = 'minimal';
  var API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var STORE_KEY = 'readingApp.geminiKey';

  var config = {
    timeout: 120000,               // a plain request (checking the key)
    firstDataTimeout: 120000,      // a streamed answer: nothing at all yet for this long (the model may think first)
    idleTimeout: 45000,            // a streamed answer that has started: no new data for this long
    retryDelay: 4000,              // before the one automatic retry after another temporary error
    busyDelays: [2000, 5000, 10000], // server overloaded (503): up to 3 more tries, waiting this long before each
    nikudChunkChars: 2500            // second opinion on the nikud: text per call; a longer lesson is sent in several calls
  };

  // The model in use: MODEL, until it stays overloaded; then FALLBACK_MODEL until resetModel().
  var activeModel = MODEL;

  /* ---------- Key ---------- */

  function getKey() {
    try { return localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { localStorage.setItem(STORE_KEY, k); } catch (e) { /* private mode: not remembered */ }
  }
  function clearKey() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------- Schemas (OpenAPI subset used by responseSchema) ---------- */

  var S = { type: 'STRING' };
  var LIST = { type: 'ARRAY', items: S };
  // A part of a "message" exercise: options + answer (multiple choice) or sampleAnswer (open).
  var PART = {
    type: 'OBJECT',
    properties: { question: S, options: LIST, answer: S, sampleAnswer: S },
    required: ['question'],
    propertyOrdering: ['question', 'options', 'answer', 'sampleAnswer']
  };

  var TARGET_WORDS = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: { word: S, emoji: S },
      required: ['word', 'emoji'],
      propertyOrdering: ['word', 'emoji']
    }
  };
  var STORY = { type: 'STRING', description: 'The whole story. Paragraphs separated by a newline.' };

  // `answer` is a string for every exercise type; Lesson.coerce turns "0" into 0 and "true" into true.
  var EXERCISES = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['mcq', 'tf', 'fill', 'order', 'open', 'locate', 'message'] },
        question: S,
        statement: S,
        sentence: { type: 'STRING', description: 'fill: the sentence with ___. locate: the sentence of the story that answers, word for word.' },
        options: LIST,
        sentences: LIST,
        answer: { type: 'STRING', description: 'mcq / fill: the number of the right option, the first is "0". tf: "true" or "false". Other types: empty.' },
        sampleAnswer: { type: 'STRING', description: 'open: a short sample answer.' },
        visible: PART,
        hidden: PART
      },
      required: ['type'],
      propertyOrdering: ['type', 'question', 'statement', 'sentence', 'options', 'sentences', 'answer', 'sampleAnswer', 'visible', 'hidden']
    }
  };

  // The automatic flow writes a lesson in two calls: the story (small, fast), then the exercises on it
  // (window.buildStoryPrompt / buildExercisesPrompt in js/prompt.js).
  var STORY_SCHEMA = {
    type: 'OBJECT',
    properties: { title: S, topic: S, targetWords: TARGET_WORDS, story: STORY },
    required: ['title', 'topic', 'targetWords', 'story'],
    propertyOrdering: ['title', 'topic', 'targetWords', 'story']
  };
  var EXERCISES_SCHEMA = {
    type: 'OBJECT',
    properties: { exercises: EXERCISES },
    required: ['exercises']
  };

  // The whole lesson in one call: the same shape as the example in js/prompt.js.
  var LESSON_SCHEMA = {
    type: 'OBJECT',
    properties: { title: S, topic: S, targetWords: TARGET_WORDS, story: STORY, exercises: EXERCISES },
    required: ['title', 'topic', 'targetWords', 'story', 'exercises'],
    propertyOrdering: ['title', 'topic', 'targetWords', 'story', 'exercises']
  };

  // The list the review prompt (Review.buildReviewPrompt) asks for.
  var REVIEW_SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        field: S,
        type: { type: 'STRING', enum: ['error', 'style'] },
        original: S,
        fix: S,
        reason: S
      },
      required: ['field', 'type', 'original', 'fix', 'reason'],
      propertyOrdering: ['field', 'type', 'original', 'fix', 'reason']
    }
  };

  // Second opinion on Dicta's nikud: the same lines back, vocalized (Review.buildNikudPrompt).
  var NIKUD_SCHEMA = {
    type: 'OBJECT',
    properties: { lines: LIST },
    required: ['lines']
  };

  /* ---------- Errors ---------- */

  // kind: key | quota | network | timeout | blocked | cut | server | empty
  function GeminiError(kind, message, status) {
    this.kind = kind;
    this.message = message;
    this.status = status || 0;
  }

  var MESSAGES = {
    key: 'המפתח של Gemini לא תקין, או שאין לו הרשאה ל-Gemini API. בדקו אותו בעמוד ההגדרה.',
    quota: 'נגמרה המכסה החינמית של Gemini לעכשיו. נסו שוב בעוד כמה דקות (או מחר, אם נגמרה המכסה היומית).',
    network: 'אין חיבור ל-Gemini. בדקו את החיבור לאינטרנט ונסו שוב.',
    timeout: 'Gemini לא ענה בזמן.',
    first: 'Gemini לא התחיל לענות ({s} שניות).',
    idle: 'Gemini הפסיק לשלוח נתונים ({s} שניות בלי תשובה).',
    blocked: 'Gemini סירב לכתוב את התוכן הזה. נסו לנסח את הנושא אחרת.',
    cut: 'התשובה של Gemini נקטעה באמצע.',
    server: 'יש תקלה זמנית אצל Gemini.',
    busy: 'השרת של Google עמוס כרגע, גם אחרי כמה ניסיונות ובמודל קל יותר. נסו שוב בעוד כמה דקות.',
    empty: 'Gemini החזיר תשובה ריקה.'
  };

  function errorFromResponse(status, body) {
    var err = (body && body.error) || {};
    var reason = '';
    (err.details || []).forEach(function (d) { if (d && d.reason) reason = d.reason; });
    var text = String(err.message || '');
    var e;
    if (status === 429) e = new GeminiError('quota', MESSAGES.quota, status);
    else if (status === 401 || status === 403 || reason === 'API_KEY_INVALID' || /api key/i.test(text)) e = new GeminiError('key', MESSAGES.key, status);
    else if (status === 503 || err.status === 'UNAVAILABLE') e = new GeminiError('busy', MESSAGES.busy, 503);
    else if (status >= 500) e = new GeminiError('server', MESSAGES.server, status);
    else e = new GeminiError('server', 'Gemini החזיר שגיאה (' + status + (text ? ': ' + text : '') + ').', status);
    // Google's own words, for the console.
    e.detail = [err.status, reason, text].filter(Boolean).join(' ');
    return e;
  }

  // Worth one automatic retry (an overloaded server, 'busy', has its own retries).
  function temporary(e) {
    return e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'server' && e.status >= 500);
  }

  /* ---------- Requests ---------- */

  // One line per request in the console: what, how long, HTTP status, error. Never the key.
  function log(info) {
    var line = '[Gemini] ' + info.call + ' (' + (info.model || MODEL) + '): ' + (info.status ? 'HTTP ' + info.status : 'no response') +
      ', ' + (info.ms / 1000).toFixed(1) + ' s' + (info.first != null ? ' (first data after ' + (info.first / 1000).toFixed(1) + ' s)' : '') +
      (info.chars != null ? ', ' + info.chars + ' chars' : '') +
      (info.finish ? ', finish ' + info.finish : '') + (info.attempt > 1 ? ', retry' : '') +
      (info.error ? ' – ' + info.error : '');
    if (info.error) console.warn(line); else console.info(line);
  }

  function headers(key, json) {
    return Object.assign({ 'x-goog-api-key': key }, json ? { 'Content-Type': 'application/json' } : {});
  }

  // waited: what an abort means – 'first' (no data yet in a stream), 'idle' (a stream stopped), or a plain request.
  function networkError(e, waited) {
    if (!e || e.name !== 'AbortError') return new GeminiError('network', MESSAGES.network);
    if (waited === 'first') return new GeminiError('timeout', MESSAGES.first.replace('{s}', Math.round(config.firstDataTimeout / 1000)));
    if (waited === 'idle') return new GeminiError('timeout', MESSAGES.idle.replace('{s}', Math.round(config.idleTimeout / 1000)));
    return new GeminiError('timeout', MESSAGES.timeout);
  }

  // What went wrong, for the console: the browser's error and our message.
  function logError(e, err) {
    return (e && e.message && !(e instanceof GeminiError) ? e.message + ' / ' : '') + err.message +
      (err.detail ? ' (' + err.detail + ')' : '');
  }

  function readError(res) {
    return res.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
      throw errorFromResponse(res.status, data);
    });
  }

  // A plain JSON request (checking the key), with config.timeout.
  function request(call, url, key, attempt) {
    var t0 = Date.now();
    var status = 0;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, config.timeout);
    return fetch(url, { method: 'GET', headers: headers(key, false), signal: ctrl.signal }).then(function (res) {
      status = res.status;
      if (!res.ok) return readError(res);
      return res.json().catch(function () { return null; });
    }).then(function (data) {
      clearTimeout(timer);
      log({ call: call, status: status, ms: Date.now() - t0, attempt: attempt });
      return data;
    }, function (e) {
      clearTimeout(timer);
      var err = e instanceof GeminiError ? e : networkError(e, 'request');
      log({ call: call, status: status, ms: Date.now() - t0, attempt: attempt, error: logError(e, err) });
      throw err;
    });
  }

  // A streamed generateContent (server-sent events). Until the first piece of the answer arrives the timer is
  // config.firstDataTimeout (the model may think a while first); after that it starts again on every piece, with
  // config.idleTimeout, so an answer that keeps coming is never cut. Thought summaries (includeThoughts) count as
  // data but are left out of the text.
  // onProgress(chars, {thinking}) after every chunk; thinking: thoughts came and no answer text yet. Resolves with the text.
  function stream(call, model, key, body, attempt, onProgress) {
    var url = API + model + ':streamGenerateContent?alt=sse';
    var t0 = Date.now();
    var first = null; // ms to the first piece of the answer
    var status = 0;
    var ctrl = new AbortController();
    var timer = null;
    function wait(ms) {
      clearTimeout(timer);
      timer = setTimeout(function () { ctrl.abort(); }, ms);
    }
    function alive() {
      if (first === null) first = Date.now() - t0;
      wait(config.idleTimeout);
    }
    var text = '';
    var thoughts = 0;
    var finish = '';
    var blocked = '';
    var streamError = null;

    function onEvent(json) {
      var data;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (data.error) { streamError = errorFromResponse(data.error.code || 500, data); return; }
      if (data.promptFeedback && data.promptFeedback.blockReason) blocked = data.promptFeedback.blockReason;
      var c = data.candidates && data.candidates[0];
      if (!c) return;
      ((c.content && c.content.parts) || []).forEach(function (part) {
        if (part.thought) thoughts++;
        else if (part.text) text += part.text;
      });
      if (c.finishReason) finish = c.finishReason;
      if (onProgress) onProgress(text.length, { thinking: thoughts > 0 && !text });
    }

    wait(config.firstDataTimeout);
    return fetch(url, { method: 'POST', headers: headers(key, true), body: JSON.stringify(body), signal: ctrl.signal }).then(function (res) {
      status = res.status;
      if (!res.ok) return readError(res);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      // Events are separated by a blank line; each "data:" line holds one JSON response.
      function take(done) {
        var events = buf.split(/\r?\n\r?\n/);
        buf = done ? '' : events.pop();
        events.forEach(function (ev) {
          var lines = ev.split(/\r?\n/).filter(function (l) { return l.indexOf('data:') === 0; });
          if (lines.length) onEvent(lines.map(function (l) { return l.slice(5).trim(); }).join(''));
        });
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { buf += decoder.decode(); take(true); return; }
          alive();
          buf += decoder.decode(r.value, { stream: true });
          take(false);
          return pump();
        });
      }
      return pump();
    }).then(function () {
      clearTimeout(timer);
      if (streamError) throw streamError;
      if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(finish)) throw new GeminiError('blocked', MESSAGES.blocked);
      if (finish === 'MAX_TOKENS') throw new GeminiError('cut', MESSAGES.cut);
      if (!text.trim()) throw new GeminiError('empty', MESSAGES.empty);
      log({ call: call, model: model, status: status, ms: Date.now() - t0, first: first, attempt: attempt, chars: text.length, finish: finish || '?' });
      return text;
    }).catch(function (e) {
      clearTimeout(timer);
      var err = e instanceof GeminiError ? e : networkError(e, first === null ? 'first' : 'idle');
      log({ call: call, model: model, status: status, ms: Date.now() - t0, first: first, attempt: attempt, chars: text.length, error: logError(e, err) });
      throw err;
    });
  }

  // Overloaded server (503): up to config.busyDelays.length more tries, waiting longer before each.
  // Other temporary errors: one more try after config.retryDelay.
  // onRetry(err, {busy, attempt, of}) is called before each new try (attempt: the coming one; of: the most there can be).
  function withRetry(fn, onRetry) {
    var busyTries = 0;
    var otherTried = false;
    var attempt = 1;
    function run() {
      return fn(attempt).catch(function (e) {
        if (!(e instanceof GeminiError)) throw e;
        var busy = e.kind === 'busy';
        var wait;
        if (busy && busyTries < config.busyDelays.length) wait = config.busyDelays[busyTries++];
        else if (!busy && temporary(e) && !otherTried) { otherTried = true; wait = config.retryDelay; }
        else throw e;
        attempt++;
        if (onRetry) onRetry(e, { busy: busy, attempt: attempt, of: busy ? config.busyDelays.length + 1 : attempt });
        return new Promise(function (r) { setTimeout(r, wait); }).then(run);
      });
    }
    return run();
  }

  // Is the key valid? Reads the model's details (no tokens used). Resolves true or rejects with a GeminiError.
  function checkKey(key) {
    return withRetry(function (attempt) { return request('check-key', API + MODEL, key, attempt); }).then(function () { return true; });
  }

  // One model, with its retries.
  function generateWith(model, key, prompt, schema, opts) {
    var level = model === FALLBACK_MODEL ? FALLBACK_THINKING_LEVEL : THINKING_LEVEL;
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        // includeThoughts: thought summaries stream while the model thinks, so the idle timer keeps going
        // and the teacher sees "חושב…". They are not part of the answer.
        thinkingConfig: { thinkingLevel: level, includeThoughts: true }
      }
    };
    var call = opts.call || 'generate';
    return withRetry(function (attempt) {
      if (attempt > 1 && opts.onProgress) opts.onProgress(0);
      return stream(call, model, key, body, attempt, opts.onProgress).catch(function (e) {
        // If a model ever rejects the thinking setting, send it once more without it (default thinking).
        if (!(e instanceof GeminiError) || e.status !== 400 || !/thinking/i.test(e.detail || '') || !body.generationConfig.thinkingConfig) throw e;
        delete body.generationConfig.thinkingConfig;
        console.warn('[Gemini] ' + model + ' rejected thinkingLevel "' + level + '"; sending again without it.');
        return stream(call, model, key, body, attempt, opts.onProgress);
      });
    }, opts.onRetry);
  }

  // Sends one prompt, streamed; resolves with the JSON text of the reply (matching `schema`).
  // If the model stays overloaded after its retries, switches to FALLBACK_MODEL and stays with it
  // (for the next calls too) until resetModel().
  // opts: {call: name for the console, onRetry(err, info), onProgress(chars, {thinking}), onFallback(model)}
  function generate(key, prompt, schema, opts) {
    opts = opts || {};
    var model = activeModel;
    return generateWith(model, key, prompt, schema, opts).catch(function (e) {
      if (!(e instanceof GeminiError) || e.kind !== 'busy' || !FALLBACK_MODEL || model === FALLBACK_MODEL) throw e;
      activeModel = FALLBACK_MODEL;
      console.warn('[Gemini] ' + model + ' still overloaded (503) after its retries; continuing with ' + FALLBACK_MODEL + '.');
      if (opts.onFallback) opts.onFallback(FALLBACK_MODEL);
      if (opts.onProgress) opts.onProgress(0);
      return generateWith(FALLBACK_MODEL, key, prompt, schema, opts);
    });
  }

  window.Gemini = {
    MODEL: MODEL,
    FALLBACK_MODEL: FALLBACK_MODEL,
    THINKING_LEVEL: THINKING_LEVEL,
    FALLBACK_THINKING_LEVEL: FALLBACK_THINKING_LEVEL,
    config: config,
    currentModel: function () { return activeModel; },
    resetModel: function () { activeModel = MODEL; },
    LESSON_SCHEMA: LESSON_SCHEMA,
    STORY_SCHEMA: STORY_SCHEMA,
    EXERCISES_SCHEMA: EXERCISES_SCHEMA,
    REVIEW_SCHEMA: REVIEW_SCHEMA,
    NIKUD_SCHEMA: NIKUD_SCHEMA,
    GeminiError: GeminiError,
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    checkKey: checkKey,
    generate: generate,
    writeLesson: function (key, prompt, opts) { return generate(key, prompt, LESSON_SCHEMA, Object.assign({ call: 'write-lesson' }, opts)); },
    writeStory: function (key, prompt, opts) { return generate(key, prompt, STORY_SCHEMA, Object.assign({ call: 'write-story' }, opts)); },
    writeExercises: function (key, prompt, opts) { return generate(key, prompt, EXERCISES_SCHEMA, Object.assign({ call: 'write-exercises' }, opts)); },
    reviewLesson: function (key, prompt, opts) { return generate(key, prompt, REVIEW_SCHEMA, Object.assign({ call: 'review-text' }, opts)); },
    checkNikud: function (key, prompt, opts) { return generate(key, prompt, NIKUD_SCHEMA, Object.assign({ call: 'nikud-check' }, opts)); }
  };
})();
