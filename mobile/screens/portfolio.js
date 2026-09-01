/* Anjadhe Mobile — Portfolio (a Mac-served view). The records sync, but
   quotes are machine-local on the Mac — so the phone asks for the same
   computed numbers the desktop glance card shows (PortfolioApp.getSummary,
   nothing recomputed here) and renders them read-only, honest about age.
   Semantic red/green only, the Minimal Book rule. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 19V10M10 19V5M16 19v-8M21 19H3.5"/></svg>';
  var TTL = 5 * 60 * 1000;

  function money(v) {
    if (!isFinite(v)) return '—';
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function pl(v, pct) {
    if (!isFinite(v)) return '';
    var sign = v > 0 ? '+' : v < 0 ? '−' : '';
    var body = sign + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
    if (isFinite(pct)) body += ' (' + sign + Math.abs(pct).toFixed(1) + '%)';
    return body;
  }
  function plClass(v) { return v > 0 ? 'pf-up' : v < 0 ? 'pf-down' : ''; }

  function render(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var view = App.macView('portfolio', TTL);
    var d = view.data;

    var head = App.el('<header class="screen-head has-action"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<div class="head-text"><h1 class="screen-title">Portfolio</h1>'
      + '<p class="screen-sub">' + (d ? 'From your Mac'
        : (view.loading ? 'Asking your Mac…' : 'From your Mac')) + '</p></div>';
    var actions = App.el('<div class="head-actions"></div>');
    var refresh = App.el('<button class="head-action" type="button" aria-label="Refresh"></button>');
    refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3"/>'
      + '<path d="M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 20v-5h5"/></svg>';
    refresh.addEventListener('click', function () { App.macViewRefresh('portfolio'); });
    actions.appendChild(refresh);
    head.appendChild(actions);
    host.appendChild(head);

    if (!d) {
      var sec = App.el('<section class="section" style="--i:1"></section>');
      sec.appendChild(App.el('<p class="empty">' + (view.loading
        ? 'Computing on your Mac…'
        : App.esc(view.error || 'Could not reach your Mac yet.')) + '</p>'));
      host.appendChild(sec);
      return;
    }

    var headline = (d.liabilitiesTotal > 0 && isFinite(d.netWorth)) ? d.netWorth : d.totalValue;
    var msec = App.el('<section class="section" style="--i:1"></section>');
    msec.innerHTML = '<div class="pf-masthead">'
      + '<div class="pf-value">' + money(headline) + '</div>'
      + (d.liabilitiesTotal > 0 ? '<div class="pf-note">Net worth · assets ' + money(d.totalValue) + '</div>' : '')
      + '<div class="pf-changes">'
      + (isFinite(d.dayChange) ? '<span class="' + plClass(d.dayChange) + '">' + pl(d.dayChange, d.dayChangePercent) + ' today</span>' : '')
      + (isFinite(d.totalPL) ? '<span class="' + plClass(d.totalPL) + '">' + pl(d.totalPL, d.totalPLPercent) + ' all time</span>' : '')
      + '</div></div>';
    host.appendChild(msec);

    if (d.movers && d.movers.length) {
      var wsec = App.el('<section class="section" style="--i:2"></section>');
      wsec.appendChild(App.el('<div class="section-label">Today’s movers</div>'));
      var list = App.el('<div class="card list"></div>');
      d.movers.forEach(function (h) {
        var row = App.el('<div class="row split"></div>');
        row.innerHTML = '<span class="row-main"><span class="row-title">' + App.esc(h.ticker) + '</span></span>'
          + '<span class="pf-mover ' + plClass(h.dayChange) + '">' + pl(h.dayChange, h.dayChangePercent) + '</span>';
        list.appendChild(row);
      });
      wsec.appendChild(list);
      host.appendChild(wsec);
    }

    host.appendChild(App.el('<p class="view-updated" style="--i:3">Updated '
      + App.esc(App.agoLabel(view.at)) + ' from your Mac'
      + (view.error ? ' · ' + App.esc(view.error) : '') + '</p>'));
  }

  App.registerScreen('portfolio', {
    label: 'Portfolio', icon: ICON, desktopId: 'portfolio',
    render: render,
  });
})();
