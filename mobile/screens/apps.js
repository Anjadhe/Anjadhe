/* Anjadhe Mobile — Apps (launcher, a pushed screen since 2026-08-31).
   A searchable grid of every app. The long tail lives here so the function
   bar never has to grow; its old bar slot went to the Assistant, and its
   doors are the Home grid icon and the ＋ sheet. Tapping a tile pushes
   that app. */
(function () {
  var state = { q: '' };
  function reset() { state.q = ''; }

  function render(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Apps</h1>';
    host.appendChild(head);

    var sec = App.el('<section class="section"></section>');
    sec.style.setProperty('--i', 1);

    var search = App.el('<input class="apps-search" type="search" placeholder="Search apps…" autocomplete="off" />');
    search.value = state.q;
    search.addEventListener('input', function () {
      state.q = search.value;
      paint(grid, state.q);
    });
    sec.appendChild(search);

    var grid = App.el('<div class="app-grid"></div>');
    paint(grid, state.q);
    sec.appendChild(grid);
    host.appendChild(sec);

    // Keep focus quirks off — don't auto-focus (would pop the keyboard on open).
  }

  // Phone id → desktop registry id, for the SYNCED launcher config: the
  // `hidden-apps` and `bundled-apps` blobs both sync, so hiding an app on
  // the Mac hides it here and an uninstalled package disappears entirely.
  // Screens may also declare `desktopId` on registration.
  var DESKTOP_IDS = { tasks: 'actions', feed: null };

  function desktopIdOf(id, scr) {
    if (scr && scr.desktopId !== undefined) return scr.desktopId;
    return DESKTOP_IDS[id] !== undefined ? DESKTOP_IDS[id] : id;
  }
  function hiddenSet() {
    var d = App.load('hidden-apps');
    var set = {};
    (Array.isArray(d.apps) ? d.apps : []).forEach(function (id) { set[id] = 1; });
    return set;
  }
  function uninstalledSet() {
    var d = App.load('bundled-apps');
    var set = {};
    (Array.isArray(d.uninstalled) ? d.uninstalled : []).forEach(function (id) { set[id] = 1; });
    return set;
  }

  function paint(grid, q) {
    grid.innerHTML = '';
    var query = (q || '').trim().toLowerCase();
    var hidden = hiddenSet();
    var uninstalled = uninstalledSet();
    App.apps.forEach(function (id) {
      var scr = App.screens[id];
      if (!scr) return;
      var deskId = desktopIdOf(id, scr);
      // Uninstalled on the Mac = not loaded anywhere (the desktop law).
      if (deskId && uninstalled[deskId]) return;
      // Hidden declutters, never disables: typing a matching query still
      // finds a hidden app by name — the same bargain ⌘K makes.
      if (deskId && hidden[deskId] && !query) return;
      if (query && (scr.label || id).toLowerCase().indexOf(query) === -1) return;
      var tile = App.el('<button class="app-tile" type="button"></button>');
      tile.innerHTML = (scr.icon || '') + '<span class="app-tile-label">' + App.esc(scr.label || id) + '</span>';
      App._attachFastTap(tile, function () { App.open(id); });
      grid.appendChild(tile);
    });
    if (!grid.children.length) {
      grid.appendChild(App.el('<p class="empty">No apps match.</p>'));
    }
  }

  App.registerScreen('apps', { label: 'Apps', render: render, reset: reset });
})();
