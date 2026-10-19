/* Automatic nikud through Dicta's Nakdan, with the userscript in userscripts/dicta-bridge.user.js.
   Opens Dicta in a new window, waits for the script's "ready", sends the text without nikud and waits
   for the vocalized text. Only messages from Dicta's origin and from that window are accepted.
   Exposes window.DictaBridge. */
(function () {
  'use strict';

  var ORIGIN = 'https://nakdan.dicta.org.il';
  var DICTA_URL = ORIGIN + '/';

  var config = {
    readyTimeout: 10000, // no "ready" by then: the script is not installed (or not allowed to run)
    baseTimeout: 30000,  // after sending the text: this, plus partTimeout per 5000 characters
    partTimeout: 30000
  };

  var current = null;

  // handlers: {status(kind, info), result(text), fail(reason, message)}
  //   status kinds: 'opening', 'working' ({part, parts})
  //   fail reasons: 'blocked' (popup blocked), 'missing' (no script), 'closed', 'error' (from the script), 'timeout'
  function start(text, handlers) {
    cancel();
    var id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var win = window.open(DICTA_URL, 'dicta-bridge');
    var session = { id: id, done: false };
    current = session;
    if (!win) { end(); handlers.fail('blocked'); return session; }

    var sent = false;
    var readyTimer = setTimeout(function () {
      if (sent) return;
      end();
      handlers.fail('missing');
    }, config.readyTimeout);
    var workTimer = null;
    var closedTimer = setInterval(function () {
      if (win.closed) { end(); handlers.fail('closed'); }
    }, 500);

    function onMessage(e) {
      if (e.origin !== ORIGIN || e.source !== win) return;
      var d = e.data;
      if (!d || d.source !== 'dicta-bridge') return;
      if (d.type === 'ready') {
        if (sent) return;
        sent = true;
        clearTimeout(readyTimer);
        win.postMessage({ source: 'reading-app', type: 'nikud', id: id, text: text }, ORIGIN);
        var parts = Math.max(1, Math.ceil(text.length / 5000));
        workTimer = setTimeout(function () { end(); handlers.fail('timeout'); }, config.baseTimeout + parts * config.partTimeout);
        handlers.status('working', { part: 1, parts: parts });
        return;
      }
      if (d.id !== id) return;
      if (d.type === 'progress') {
        handlers.status('working', { part: d.part, parts: d.parts });
      } else if (d.type === 'result' && typeof d.text === 'string') {
        end();
        handlers.result(d.text);
      } else if (d.type === 'error') {
        end();
        handlers.fail('error', String(d.message || ''));
      }
    }

    function end() {
      session.done = true;
      clearTimeout(readyTimer);
      clearTimeout(workTimer);
      clearInterval(closedTimer);
      window.removeEventListener('message', onMessage);
      if (current === session) current = null;
    }

    session.end = end;
    window.addEventListener('message', onMessage);
    handlers.status('opening');
    return session;
  }

  function cancel() {
    if (current && current.end) current.end();
    current = null;
  }

  function running() { return !!current; }

  window.DictaBridge = { ORIGIN: ORIGIN, config: config, start: start, cancel: cancel, running: running };
})();
