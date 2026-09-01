/* Anjadhe Mobile — Assistant (root).
   Chat with the assistant that runs on the paired Mac — the product spine,
   on the phone. The transcript IS the synced conversation blob
   (`agent-conversations`, channel:'mobile'): sends go over the encrypted
   channel (AnjadheSync.sendChat), the Mac runs the full assistant and
   pushes the reply back (chat-reply), and the same reply rides sync — so
   a dropped socket loses nothing, it just arrives with the next sync.
   Local optimistic bubbles cover the gap between a send and the synced
   copy of the conversation catching up. */
(function () {
  var SESSION_GAP_MS = 3 * 60 * 60 * 1000; // mirrors MobileChannel on the Mac
  var REPLY_TIMEOUT_MS = 5 * 60 * 1000;    // stop the spinner; the run may still land via sync

  var NEW_CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 5v14M5 12h14"/></svg>';
  var SEND_ICON = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 19V6"/><path d="M6 11l6-6 6 6"/></svg>';

  var state = {
    thread: [],        // optimistic entries: {role, content, at, error}
    pending: null,     // {at} while a send awaits its reply
    pendingTimer: null,
    startFresh: false, // "New chat" tapped — next send starts a new conversation
    freshAt: null,
    draft: '',
    autofocus: false,
  };

  // Roots re-render on every visit; the chat state deliberately survives
  // (reset would drop an in-flight reply). Only "New chat" clears it.
  function reset() { /* keep chat state across visits */ }

  // ---- data --------------------------------------------------------------
  function currentConv() {
    var blob = App.load('agent-conversations');
    var convs = (blob && blob.conversations) || [];
    var latest = null;
    for (var i = 0; i < convs.length; i++) {
      var c = convs[i];
      if (c && c.channel === 'mobile'
          && (!latest || (c.updatedAt || '') > (latest.updatedAt || ''))) {
        latest = c;
      }
    }
    return latest;
  }
  function inSession(conv) {
    if (!conv) return false;
    var at = new Date(conv.updatedAt || conv.createdAt || 0).getTime();
    return Date.now() - at <= SESSION_GAP_MS;
  }

  // Drop optimistic entries the synced conversation has caught up with,
  // and clear the pending spinner once the reply is in the transcript.
  // Two catch-up signals, both needed: the timestamp (the Mac saved after
  // our local entry) AND content identity (a pushed chat-reply arrives
  // AFTER the conv's updatedAt stamp, so the timestamp alone would let it
  // render twice once sync delivers the same message).
  function reconcile(conv) {
    if (!conv) return;
    var syncedAt = new Date(conv.updatedAt || 0).getTime();
    var tail = (conv.messages || []).slice(-12);
    var inConv = function (m) {
      return tail.some(function (cm) {
        return cm && cm.role === m.role && cm.content === m.content;
      });
    };
    state.thread = state.thread.filter(function (m) {
      if (m.at <= syncedAt) return false;
      if (!m.error && inConv(m)) return false;
      return true;
    });
    if (state.pending) {
      var msgs = conv.messages || [];
      var last = msgs[msgs.length - 1];
      if (syncedAt > state.pending.at && last && last.role === 'assistant') {
        clearPending();
      }
    }
  }
  function clearPending() {
    state.pending = null;
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
  }

  // ---- chat pushes (replies land whatever screen is open) ----------------
  // Deferred to DOMContentLoaded: mobile-sync.js (which defines AnjadheSync)
  // loads after the screen scripts.
  document.addEventListener('DOMContentLoaded', function () {
    if (!window.AnjadheSync || typeof window.AnjadheSync.onChat !== 'function') return;
    window.AnjadheSync.onChat(function (msg) {
      if (msg.type === 'chat-ack') {
        if (state.pending) state.pending.acked = true;
      } else if (msg.type === 'chat-reply') {
        clearPending();
        state.thread.push({ role: 'assistant', content: msg.text || '', at: Date.now() });
      } else if (msg.type === 'chat-error') {
        clearPending();
        state.thread.push({ role: 'assistant', content: msg.text || 'Something went wrong.', at: Date.now(), error: true });
      } else {
        return;
      }
      if (App.current === 'assistant') App.refresh();
    });
  });

  // ---- sending -----------------------------------------------------------
  function send(text) {
    var t = String(text || '').trim();
    if (!t || state.pending) return false;
    var sync = window.AnjadheSync;
    if (!sync || !sync.isPaired()) return false;
    var conv = currentConv();
    var opts = {};
    if (state.startFresh) opts.fresh = true;
    else if (conv && inSession(conv)) opts.convId = conv.id;
    if (!sync.sendChat(t, opts)) {
      App.toast('Not connected to your Mac yet — retrying');
      return false;
    }
    state.thread.push({ role: 'user', content: t, at: Date.now() });
    state.pending = { at: Date.now(), acked: false };
    state.draft = '';
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(function () {
      if (!state.pending) return;
      clearPending();
      state.thread.push({
        role: 'assistant', at: Date.now(), error: true,
        content: 'No reply yet — the run may still be going on your Mac. The answer will sync in when it finishes.',
      });
      if (App.current === 'assistant') App.refresh();
    }, REPLY_TIMEOUT_MS);
    return true;
  }

  // ---- render ------------------------------------------------------------
  function stateSub(s, transport) {
    if (s === 'idle' || s === 'syncing') {
      return transport === 'direct' ? 'Connected to your Mac on this network'
        : 'Connected to your Mac via encrypted relay';
    }
    if (s === 'connecting') return 'Connecting to your Mac…';
    return 'Offline — your Mac is unreachable';
  }

  function render(host) {
    var sync = window.AnjadheSync;
    var paired = !!(sync && sync.isPaired && sync.isPaired());

    // --- header ---
    var head = App.el('<header class="screen-head has-action"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<div class="head-text">'
      + '<h1 class="screen-title">Assistant</h1>'
      + '<p class="screen-sub chat-status"></p>'
      + '</div>';
    var sub = head.querySelector('.chat-status');
    if (!paired) {
      sub.textContent = 'Runs on your Mac';
    } else if (sync && typeof sync.onStateChange === 'function') {
      var unsub = sync.onStateChange(function (s) {
        if (!document.contains(sub)) { if (unsub) unsub(); return; }
        sub.textContent = stateSub(s, sync.getTransport ? sync.getTransport() : null);
      });
    }
    var actions = App.el('<div class="head-actions"></div>');
    var fresh = App.el('<button class="head-action" type="button" aria-label="New chat"></button>');
    fresh.innerHTML = NEW_CHAT_ICON;
    fresh.addEventListener('click', function () {
      clearPending();
      state.thread = [];
      state.startFresh = true;
      state.freshAt = Date.now();
      App.refresh();
    });
    actions.appendChild(fresh);
    head.appendChild(actions);
    host.appendChild(head);

    // --- not paired: the honest empty state, with the door to pairing ---
    if (!paired) {
      var pair = App.el('<section class="section" style="--i:1">'
        + '<div class="card chat-intro">'
        + '<p>Chat with your assistant — the same one as on your Mac, with your '
        + 'tasks, notes, and tools. It runs on your Mac; this phone reaches it '
        + 'over an encrypted connection only you hold the keys to.</p>'
        + '<button class="btn-primary" type="button">Pair with your Mac</button>'
        + '</div></section>');
      pair.querySelector('button').addEventListener('click', function () { App.open('settings'); });
      host.appendChild(pair);
      return;
    }

    // --- transcript ---
    var latest = currentConv();
    // "New chat" holds the view empty until the fresh conversation the Mac
    // creates for it syncs in — then it becomes the transcript.
    if (state.startFresh && state.freshAt && latest
        && new Date(latest.createdAt || 0).getTime() > state.freshAt) {
      state.startFresh = false;
    }
    var conv = state.startFresh ? null : latest;
    reconcile(conv);
    var log = App.el('<section class="chat-log" style="--i:1"></section>');

    var msgs = [];
    if (conv) {
      (conv.messages || []).forEach(function (m) {
        if (!m || typeof m.content !== 'string' || !m.content.trim()) return;
        if (m.role !== 'user' && m.role !== 'assistant') return;
        msgs.push({ role: m.role, content: m.content });
      });
    }
    state.thread.forEach(function (m) { msgs.push(m); });

    if (!msgs.length && !state.pending) {
      log.appendChild(App.el('<div class="chat-intro-quiet">'
        + '<p class="empty">Ask anything — your tasks, your notes, your day. '
        + 'Answers come from your Mac.</p></div>'));
    }

    msgs.forEach(function (m) {
      if (m.role === 'user') {
        var u = App.el('<div class="chat-msg chat-msg--user"></div>');
        u.textContent = m.content;
        log.appendChild(u);
      } else {
        var a = App.el('<div class="chat-msg chat-msg--assistant'
          + (m.error ? ' chat-msg--error' : '') + '"></div>');
        a.innerHTML = App.formatContent(m.content);
        a.addEventListener('click', function (e) {
          var link = e.target.closest('a');
          if (link) { e.preventDefault(); App.handleLinkTap(link); }
        });
        log.appendChild(a);
      }
    });

    if (state.pending) {
      log.appendChild(App.el('<div class="chat-msg chat-msg--assistant chat-msg--thinking">'
        + (state.pending.acked ? 'Your Mac is thinking…' : 'Reaching your Mac…') + '</div>'));
    }
    host.appendChild(log);

    // --- composer (fixed above the function bar; CSS pins it) ---
    var composer = App.el('<div class="chat-composer"></div>');
    var input = App.el('<textarea class="chat-input" rows="1" placeholder="Ask your assistant…"></textarea>');
    input.value = state.draft || '';
    var grow = function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };
    input.addEventListener('input', function () { state.draft = input.value; grow(); });
    var sendBtn = App.el('<button class="chat-send" type="button" aria-label="Send">' + SEND_ICON + '</button>');
    var doSend = function () {
      if (send(input.value)) { input.value = ''; grow(); App.refresh(); }
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    composer.appendChild(input);
    composer.appendChild(sendBtn);
    host.appendChild(composer);
    grow();

    // Keep the newest message in view; the composer is fixed so the log
    // carries bottom padding for it (CSS).
    requestAnimationFrame(function () {
      var sc = document.getElementById('screen');
      if (sc) sc.scrollTop = sc.scrollHeight;
      if (state.autofocus) { state.autofocus = false; input.focus(); }
    });
  }

  App.registerScreen('assistant', {
    label: 'Assistant',
    render: render,
    reset: reset,
    // Door for the Home composer: carry the typed text in and focus.
    openCompose: function (prefill) {
      if (prefill) state.draft = prefill;
      state.autofocus = true;
      App.root('assistant');
    },
  });
})();
