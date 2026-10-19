/* Gemini API (Google AI Studio key), called straight from the browser. Structured output, so the reply is
   JSON that matches the schema. The key is kept in this browser's localStorage only.
   Exposes window.Gemini. */
(function () {
  'use strict';

  // Stable model with a free tier (ai.google.dev/gemini-api/docs/pricing, checked October 2026).
  var MODEL = 'gemini-3.8-flash';
  var API = 'https://generativelanguage.googleapis.com/v1beta/models/';
  var STORE_KEY = 'readingApp.geminiKey';

  var config = {
    timeout: 120000,  // one request
    retryDelay: 4000  // before the one automatic retry after a temporary error
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
    if (status === 429) return new GeminiError('quota', MESSAGES.quota, status);
    if (status === 401 || status === 403 || reason === 'API_KEY_INVALID' || /api key/i.test(text)) {
      return new GeminiError('key', MESSAGES.key, status);
    }
    if (status >= 500) return new GeminiError('server', MESSAGES.server, status);
    return new GeminiError('server', 'Gemini החזיר שגיאה (' + status + (text ? ': ' + text : '') + ').', status);
  }

  // Worth one automatic retry.
  function temporary(e) {
    return e.kind === 'network' || e.kind === 'timeout' || (e.kind === 'server' && e.status >= 500);
  }

  /* ---------- Requests ---------- */

  function request(method, url, key, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, config.timeout) : null;
    return fetch(url, {
      method: method,
      headers: Object.assign({ 'x-goog-api-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) throw errorFromResponse(res.status, data);
        return data;
      });
    }, function (e) {
      clearTimeout(timer);
      throw e && e.name === 'AbortError' ? new GeminiError('timeout', MESSAGES.timeout) : new GeminiError('network', MESSAGES.network);
    });
  }

  // One automatic retry after a temporary error. onRetry (optional) is called before it.
  function withRetry(fn, onRetry) {
    return fn().catch(function (e) {
      if (!(e instanceof GeminiError) || !temporary(e)) throw e;
      if (onRetry) onRetry(e);
      return new Promise(function (r) { setTimeout(r, config.retryDelay); }).then(fn);
    });
  }

  // Is the key valid? Reads the model's details (no tokens used). Resolves true or rejects with a GeminiError.
  function checkKey(key) {
    return withRetry(function () { return request('GET', API + MODEL, key); }).then(function () { return true; });
  }

  // Sends one prompt; resolves with the JSON text of the reply (matching `schema`).
  function generate(key, prompt, schema, onRetry) {
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
    };
    return withRetry(function () {
      return request('POST', API + MODEL + ':generateContent', key, body).then(function (data) {
        if (data && data.promptFeedback && data.promptFeedback.blockReason) throw new GeminiError('blocked', MESSAGES.blocked);
        var c = data && data.candidates && data.candidates[0];
        if (!c) throw new GeminiError('empty', MESSAGES.empty);
        var text = ((c.content && c.content.parts) || []).map(function (p) { return p.text || ''; }).join('');
        if (c.finishReason === 'MAX_TOKENS') throw new GeminiError('cut', MESSAGES.cut);
        if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(c.finishReason || '')) throw new GeminiError('blocked', MESSAGES.blocked);
        if (!text.trim()) throw new GeminiError('empty', MESSAGES.empty);
        return text;
      });
    }, onRetry);
  }

  window.Gemini = {
    MODEL: MODEL,
    config: config,
    LESSON_SCHEMA: LESSON_SCHEMA,
    REVIEW_SCHEMA: REVIEW_SCHEMA,
    GeminiError: GeminiError,
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    checkKey: checkKey,
    generate: generate,
    writeLesson: function (key, prompt, onRetry) { return generate(key, prompt, LESSON_SCHEMA, onRetry); },
    reviewLesson: function (key, prompt, onRetry) { return generate(key, prompt, REVIEW_SCHEMA, onRetry); }
  };
})();
