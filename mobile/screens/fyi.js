/* Anjadhe Mobile — Email AI (a Mac-served view; app id `fyi`, the
   desktop's law). The mailbox deliberately never syncs (Gmail is source
   of truth, SQLite on the Mac), so this screen is a read-only DIGEST the
   Mac builds on request — insight titles, dates, amounts, live trips —
   cached here and honest about its age when the Mac is unreachable. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="5" width="18" height="14" rx="2"/>'
    + '<path d="M3.5 7l8.5 6 8.5-6"/></svg>';
  var TTL = 5 * 60 * 1000;

  var TYPE_LABELS = {
    task: 'Tasks', appointment: 'Appointments', reservation: 'Reservations',
    payment: 'Payments', receipt: 'Receipts', code: 'Codes', shipping: 'Deliveries',
    newsletter: 'Newsletters', promotion: 'Promotions', general: 'General',
  };
  var typeLabel = function (t) {
    return TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Other');
  };

  var state = { expanded: null };
  function reset() { state.expanded = null; }

  function render(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var view = App.macView('insights', TTL);
    var d = view.data;

    var head = App.el('<header class="screen-head has-action"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<div class="head-text"><h1 class="screen-title">Email AI</h1>'
      + '<p class="screen-sub">' + (d
        ? (d.unread ? d.unread + ' unread insight' + (d.unread === 1 ? '' : 's') : 'All caught up')
        : (view.loading ? 'Asking your Mac…' : 'From your Mac')) + '</p></div>';
    var actions = App.el('<div class="head-actions"></div>');
    var refresh = App.el('<button class="head-action" type="button" aria-label="Refresh"></button>');
    refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3"/>'
      + '<path d="M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 20v-5h5"/></svg>';
    refresh.addEventListener('click', function () { App.macViewRefresh('insights'); });
    actions.appendChild(refresh);
    head.appendChild(actions);
    host.appendChild(head);

    var i = 1;
    if (!d) {
      var sec = App.el('<section class="section" style="--i:1"></section>');
      sec.appendChild(App.el('<p class="empty">' + (view.loading
        ? 'Building the digest on your Mac…'
        : App.esc(view.error || 'Could not reach your Mac yet.')) + '</p>'));
      host.appendChild(sec);
      return;
    }

    // Trips first — the same "what wants you" ordering as the desktop.
    if (d.trips && d.trips.length) {
      var tsec = App.el('<section class="section"></section>');
      tsec.style.setProperty('--i', i++);
      tsec.appendChild(App.el('<div class="section-label">Trips</div>'));
      var tlist = App.el('<div class="card list"></div>');
      d.trips.forEach(function (t) {
        var row = App.el('<div class="row"></div>');
        row.innerHTML = '<span class="row-main"><span class="row-title">' + App.esc(t.label || 'Trip') + '</span>'
          + '<span class="row-sub">' + App.esc([t.start, t.end].filter(Boolean).map(App.relDate.bind(App)).join(' – ')) + '</span></span>';
        tlist.appendChild(row);
      });
      tsec.appendChild(tlist);
      host.appendChild(tsec);
    }

    // Insights grouped by type, unread first inside each (the Mac sorted).
    var byType = {};
    var order = [];
    (d.insights || []).forEach(function (a) {
      if (!byType[a.type]) { byType[a.type] = []; order.push(a.type); }
      byType[a.type].push(a);
    });
    if (!order.length) {
      var esec = App.el('<section class="section"></section>');
      esec.style.setProperty('--i', i++);
      esec.appendChild(App.el('<p class="empty">No insights in the window.</p>'));
      host.appendChild(esec);
    }
    order.forEach(function (type) {
      var sec = App.el('<section class="section"></section>');
      sec.style.setProperty('--i', i++);
      sec.appendChild(App.el('<div class="section-label">' + App.esc(typeLabel(type)) + '</div>'));
      var list = App.el('<div class="card list"></div>');
      byType[type].forEach(function (a) {
        var row = App.el('<button class="row" type="button"></button>');
        var sub = [a.from, a.matterDate ? App.relDate(a.matterDate) : '', a.amount ? String(a.amount) : '']
          .filter(Boolean).join(' · ');
        row.innerHTML = '<span class="row-main"><span class="row-title">'
          + (a.read ? '' : '<span class="fyi-dot"></span>') + App.esc(a.title) + '</span>'
          + (sub ? '<span class="row-sub">' + App.esc(sub) + '</span>' : '')
          + (state.expanded === a.emailId && a.summary
            ? '<span class="fyi-summary">' + App.esc(a.summary) + '</span>' : '')
          + '</span>';
        row.addEventListener('click', function () {
          state.expanded = state.expanded === a.emailId ? null : a.emailId;
          App.refresh();
        });
        list.appendChild(row);
      });
      sec.appendChild(list);
      host.appendChild(sec);
    });

    host.appendChild(App.el('<p class="view-updated" style="--i:' + i + '">Updated '
      + App.esc(App.agoLabel(view.at)) + ' from your Mac'
      + (view.error ? ' · ' + App.esc(view.error) : '') + '</p>'));
  }

  App.registerScreen('fyi', {
    label: 'Email AI', icon: ICON, desktopId: 'fyi',
    render: render, reset: reset,
  });
})();
