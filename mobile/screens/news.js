/* Anjadhe Mobile — News (a Mac-served view). The Mac's News cache is
   machine-local by design; the phone shows the same headlines on request
   (never model-written — rule #1 of the news engine), cached here for the
   train ride. Tapping a story opens it in the browser. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="4" width="18" height="16" rx="2"/>'
    + '<path d="M7 8h10M7 12h10M7 16h6"/></svg>';
  var TTL = 30 * 60 * 1000;

  function render(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var view = App.macView('news', TTL);
    var d = view.data;

    var head = App.el('<header class="screen-head has-action"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<div class="head-text"><h1 class="screen-title">News</h1>'
      + '<p class="screen-sub">' + (d ? 'Your topics, from your Mac'
        : (view.loading ? 'Asking your Mac…' : 'From your Mac')) + '</p></div>';
    var actions = App.el('<div class="head-actions"></div>');
    var refresh = App.el('<button class="head-action" type="button" aria-label="Refresh"></button>');
    refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3"/>'
      + '<path d="M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 20v-5h5"/></svg>';
    refresh.addEventListener('click', function () { App.macViewRefresh('news'); });
    actions.appendChild(refresh);
    head.appendChild(actions);
    host.appendChild(head);

    if (!d || !d.items || !d.items.length) {
      var sec = App.el('<section class="section" style="--i:1"></section>');
      sec.appendChild(App.el('<p class="empty">' + (view.loading
        ? 'Fetching headlines on your Mac…'
        : App.esc(view.error || 'No headlines yet — open News on your Mac once.')) + '</p>'));
      host.appendChild(sec);
      return;
    }

    // Group by topic, keeping the Mac's ranked order inside each.
    var byTopic = {};
    var order = [];
    d.items.forEach(function (it) {
      var t = it.topic || 'Latest';
      if (!byTopic[t]) { byTopic[t] = []; order.push(t); }
      byTopic[t].push(it);
    });

    var i = 1;
    order.forEach(function (topic) {
      var sec = App.el('<section class="section"></section>');
      sec.style.setProperty('--i', i++);
      sec.appendChild(App.el('<div class="section-label">' + App.esc(topic) + '</div>'));
      var list = App.el('<div class="card list"></div>');
      byTopic[topic].forEach(function (it) {
        var row = App.el('<button class="row" type="button"></button>');
        row.innerHTML = '<span class="row-main"><span class="row-title">' + App.esc(it.title) + '</span>'
          + (it.source ? '<span class="row-sub">' + App.esc(it.source) + '</span>' : '')
          + '</span>';
        row.addEventListener('click', function () { App.openExternal(it.url); });
        list.appendChild(row);
      });
      sec.appendChild(list);
      host.appendChild(sec);
    });

    host.appendChild(App.el('<p class="view-updated" style="--i:' + i + '">Updated '
      + App.esc(App.agoLabel(d.generatedAt || view.at)) + ' from your Mac'
      + (view.error ? ' · ' + App.esc(view.error) : '') + '</p>'));
  }

  App.registerScreen('news', {
    label: 'News', icon: ICON, desktopId: 'news',
    render: render,
  });
})();
