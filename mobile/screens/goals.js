/* Anjadhe Mobile — Projects (the desktop Goals app; labels-only law: the
   app id stays `goals`, the storage key stays `goals`). Read + light
   touches on the phone: browse by group, see a project's linked tasks
   (the synced `links` blob), mark complete. CREATION stays a conversation
   — the desktop decided authoring is a chat, so the door here is "Ask
   your assistant", not a form. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.6"/>'
    + '<circle cx="12" cy="12" r="0.8" fill="currentColor"/></svg>';

  var UNGROUPED = 'Ungrouped';
  var state = { openId: null, showDone: false };
  function reset() { state.openId = null; state.showDone = false; }

  function goals() { return App.load('goals').goals || []; }
  function groupOf(g) {
    var name = (g && typeof g.group === 'string') ? g.group.trim() : '';
    return name || UNGROUPED;
  }
  function targetLine(g) {
    if (!g.targetDate) return '';
    var overdue = g.status !== 'completed' && g.targetDate < App.todayStr();
    return '<span class="row-sub' + (overdue ? ' goal-overdue' : '') + '">'
      + (overdue ? 'Target passed ' : 'Target ') + App.esc(App.relDate(g.targetDate)) + '</span>';
  }

  function render(host) { state.openId ? renderDetail(host) : renderList(host); }

  function renderList(host) {
    var all = goals().filter(function (g) { return g.status !== 'draft'; });
    var active = all.filter(function (g) { return g.status !== 'completed'; });
    var done = all.filter(function (g) { return g.status === 'completed'; });

    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Projects</h1>'
      + '<p class="screen-sub">' + active.length + ' active'
      + (done.length ? ' · ' + done.length + ' completed' : '') + '</p>';
    host.appendChild(head);

    var i = 1;
    if (!all.length) {
      var sec = App.el('<section class="section" style="--i:1"></section>');
      sec.appendChild(App.el('<p class="empty">No projects yet — start one with your assistant.</p>'));
      host.appendChild(sec);
    } else {
      // Groups in first-seen order, Ungrouped last — the desktop's rule.
      var names = [];
      var hasUngrouped = false;
      active.forEach(function (g) {
        var n = groupOf(g);
        if (n === UNGROUPED) { hasUngrouped = true; return; }
        if (names.indexOf(n) < 0) names.push(n);
      });
      if (hasUngrouped) names.push(UNGROUPED);

      names.forEach(function (name) {
        var inGroup = active.filter(function (g) { return groupOf(g) === name; });
        if (!inGroup.length) return;
        var sec = App.el('<section class="section"></section>');
        sec.style.setProperty('--i', i++);
        if (names.length > 1 || name !== UNGROUPED) {
          sec.appendChild(App.el('<div class="section-label">' + App.esc(name) + '</div>'));
        }
        var list = App.el('<div class="card list"></div>');
        inGroup.forEach(function (g) { list.appendChild(row(g)); });
        sec.appendChild(list);
        host.appendChild(sec);
      });

      if (done.length) {
        var dsec = App.el('<section class="section"></section>');
        dsec.style.setProperty('--i', i++);
        var toggle = App.el('<button class="row-more" type="button">'
          + (state.showDone ? 'Hide' : 'Show') + ' completed (' + done.length + ')</button>');
        toggle.addEventListener('click', function () { state.showDone = !state.showDone; App.refresh(); });
        dsec.appendChild(toggle);
        if (state.showDone) {
          var dlist = App.el('<div class="card list"></div>');
          done.forEach(function (g) { dlist.appendChild(row(g)); });
          dsec.appendChild(dlist);
        }
        host.appendChild(dsec);
      }
    }

    var askSec = App.el('<section class="section"></section>');
    askSec.style.setProperty('--i', i);
    var ask = App.el('<button class="home-ask" type="button">' + App.icons.sparkle
      + '<span>Start a project with your assistant…</span></button>');
    ask.addEventListener('click', function () { askAssistant('I want to start a new project: '); });
    askSec.appendChild(ask);
    host.appendChild(askSec);
  }

  function row(g) {
    var r = App.el('<div class="row split"></div>');
    var check = App.el('<button class="check' + (g.status === 'completed' ? ' on' : '')
      + '" type="button" aria-label="Complete"></button>');
    if (g.status === 'completed') check.innerHTML = App.icons.check;
    check.addEventListener('click', function () { toggleDone(g.id); });
    var main = App.el('<button class="row-main" type="button"></button>');
    main.innerHTML = '<span class="row-title">' + App.esc(g.title || 'Untitled') + '</span>'
      + targetLine(g);
    main.addEventListener('click', function () { state.openId = g.id; App.refresh(); });
    r.appendChild(check);
    r.appendChild(main);
    return r;
  }

  function toggleDone(id) {
    var data = App.load('goals');
    var g = (data.goals || []).find(function (x) { return x.id === id; });
    if (!g) return;
    g.status = g.status === 'completed' ? 'not-started' : 'completed';
    g.modifiedAt = App.nowISO();
    App.save('goals', data);
    App.refresh();
  }

  function askAssistant(prefill) {
    var scr = App.screens.assistant;
    if (scr && scr.openCompose) scr.openCompose(prefill);
    else App.root('assistant');
  }

  // A project's linked tasks: the synced `links` blob (goals ↔ schedule).
  function linkedTasks(goalId) {
    var links = App.load('links').links || [];
    var ids = {};
    links.forEach(function (l) {
      if (l.sourceApp === 'goals' && l.sourceId === goalId && l.targetApp === 'schedule') ids[l.targetId] = 1;
      if (l.targetApp === 'goals' && l.targetId === goalId && l.sourceApp === 'schedule') ids[l.sourceId] = 1;
    });
    return (App.load('schedule').scheduleItems || [])
      .filter(function (t) { return ids[t.id]; });
  }

  function renderDetail(host) {
    var g = goals().find(function (x) { return x.id === state.openId; });
    if (!g) { state.openId = null; renderList(host); return; }

    host.appendChild(App.topbar('Projects', function () {
      App.recordBack(function () { state.openId = null; App.refresh(); });
    }));

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">' + App.esc(g.title || 'Untitled') + '</h1>'
      + '<p class="screen-sub">' + App.esc(groupOf(g))
      + (g.targetDate ? ' · target ' + App.esc(App.relDate(g.targetDate)) : '')
      + (g.status === 'completed' ? ' · completed' : '') + '</p>';
    host.appendChild(head);

    var i = 1;
    if (g.description) {
      var dsec = App.el('<section class="section"></section>');
      dsec.style.setProperty('--i', i++);
      dsec.appendChild(App.el('<p class="goal-desc">' + App.esc(g.description) + '</p>'));
      host.appendChild(dsec);
    }

    var tasks = linkedTasks(g.id).sort(function (a, b) {
      return (a.scheduledDate || '9999').localeCompare(b.scheduledDate || '9999');
    });
    var tsec = App.el('<section class="section"></section>');
    tsec.style.setProperty('--i', i++);
    tsec.appendChild(App.el('<div class="section-label">Tasks</div>'));
    if (!tasks.length) {
      tsec.appendChild(App.el('<p class="empty">No linked tasks.</p>'));
    } else {
      var list = App.el('<div class="card list"></div>');
      tasks.forEach(function (t) {
        var r = App.el('<button class="row" type="button"></button>');
        r.innerHTML = '<span class="row-main"><span class="row-title'
          + (App.taskDoneToday(t) ? ' goal-task-done' : '') + '">' + App.esc(t.title || 'Untitled') + '</span>'
          + (t.scheduledDate ? '<span class="row-sub">' + App.esc(App.relDate(t.scheduledDate)) + '</span>' : '')
          + '</span>';
        r.addEventListener('click', function () { App.openDetail('tasks', t.id); });
        list.appendChild(r);
      });
      tsec.appendChild(list);
    }
    host.appendChild(tsec);

    var asec = App.el('<section class="section"></section>');
    asec.style.setProperty('--i', i);
    var ask = App.el('<button class="home-ask" type="button">' + App.icons.sparkle
      + '<span>Ask about this project…</span></button>');
    ask.addEventListener('click', function () {
      askAssistant('About my project "' + (g.title || 'Untitled') + '": ');
    });
    asec.appendChild(ask);
    var done = App.el('<button class="btn-primary goal-done-btn" type="button">'
      + (g.status === 'completed' ? 'Reopen project' : 'Mark completed') + '</button>');
    done.addEventListener('click', function () { toggleDone(g.id); });
    asec.appendChild(done);
    host.appendChild(asec);
  }

  App.registerScreen('goals', {
    label: 'Projects', icon: ICON, desktopId: 'goals',
    render: render, reset: reset,
    openId: function (id) { state.openId = id; App.rerender(); },
  });
})();
