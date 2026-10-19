/* Gemini API (Google AI Studio key), called straight from the browser. Structured output, so the reply is
   JSON that matches the schema. The key is kept in this browser's localStorage only.
   Exposes window.Gemini. */
(function () {
  'use strict';

  // Stable model with a free tier (ai.google.dev/gemini-api/docs/pricing, checked October 2026).
  var MODEL = 'gemini-3.8-flash';
  // Thinking makes answers slower; 'low' is this model's lowest level (ai.google.dev/gemini-api/docs/thinking).
  var THINKING_LEVEL = 'low';
  var API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var STORE_KEY = 'readingApp.geminiKey';

  var config = {
    timeout: 120000,     // a plain request (checking the key)
    idleTimeout: 45000,  // a streamed answer: no data at all for this long
    retryDelay: 4000     // before the one automatic retry after a temporary error
  };

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

  // Same shape as the example in js/prompt.js. `answer` is a string for every exercise type;
  // Lesson.coerce turns "0" into 0 and "true" into true.
  var LESSON_SCHEMA = {
    type: 'OBJECT',
    properties: {
      title: S,
      topic: S,
      targetWords: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { word: S, emoji: S },
          required: ['word', 'emoji'],
          propertyOrdering: ['word', 'emoji']
        }
      },
      story: { type: 'STRING', description: 'The whole story. Paragraphs separated by a newline.' },
      exercises: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', enum: ['mcq', 'tf', 'fill', 'order'] },
            question: S,
            statement: S,
            sentence: S,
            options: LIST,
            sentences: LIST,
            answer: { type: 'STRING', description: 'mcq / fill: the number of the right option, the first is "0". tf: "true" or "false". order: empty.' }
          },
          required: ['type'],
          propertyOrdering: ['type', 'question', 'statement', 'sentence', 'options', 'sentences', 'answer']
        }
      }
    },
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
    idle: 'Gemini הפסיק לשלוח נתונים (45 שניות בלי תשובה).',
    blocked: 'Gemini סירב לכתוב את התוכן הזה. נסו לנסח את הנושא אחרת.',
    cut: 'התשובה של Gemini נקטעה באמצע.',
    server: 'יש תקלה זמנית אצל Gemini.',
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
    else if (status >= 500) e = new GeminiError('server', MESSAGES.server, status);
    else e = new GeminiError('server', 'Gemini החזיר שגיאה (' + status + (text ? ': ' + text : '') + ').', status);
    // Google's own words, for the console.
    e.detail = [err.status, reason, text].filter(Boolean).join(' ');
    return e;
  }

  // Worth one automatic retry.
  function temporary(e) {
    return e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'server' && e.status >= 500);
  }

  /* ---------- Requests ---------- */

  // One line per request in the console: what, how long, HTTP status, error. Never the key.
  function log(info) {
    var line = '[Gemini] ' + info.call + ' (' + MODEL + '): ' + (info.status ? 'HTTP ' + info.status : 'no response') +
      ', ' + (info.ms / 1000).toFixed(1) + ' s' + (info.chars != null ? ', ' + info.chars + ' chars' : '') +
      (info.finish ? ', finish ' + info.finish : '') + (info.attempt > 1 ? ', retry' : '') +
      (info.error ? ' – ' + info.error : '');
    if (info.error) console.warn(line); else console.info(line);
  }

  function headers(key, json) {
    return Object.assign({ 'x-goog-api-key': key }, json ? { 'Content-Type': 'application/json' } : {});
  }

  function networkError(e, idle) {
    return e && e.name === 'AbortError' ? new GeminiError('timeout', idle ? MESSAGES.idle : MESSAGES.timeout)
      : new GeminiError('network', MESSAGES.network);
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
      var err = e instanceof GeminiError ? e : networkError(e, false);
      log({ call: call, status: status, ms: Date.now() - t0, attempt: attempt, error: logError(e, err) });
      throw err;
    });
  }

  // A streamed generateContent (server-sent events). The timer starts again on every piece of data, so an
  // answer that keeps coming is never cut; it fires only after config.idleTimeout with no data at all.
  // onProgress(chars) after every chunk. Resolves with the text.
  function stream(call, url, key, body, attempt, onProgress) {
    var t0 = Date.now();
    var status = 0;
    var ctrl = new AbortController();
    var timer = null;
    function alive() {
      clearTimeout(timer);
      timer = setTimeout(function () { ctrl.abort(); }, config.idleTimeout);
    }
    var text = '';
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
        if (part.text && !part.thought) text += part.text;
      });
      if (c.finishReason) finish = c.finishReason;
      if (onProgress) onProgress(text.length);
    }

    alive();
    return fetch(url, { method: 'POST', headers: headers(key, true), body: JSON.stringify(body), signal: ctrl.signal }).then(function (res) {
      status = res.status;
      alive();
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
      log({ call: call, status: status, ms: Date.now() - t0, attempt: attempt, chars: text.length, finish: finish || '?' });
      return text;
    }).catch(function (e) {
      clearTimeout(timer);
      var err = e instanceof GeminiError ? e : networkError(e, true);
      log({ call: call, status: status, ms: Date.now() - t0, attempt: attempt, chars: text.length, error: logError(e, err) });
      throw err;
    });
  }

  // One automatic retry after a temporary error. onRetry (optional) is called before it.
  function withRetry(fn, onRetry) {
    return fn(1).catch(function (e) {
      if (!(e instanceof GeminiError) || !temporary(e)) throw e;
      if (onRetry) onRetry(e);
      return new Promise(function (r) { setTimeout(r, config.retryDelay); }).then(function () { return fn(2); });
    });
  }

  // Is the key valid? Reads the model's details (no tokens used). Resolves true or rejects with a GeminiError.
  function checkKey(key) {
    return withRetry(function (attempt) { return request('check-key', API + MODEL, key, attempt); }).then(function () { return true; });
  }

  // Sends one prompt, streamed; resolves with the JSON text of the reply (matching `schema`).
  // opts: {call: name for the console, onRetry(err), onProgress(chars)}
  function generate(key, prompt, schema, opts) {
    opts = opts || {};
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        thinkingConfig: { thinkingLevel: THINKING_LEVEL }
      }
    };
    var url = API + MODEL + ':streamGenerateContent?alt=sse';
    return withRetry(function (attempt) {
      if (attempt > 1 && opts.onProgress) opts.onProgress(0);
      return stream(opts.call || 'generate', url, key, body, attempt, opts.onProgress).catch(function (e) {
        // If a model ever rejects the thinking setting, send it once more without it (default thinking).
        if (!(e instanceof GeminiError) || e.status !== 400 || !/thinking/i.test(e.detail || '') || !body.generationConfig.thinkingConfig) throw e;
        delete body.generationConfig.thinkingConfig;
        console.warn('[Gemini] ' + MODEL + ' rejected thinkingLevel "' + THINKING_LEVEL + '"; sending again without it.');
        return stream(opts.call || 'generate', url, key, body, attempt, opts.onProgress);
      });
    }, opts.onRetry);
  }

  window.Gemini = {
    MODEL: MODEL,
    THINKING_LEVEL: THINKING_LEVEL,
    config: config,
    LESSON_SCHEMA: LESSON_SCHEMA,
    REVIEW_SCHEMA: REVIEW_SCHEMA,
    GeminiError: GeminiError,
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    checkKey: checkKey,
    generate: generate,
    writeLesson: function (key, prompt, opts) { return generate(key, prompt, LESSON_SCHEMA, Object.assign({ call: 'write-lesson' }, opts)); },
    reviewLesson: function (key, prompt, opts) { return generate(key, prompt, REVIEW_SCHEMA, Object.assign({ call: 'review-text' }, opts)); }
  };
})();
