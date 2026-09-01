/* Anjadhe Mobile — Wellness. The one app where the phone is the BETTER
   device: you log water, meals, and mood where you are, not at your desk.
   The KINDS table is a compact copy of the desktop registry's data
   contract (same kind ids, same field ids, same 1–5 segment values, same
   `time`/`unit` stamping) so entries logged here are indistinguishable
   from the Mac's. Add + read on the phone; edit/charts stay on the Mac. */
(function () {
  var ICON = '<svg class="tab-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 20s-7-4.3-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.7-9 9-9 9z"/></svg>';

  // Same ids/labels/ranges as WellnessApp.KINDS — the data contract.
  var KINDS = {
    water: { label: 'Water', mono: 'WA', fields: [
      { id: 'amount', label: 'Amount', type: 'number', min: 1, max: 4000, required: true, unitKey: 'water' }] },
    mood: { label: 'Mood & energy', mono: 'MD', fields: [
      { id: 'mood', label: 'Mood', type: 'segment', scale: ['Rough', 'Low', 'Okay', 'Good', 'Great'], required: true },
      { id: 'energy', label: 'Energy', type: 'segment', scale: ['Drained', 'Low', 'Okay', 'Good', 'High'] },
      { id: 'notes', label: 'Notes (optional)', type: 'text' }] },
    meal: { label: 'Meal', mono: 'ML', fields: [
      { id: 'mealType', label: 'Meal', type: 'select', options: ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Drink'] },
      { id: 'description', label: 'What you ate', type: 'text' }] },
    weight: { label: 'Weight', mono: 'WT', fields: [
      { id: 'value', label: 'Weight', type: 'number', min: 1, max: 1500, required: true, unitKey: 'weight' },
      { id: 'notes', label: 'Notes (optional)', type: 'text' }] },
    activity: { label: 'Activity', mono: 'AC', fields: [
      { id: 'activityType', label: 'Activity', type: 'select', options: ['Walk', 'Run', 'Strength training', 'Suryanamaskar', 'Yoga', 'Mindful breathing', 'Cycling', 'Swim', 'Sport', 'Other'] },
      { id: 'duration', label: 'Duration (min)', type: 'number', min: 1, max: 900 },
      { id: 'notes', label: 'Notes (optional)', type: 'text' }] },
    sleep: { label: 'Sleep', mono: 'SL', dateOnly: true, fields: [
      { id: 'hours', label: 'Hours slept', type: 'number', min: 0, max: 24, required: true },
      { id: 'quality', label: 'Quality', type: 'segment', scale: ['Poor', 'Fair', 'Okay', 'Good', 'Great'] }] },
    bp: { label: 'Blood pressure', mono: 'BP', fields: [
      { id: 'systolic', label: 'Systolic', type: 'number', min: 50, max: 260, required: true },
      { id: 'diastolic', label: 'Diastolic', type: 'number', min: 30, max: 160, required: true },
      { id: 'pulse', label: 'Pulse (bpm)', type: 'number', min: 30, max: 220 }] },
    steps: { label: 'Steps', mono: 'ST', fields: [
      { id: 'value', label: 'Steps for the day', type: 'number', min: 0, max: 200000, required: true }] },
    medication: { label: 'Medication', mono: 'RX', fields: [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'dose', label: 'Dose', type: 'text' }] },
    symptom: { label: 'Symptom', mono: 'SY', fields: [
      { id: 'name', label: 'Symptom', type: 'text', required: true },
      { id: 'severity', label: 'Severity', type: 'segment', scale: ['Mild', 'Low', 'Moderate', 'High', 'Severe'] }] },
  };

  var state = { logging: null };
  function reset() { state.logging = null; }

  function data() { return App.load('wellness'); }
  function entries() { return (data().entries || []).slice(); }
  function unitFor(unitKey) {
    var units = (data().settings || {}).units || {};
    var defaults = { weight: 'lb', water: 'oz' };
    return units[unitKey] || defaults[unitKey] || '';
  }
  function nowLocal() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function addEntry(kind, values) {
    var blob = data();
    blob.entries = blob.entries || [];
    blob.entries.push(Object.assign({ id: App.newId(), kind: kind, createdAt: App.nowISO() }, values));
    App.save('wellness', blob);
  }

  function quickWater() {
    var unit = unitFor('water');
    addEntry('water', { time: nowLocal(), amount: unit === 'ml' ? 250 : 8, unit: unit });
    App.toast('Water logged');
    App.refresh();
  }

  // One human line per entry, from its own fields.
  function summarize(e) {
    var k = KINDS[e.kind];
    var seg = function (field, v) {
      var f = (k && k.fields || []).filter(function (x) { return x.id === field; })[0];
      return (f && f.scale && f.scale[v - 1]) || v;
    };
    switch (e.kind) {
      case 'water': return (e.amount || '?') + ' ' + (e.unit || '');
      case 'mood': return seg('mood', e.mood) + (e.energy ? ' · energy ' + String(seg('energy', e.energy)).toLowerCase() : '');
      case 'meal': return [e.mealType, e.description].filter(Boolean).join(' · ');
      case 'weight': return (e.value || '?') + ' ' + (e.unit || '');
      case 'activity': return [e.activityType, e.duration ? e.duration + ' min' : ''].filter(Boolean).join(' · ');
      case 'sleep': return (e.hours || '?') + ' h' + (e.quality ? ' · ' + String(seg('quality', e.quality)).toLowerCase() : '');
      case 'bp': return (e.systolic || '?') + '/' + (e.diastolic || '?') + (e.pulse ? ' · ' + e.pulse + ' bpm' : '');
      case 'steps': return (e.value || '?') + ' steps';
      case 'medication': return [e.name, e.dose].filter(Boolean).join(' · ');
      case 'symptom': return e.name || '';
      default: return e.notes || '';
    }
  }

  function render(host) { state.logging ? renderForm(host) : renderHome(host); }

  function renderHome(host) {
    host.appendChild(App.topbar(App.backTitle(), function () { App.back(); }));
    var all = entries().sort(function (a, b) { return (b.time || '').localeCompare(a.time || ''); });
    var today = all.filter(function (e) { return (e.time || '').slice(0, 10) === App.todayStr(); });

    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">Wellness</h1>'
      + '<p class="screen-sub">' + (today.length
        ? today.length + (today.length === 1 ? ' entry today' : ' entries today')
        : 'Nothing logged today') + '</p>';
    host.appendChild(head);

    // Quick log — the reason this screen exists.
    var qsec = App.el('<section class="section" style="--i:1"></section>');
    qsec.appendChild(App.el('<div class="section-label">Quick log</div>'));
    var quick = App.el('<div class="wellness-quick"></div>');
    var quickBtn = function (label, fn) {
      var b = App.el('<button class="wellness-quick-btn" type="button"></button>');
      b.textContent = label;
      b.addEventListener('click', fn);
      quick.appendChild(b);
    };
    quickBtn('+ Water', quickWater);
    quickBtn('Mood', function () { state.logging = 'mood'; App.refresh(); });
    quickBtn('Meal', function () { state.logging = 'meal'; App.refresh(); });
    quickBtn('Weight', function () { state.logging = 'weight'; App.refresh(); });
    qsec.appendChild(quick);
    // The full menu, one row of chips.
    var more = App.el('<div class="chip-row"></div>');
    Object.keys(KINDS).forEach(function (k) {
      if (['water', 'mood', 'meal', 'weight'].indexOf(k) >= 0) return;
      var c = App.el('<button class="chip" type="button"></button>');
      c.textContent = KINDS[k].label;
      c.addEventListener('click', function () { state.logging = k; App.refresh(); });
      more.appendChild(c);
    });
    qsec.appendChild(more);
    host.appendChild(qsec);

    // Recent entries (14 days) — read-only timeline.
    var recent = all.filter(function (e) {
      var d = new Date(); d.setDate(d.getDate() - 14);
      return (e.time || '') >= App.dateStr(d);
    }).slice(0, 40);
    var rsec = App.el('<section class="section" style="--i:2"></section>');
    rsec.appendChild(App.el('<div class="section-label">Recent</div>'));
    if (!recent.length) {
      rsec.appendChild(App.el('<p class="empty">Nothing in the last two weeks.</p>'));
    } else {
      var list = App.el('<div class="card list"></div>');
      recent.forEach(function (e) {
        var k = KINDS[e.kind] || { mono: '··', label: e.kind };
        var row = App.el('<div class="row"></div>');
        row.innerHTML = '<span class="wellness-mono">' + App.esc(k.mono) + '</span>'
          + '<span class="row-main"><span class="row-title">' + App.esc(summarize(e) || k.label) + '</span>'
          + '<span class="row-sub">' + App.esc(k.label + ' · ' + App.relDate(e.time)
            + ((e.time || '').length > 10 ? ' ' + App.fmtTime((e.time || '').slice(11, 16)) : '')) + '</span></span>';
        list.appendChild(row);
      });
      rsec.appendChild(list);
    }
    host.appendChild(rsec);
  }

  function renderForm(host) {
    var k = KINDS[state.logging];
    if (!k) { state.logging = null; renderHome(host); return; }
    host.appendChild(App.topbar('Wellness', function () {
      App.recordBack(function () { state.logging = null; App.refresh(); });
    }));
    var head = App.el('<header class="screen-head"></header>');
    head.style.setProperty('--i', 0);
    head.innerHTML = '<h1 class="screen-title">' + App.esc(k.label) + '</h1>';
    host.appendChild(head);

    var form = App.el('<div class="form"></div>');
    var collect = {};

    k.fields.forEach(function (f) {
      var label = f.label + (f.unitKey ? ' (' + unitFor(f.unitKey) + ')' : '');
      var fl = App.field(label);
      if (f.type === 'number') {
        var inp = App.el('<input class="field-input" type="number" inputmode="decimal" />');
        fl.appendChild(inp);
        collect[f.id] = function () { return inp.value === '' ? null : Number(inp.value); };
      } else if (f.type === 'select') {
        fl.appendChild(App.select(f.options.map(function (o) { return [o, o]; }), f.options[0],
          function (v) { collect._sel = collect._sel || {}; collect._sel[f.id] = v; }));
        collect[f.id] = function () { return (collect._sel && collect._sel[f.id]) || f.options[0]; };
      } else if (f.type === 'segment') {
        var picked = { v: null };
        var seg = App.el('<div class="segmented"></div>');
        f.scale.forEach(function (word, idx) {
          var b = App.el('<button class="seg" type="button"></button>');
          b.textContent = word;
          b.addEventListener('click', function () {
            picked.v = idx + 1; // 1–5, the desktop's stored value
            seg.querySelectorAll('.seg').forEach(function (x) { x.classList.remove('on'); });
            b.classList.add('on');
          });
          seg.appendChild(b);
        });
        fl.appendChild(seg);
        collect[f.id] = function () { return picked.v; };
      } else {
        var t = App.el('<input class="field-input" type="text" />');
        fl.appendChild(t);
        collect[f.id] = function () { return t.value.trim(); };
      }
      form.appendChild(fl);
    });

    var save = App.el('<button class="btn-primary" type="button">Save</button>');
    save.addEventListener('click', function () {
      var values = { time: k.dateOnly ? App.todayStr() + 'T07:00' : nowLocal() };
      for (var j = 0; j < k.fields.length; j++) {
        var f = k.fields[j];
        var v = collect[f.id]();
        if (f.required && (v == null || v === '')) { App.toast(f.label + ' is required'); return; }
        if (f.type === 'number' && v != null
            && (isNaN(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max))) {
          App.toast(f.label + ' looks out of range'); return;
        }
        values[f.id] = v;
        if (f.unitKey) values.unit = unitFor(f.unitKey);
      }
      addEntry(state.logging, values);
      App.toast(k.label + ' saved');
      state.logging = null;
      App.refresh();
    });
    form.appendChild(save);
    host.appendChild(form);
  }

  App.registerScreen('wellness', {
    label: 'Wellness', icon: ICON, desktopId: 'wellness',
    render: render, reset: reset,
  });
})();
