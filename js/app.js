(function () {
  'use strict';

  const TABLE = 'habits_data';
  const THEME_KEY = 'field-log-theme';
  const SKIP_KEY = 'field-log-skip-enabled';

  const SWATCHES = [
    '#e0a93b', '#b5482a', '#6b8f5c', '#4a7a8c',
    '#7a6bb0', '#c25a8a', '#5b7fc7', '#c7943f',
  ];
  const PROFILE_COLOR = '#e0a93b';
  const DAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Mon..Sun
  const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ALL_DAYS = [true, true, true, true, true, true, true];

  let habits = [];
  let modalState = null;
  let openJournals = {};
  let currentView = 'log'; // 'log' | 'profile' | 'settings'
  let currentTheme = 'dark'; // resolved theme actually applied

  let sb = null;
  let session = null;
  let authNotice = '';

  // ============ pure helpers (exported for tests via module.exports below) ============

  function configReady() {
    return typeof window !== 'undefined' && window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
      !window.SUPABASE_URL.startsWith('PASTE_') && !window.SUPABASE_ANON_KEY.startsWith('PASTE_');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function startOfDay(d) { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
  function todayDate() { return startOfDay(new Date()); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function mondayOf(d) { const day = d.getDay(); const diff = (day === 0 ? -6 : 1 - day); return addDays(startOfDay(d), diff); }
  function isoIndex(d) { return (d.getDay() + 6) % 7; } // Mon=0 .. Sun=6
  function uid() { return 'h_' + Math.random().toString(36).slice(2, 9); }

  function isScheduled(habit, date) {
    const sched = habit.schedule;
    if (!sched || sched.length !== 7) return true;
    return !!sched[isoIndex(date)];
  }

  // A skipped day = missed because of an unplanned event. It is treated like a
  // non-scheduled day: it neither breaks a streak nor counts toward it.
  function isSkipped(entry) { return !!(entry && entry.skipped); }

  function entryHas(habit, entry) {
    if (!entry) return false;
    return habit.mode === 'hours' ? Number(entry.value) > 0 : !!entry.value;
  }

  function buildWeeks(weeksBack) {
    weeksBack = weeksBack || 52;
    const today = todayDate();
    const thisMonday = mondayOf(today);
    const firstMonday = addDays(thisMonday, -weeksBack * 7);
    const weeks = [];
    let cursor = firstMonday;
    for (let i = 0; i <= weeksBack; i++) {
      const week = [];
      for (let j = 0; j < 7; j++) week.push(addDays(cursor, j));
      weeks.push(week);
      cursor = addDays(cursor, 7);
    }
    return weeks;
  }

  // Flat, chronological list of dates (<= today) from a weeks[] grid that are
  // "scheduled" for this habit. Non-scheduled days are skipped entirely, so
  // gaps on those days never break a streak.
  function scheduledDatesInWeeks(habit, weeks) {
    const today = todayDate();
    const list = [];
    weeks.forEach(week => week.forEach(d => {
      if (d <= today && isScheduled(habit, d) && !isSkipped(habit.entries[toKey(d)])) list.push(d);
    }));
    return list;
  }

  function computeStreaks(habit, weeks) {
    const dates = scheduledDatesInWeeks(habit, weeks);
    if (dates.length === 0) return { longest: 0, current: 0, count: 0, total: 0, avg: 0 };

    let longest = 0, run = 0, count = 0, total = 0;
    dates.forEach(d => {
      const entry = habit.entries[toKey(d)];
      if (entryHas(habit, entry)) {
        run++; count++;
        if (habit.mode === 'hours') total += Number(entry.value) || 0;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    });

    const today = todayDate();
    let current = 0;
    for (let i = dates.length - 1; i >= 0; i--) {
      const d = dates[i];
      const entry = habit.entries[toKey(d)];
      const has = entryHas(habit, entry);
      const isToday = toKey(d) === toKey(today);
      if (has) { current++; }
      else if (isToday) { continue; } // grace: today not logged yet doesn't break the streak
      else { break; }
    }

    const avg = habit.mode === 'hours' && count > 0 ? total / count : 0;
    return { longest, current, count, total, avg };
  }

  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
      const h = Math.round(Math.max(0, Math.min(255, x))).toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');
  }
  function mix(hexA, hexB, ratio) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex(a.r + (b.r - a.r) * ratio, a.g + (b.g - a.g) * ratio, a.b + (b.b - a.b) * ratio);
  }

  function baseTone() {
    return currentTheme === 'light' ? '#efe6d2' : '#28211a';
  }

  function cellColor(entry, habit) {
    const value = entry ? entry.value : undefined;
    if (habit.mode === 'check') {
      return value ? habit.color : mix(baseTone(), habit.color, 0.1);
    }
    const v = Number(value) || 0;
    if (v <= 0) return mix(baseTone(), habit.color, 0.1);
    if (v < 1) return mix(baseTone(), habit.color, 0.42);
    if (v < 2) return mix(baseTone(), habit.color, 0.72);
    return habit.color;
  }

  // Aggregate "how much of the day's scheduled habits got done" -> 0..1, or
  // null if nothing was scheduled that day.
  function dayScore(date) {
    let total = 0, done = 0;
    habits.forEach(h => {
      if (isScheduled(h, date)) {
        const entry = h.entries[toKey(date)];
        if (isSkipped(entry)) return;
        total++;
        if (entryHas(h, entry)) done++;
      }
    });
    if (total === 0) return null;
    return done / total;
  }

  function scoreColor(score) {
    if (score === null) return mix(baseTone(), PROFILE_COLOR, 0.06);
    return mix(baseTone(), PROFILE_COLOR, 0.15 + score * 0.75);
  }

  // ============ migration ============
  function migrateHabits() {
    habits.forEach(h => {
      if (!h.color) h.color = SWATCHES[0];
      if (!h.schedule || h.schedule.length !== 7) h.schedule = ALL_DAYS.slice();
      Object.keys(h.entries || {}).forEach(k => {
        const v = h.entries[k];
        if (v === null || typeof v !== 'object') {
          h.entries[k] = { value: v, note: '' };
        }
      });
    });
  }

  // ============ persistence (Supabase) ============
  async function loadHabits() {
    if (!session) { habits = []; return; }
    const { data, error } = await sb.from(TABLE).select('habits').eq('user_id', session.user.id).maybeSingle();
    if (error) { console.error('Load error', error); habits = []; return; }
    habits = (data && data.habits) ? data.habits : [];
    migrateHabits();
  }

  async function saveHabits() {
    if (!session) return;
    const { error } = await sb.from(TABLE).upsert({
      user_id: session.user.id, habits: habits, updated_at: new Date().toISOString(),
    });
    if (error) console.error('Save error', error);
  }

  async function deleteAllData() {
    if (!confirm('This permanently deletes all your habits and entries. This cannot be undone. Continue?')) return;
    if (session) {
      const { error } = await sb.from(TABLE).delete().eq('user_id', session.user.id);
      if (error) { alert('Could not delete data: ' + error.message); return; }
    }
    habits = [];
    await sb.auth.signOut();
  }

  // ============ theme ============
  function resolveTheme(pref) {
    if (pref === 'system') {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    return pref;
  }

  function applyTheme(pref) {
    currentTheme = resolveTheme(pref);
    document.documentElement.setAttribute('data-theme', currentTheme);
  }

  function getThemePref() {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; }
  }

  function setThemePref(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
    applyTheme(pref);
    render();
  }

  // ============ skip-button setting (per device, like the theme) ============
  function skipEnabled() {
    try { return localStorage.getItem(SKIP_KEY) !== 'off'; } catch (e) { return true; }
  }
  function setSkipEnabled(on) {
    try { localStorage.setItem(SKIP_KEY, on ? 'on' : 'off'); } catch (e) {}
    render();
  }

  // ============ dom helper ============
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (children) children.forEach(c => c && e.appendChild(c));
    return e;
  }

  // ============ heatmap rendering ============
  function renderHeatmap(habit, weeks) {
    const today = todayDate();
    const wrap = el('div', { class: 'heatmap-scroll' });
    const inner = el('div', { class: 'heatmap-inner' });

    const monthRow = el('div', { class: 'month-row' });
    let prevMonth = null;
    weeks.forEach(week => {
      const m = week[0].getMonth();
      const label = el('div', { class: 'month-label' });
      if (m !== prevMonth) { label.textContent = MONTHS[m]; prevMonth = m; }
      monthRow.appendChild(label);
    });
    inner.appendChild(monthRow);

    const body = el('div', { class: 'heatmap-body' });
    const dayCol = el('div', { class: 'day-col' });
    DAY_LABELS.forEach(l => dayCol.appendChild(el('div', { class: 'day-label', text: l })));
    body.appendChild(dayCol);

    const grid = el('div', { class: 'grid' });
    weeks.forEach(week => {
      week.forEach(day => {
        const key = toKey(day);
        const isFuture = day > today;
        const scheduled = isScheduled(habit, day);
        const entry = habit.entries[key];
        let cls = 'cell';
        if (toKey(day) === toKey(today)) cls += ' today';
        if (isFuture) cls += ' future';
        if (!scheduled) cls += ' off-day';
        if (entry && entry.note) cls += ' has-note';
        const skipped = isSkipped(entry);
        if (skipped) cls += ' skipped';
        const titleParts = [key];
        if (!scheduled) titleParts.push('not scheduled');
        if (skipped) titleParts.push('skipped');
        if (entry && !skipped) {
          if (habit.mode === 'hours' && entry.value) titleParts.push(entry.value + 'h');
          if (habit.mode === 'check' && entry.value) titleParts.push('done');
        }
        if (entry && entry.note) titleParts.push('"' + entry.note + '"');
        const cell = el('div', { class: cls, title: titleParts.join(' — ') });
        cell.style.background = (scheduled && !skipped) ? cellColor(entry, habit) : '';
        if (!isFuture && scheduled) cell.addEventListener('click', () => openEditEntry(habit.id, key));
        grid.appendChild(cell);
      });
    });
    body.appendChild(grid);
    inner.appendChild(body);
    wrap.appendChild(inner);
    setTimeout(() => { wrap.scrollLeft = wrap.scrollWidth; }, 0);
    return wrap;
  }

  function renderProfileHeatmap(weeks) {
    const today = todayDate();
    const wrap = el('div', { class: 'heatmap-scroll' });
    const inner = el('div', { class: 'heatmap-inner' });

    const monthRow = el('div', { class: 'month-row' });
    let prevMonth = null;
    weeks.forEach(week => {
      const m = week[0].getMonth();
      const label = el('div', { class: 'month-label' });
      if (m !== prevMonth) { label.textContent = MONTHS[m]; prevMonth = m; }
      monthRow.appendChild(label);
    });
    inner.appendChild(monthRow);

    const body = el('div', { class: 'heatmap-body' });
    const dayCol = el('div', { class: 'day-col' });
    DAY_LABELS.forEach(l => dayCol.appendChild(el('div', { class: 'day-label', text: l })));
    body.appendChild(dayCol);

    const grid = el('div', { class: 'grid' });
    weeks.forEach(week => {
      week.forEach(day => {
        const isFuture = day > today;
        const score = isFuture ? null : dayScore(day);
        let cls = 'cell';
        if (toKey(day) === toKey(today)) cls += ' today';
        if (isFuture) cls += ' future';
        const pct = score === null ? '—' : Math.round(score * 100) + '%';
        const cell = el('div', { class: cls, title: toKey(day) + ' — ' + pct });
        cell.style.background = scoreColor(isFuture ? null : score);
        grid.appendChild(cell);
      });
    });
    body.appendChild(grid);
    inner.appendChild(body);
    wrap.appendChild(inner);
    setTimeout(() => { wrap.scrollLeft = wrap.scrollWidth; }, 0);
    return wrap;
  }

  function renderJournal(habit) {
    const isOpen = !!openJournals[habit.id];
    const section = el('div');
    const toggle = el('button', {
      class: 'journal-toggle',
      text: (isOpen ? '▾ Hide journal' : '▸ View journal'),
      onclick: () => { openJournals[habit.id] = !isOpen; render(); }
    });
    section.appendChild(toggle);

    if (isOpen) {
      const keys = Object.keys(habit.entries).sort((a, b) => fromKey(b) - fromKey(a));
      const list = el('div', { class: 'journal-list' });
      if (keys.length === 0) {
        list.appendChild(el('div', { class: 'journal-empty', text: 'No entries yet.' }));
      } else {
        keys.forEach(k => {
          const entry = habit.entries[k];
          const valueText = isSkipped(entry) ? 'Skipped'
            : habit.mode === 'hours'
              ? (entry.value ? entry.value + 'h' : '—')
              : (entry.value ? 'Done' : '—');
          const row = el('div', { class: 'journal-item' });
          row.appendChild(el('div', { class: 'journal-date', text: fromKey(k).toDateString() }));
          row.appendChild(el('div', { class: 'journal-value', text: valueText }));
          row.appendChild(el('div', {
            class: 'journal-note' + (entry.note ? '' : ' empty'),
            text: entry.note ? entry.note : 'No note'
          }));
          list.appendChild(row);
        });
      }
      section.appendChild(list);
    }
    return section;
  }

  function renderCard(habit, weeks, index) {
    const stats = computeStreaks(habit, weeks);
    const card = el('div', { class: 'card animate-in' });
    card.style.animationDelay = (index * 0.04) + 's';

    const head = el('div', { class: 'card-head' });
    const headLeft = el('div', { class: 'card-head-left' });
    headLeft.appendChild(el('h2', { text: habit.name }));
    headLeft.appendChild(el('span', { class: 'mode-tag', text: habit.mode === 'hours' ? 'hours' : 'done' }));
    head.appendChild(headLeft);
    const actions = el('div', { class: 'card-actions' });
    actions.appendChild(el('button', { class: 'btn btn-ghost edit', text: '✎', onclick: () => openEditHabit(habit.id) }));
    actions.appendChild(el('button', { class: 'btn btn-ghost', text: '✕', onclick: () => deleteHabit(habit.id) }));
    head.appendChild(actions);
    card.appendChild(head);

    card.appendChild(renderHeatmap(habit, weeks));

    const statsRow = el('div', { class: 'stats-row' });
    const statsCol = el('div', { class: 'stats' });
    statsCol.appendChild(el('div', { class: 'stat' }, [document.createTextNode('Longest streak: '), el('b', { text: stats.longest + ' days' })]));
    statsCol.appendChild(el('div', { class: 'stat' }, [document.createTextNode('Streak: '), el('b', { text: stats.current + ' days' })]));
    statsCol.appendChild(el('div', { class: 'stat' }, [document.createTextNode('Number of entries: '), el('b', { text: String(stats.count) })]));
    if (habit.mode === 'hours') {
      statsCol.appendChild(el('div', { class: 'stat' }, [document.createTextNode('Average: '), el('b', { text: stats.avg.toFixed(2) + ' Hours' })]));
      statsCol.appendChild(el('div', { class: 'stat' }, [document.createTextNode('Total: '), el('b', { text: stats.total.toFixed(2) + ' Hours' })]));
    }
    statsRow.appendChild(statsCol);

    const todayKey = toKey(todayDate());
    const todayEntry = habit.entries[todayKey];
    const todayScheduled = isScheduled(habit, todayDate());
    const todaySkipped = isSkipped(todayEntry);
    const emptyValue = habit.mode === 'hours' ? 0 : false;
    const logWrap = el('div', { class: 'log-control' });
    if (!todayScheduled) {
      logWrap.appendChild(el('span', { class: 'rest-note', text: 'Not scheduled today' }));
    } else if (todaySkipped) {
      logWrap.appendChild(el('span', { class: 'rest-note', text: 'Skipped today' }));
      logWrap.appendChild(el('button', {
        class: 'btn', text: 'Undo skip',
        onclick: () => {
          if (todayEntry.note) habit.entries[todayKey] = { value: emptyValue, note: todayEntry.note };
          else delete habit.entries[todayKey];
          saveHabits(); render();
        }
      }));
    } else if (habit.mode === 'hours') {
      const input = el('input', { type: 'number', step: '0.25', min: '0', placeholder: 'hrs' });
      input.value = todayEntry ? todayEntry.value : '';
      const btn = el('button', { class: 'btn btn-accent', text: todayEntry ? 'Update' : 'Log today →' });
      btn.addEventListener('click', () => {
        const v = parseFloat(input.value);
        const existingNote = todayEntry ? todayEntry.note : '';
        if (!isNaN(v) && v > 0) habit.entries[todayKey] = { value: v, note: existingNote };
        else delete habit.entries[todayKey];
        saveHabits(); render();
      });
      logWrap.appendChild(input);
      logWrap.appendChild(btn);
    } else {
      const done = !!(todayEntry && todayEntry.value);
      const btn = el('button', { class: done ? 'btn' : 'btn btn-accent', text: done ? 'Done ✓ (undo)' : 'Log today →' });
      btn.addEventListener('click', () => {
        const existingNote = todayEntry ? todayEntry.note : '';
        if (done) delete habit.entries[todayKey];
        else habit.entries[todayKey] = { value: true, note: existingNote };
        saveHabits(); render();
      });
      logWrap.appendChild(btn);
    }
    if (todayScheduled && !todaySkipped && skipEnabled() && !entryHas(habit, todayEntry)) {
      logWrap.appendChild(el('button', {
        class: 'btn btn-ghost', text: 'Skip', title: 'Skip today (unplanned event)',
        onclick: () => {
          const existingNote = todayEntry ? todayEntry.note : '';
          habit.entries[todayKey] = { value: emptyValue, note: existingNote, skipped: true };
          saveHabits(); render();
        }
      }));
    }
    statsRow.appendChild(logWrap);
    card.appendChild(statsRow);
    card.appendChild(renderJournal(habit));
    return card;
  }

  function deleteHabit(id) {
    if (!confirm('Delete this habit and all its logged entries?')) return;
    habits = habits.filter(h => h.id !== id);
    saveHabits(); render();
  }

  function openAddHabit() {
    modalState = { type: 'addHabit', name: '', mode: 'hours', color: SWATCHES[0], schedule: ALL_DAYS.slice() };
    render();
  }

  function openEditHabit(habitId) {
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return;
    modalState = { type: 'editHabit', habitId, name: habit.name, color: habit.color, schedule: habit.schedule.slice() };
    render();
  }

  function openEditEntry(habitId, dateKey) {
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return;
    const existing = habit.entries[dateKey] || { value: '', note: '' };
    modalState = { type: 'editEntry', habitId, dateKey, value: existing.value || '', note: existing.note || '', skipped: !!existing.skipped };
    render();
  }

  function closeModal() { modalState = null; render(); }

  function renderColorField(getColor, setColor) {
    const field = el('div', { class: 'field' });
    field.appendChild(el('label', { text: 'Color' }));
    const row = el('div', { class: 'color-field' });
    const swatchesWrap = el('div', { class: 'swatches' });
    SWATCHES.forEach(c => {
      const sw = el('div', { class: 'swatch' + (getColor().toLowerCase() === c.toLowerCase() ? ' active' : '') });
      sw.style.background = c;
      sw.addEventListener('click', () => { setColor(c); render(); });
      swatchesWrap.appendChild(sw);
    });
    row.appendChild(swatchesWrap);
    const custom = el('input', { type: 'color', class: 'color-custom' });
    custom.value = getColor();
    custom.addEventListener('input', e => setColor(e.target.value));
    row.appendChild(custom);
    field.appendChild(row);
    return field;
  }

  function renderDayPickerField(getSchedule, setSchedule) {
    const field = el('div', { class: 'field' });
    const labelRow = el('div', { class: 'day-picker-row' });
    labelRow.appendChild(el('label', { text: 'Active days', style: 'margin:0;' }));
    labelRow.appendChild(el('button', {
      class: 'link-btn', text: 'Every day',
      onclick: () => { setSchedule(ALL_DAYS.slice()); render(); }
    }));
    field.appendChild(labelRow);
    const picker = el('div', { class: 'day-picker', style: 'margin-top:8px;' });
    DAY_SHORT.forEach((d, i) => {
      const active = getSchedule()[i];
      const btn = el('button', { class: active ? 'active' : '', text: d, type: 'button' });
      btn.addEventListener('click', () => {
        const sched = getSchedule().slice();
        sched[i] = !sched[i];
        if (sched.some(Boolean)) { setSchedule(sched); render(); }
      });
      picker.appendChild(btn);
    });
    field.appendChild(picker);
    return field;
  }

  function renderModal() {
    if (!modalState) return null;
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el('div', { class: 'modal' });

    if (modalState.type === 'addHabit' || modalState.type === 'editHabit') {
      const isEdit = modalState.type === 'editHabit';
      modal.appendChild(el('h3', { text: isEdit ? 'Edit habit' : 'New habit' }));

      const nameField = el('div', { class: 'field' });
      nameField.appendChild(el('label', { text: 'Habit name' }));
      const nameInput = el('input', { type: 'text', placeholder: 'e.g. Study' });
      nameInput.value = modalState.name;
      nameInput.addEventListener('input', e => modalState.name = e.target.value);
      nameField.appendChild(nameInput);
      modal.appendChild(nameField);

      if (!isEdit) {
        const modeField = el('div', { class: 'field' });
        modeField.appendChild(el('label', { text: 'Tracking type' }));
        const choice = el('div', { class: 'mode-choice' });
        const hoursBtn = el('button', { class: modalState.mode === 'hours' ? 'active' : '', text: 'Hours logged', type: 'button' });
        const checkBtn = el('button', { class: modalState.mode === 'check' ? 'active' : '', text: 'Done / not done', type: 'button' });
        hoursBtn.addEventListener('click', () => { modalState.mode = 'hours'; render(); });
        checkBtn.addEventListener('click', () => { modalState.mode = 'check'; render(); });
        choice.appendChild(hoursBtn); choice.appendChild(checkBtn);
        modeField.appendChild(choice);
        modal.appendChild(modeField);
      }

      modal.appendChild(renderDayPickerField(
        () => modalState.schedule,
        (s) => { modalState.schedule = s; }
      ));

      modal.appendChild(renderColorField(() => modalState.color, (c) => { modalState.color = c; }));

      const modalActions = el('div', { class: 'modal-actions' });
      modalActions.appendChild(el('button', { class: 'btn', text: 'Cancel', onclick: closeModal }));
      modalActions.appendChild(el('button', {
        class: 'btn btn-accent', text: isEdit ? 'Save' : 'Add habit', onclick: () => {
          const name = (modalState.name || '').trim();
          if (!name) { nameInput.focus(); return; }
          if (isEdit) {
            const habit = habits.find(h => h.id === modalState.habitId);
            habit.name = name; habit.color = modalState.color; habit.schedule = modalState.schedule;
          } else {
            habits.push({ id: uid(), name, mode: modalState.mode, color: modalState.color, schedule: modalState.schedule, entries: {} });
          }
          saveHabits(); closeModal();
        }
      }));
      modal.appendChild(modalActions);
      setTimeout(() => nameInput.focus(), 0);
    }

    if (modalState.type === 'editEntry') {
      const habit = habits.find(h => h.id === modalState.habitId);
      const dateLabel = fromKey(modalState.dateKey).toDateString();
      modal.appendChild(el('h3', { text: habit.name + ' — ' + dateLabel }));

      if (skipEnabled() || modalState.skipped) {
        const statusField = el('div', { class: 'field' });
        statusField.appendChild(el('label', { text: 'Day status' }));
        const statusChoice = el('div', { class: 'mode-choice' });
        const logBtn = el('button', { class: !modalState.skipped ? 'active' : '', text: 'Log it', type: 'button' });
        const skipBtn = el('button', { class: modalState.skipped ? 'active' : '', text: 'Skip day', type: 'button' });
        logBtn.addEventListener('click', () => { modalState.skipped = false; render(); });
        skipBtn.addEventListener('click', () => { modalState.skipped = true; render(); });
        statusChoice.appendChild(logBtn); statusChoice.appendChild(skipBtn);
        statusField.appendChild(statusChoice);
        modal.appendChild(statusField);
      }

      if (modalState.skipped) {
        modal.appendChild(el('p', {
          text: 'Skipped days (unplanned events) won\'t break your streak or count toward it.',
          style: 'color:var(--ink-dim);font-size:12px;line-height:1.6;margin:0 0 14px;'
        }));
      } else if (habit.mode === 'hours') {
        const field = el('div', { class: 'field' });
        field.appendChild(el('label', { text: 'Hours logged' }));
        const input = el('input', { type: 'number', step: '0.25', min: '0' });
        input.value = modalState.value;
        input.addEventListener('input', e => modalState.value = e.target.value);
        field.appendChild(input);
        modal.appendChild(field);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const field = el('div', { class: 'field' });
        field.appendChild(el('label', { text: 'Status' }));
        const choice = el('div', { class: 'mode-choice' });
        const doneBtn = el('button', { class: modalState.value ? 'active' : '', text: 'Done', type: 'button' });
        const notBtn = el('button', { class: !modalState.value ? 'active' : '', text: 'Not done', type: 'button' });
        doneBtn.addEventListener('click', () => { modalState.value = true; render(); });
        notBtn.addEventListener('click', () => { modalState.value = false; render(); });
        choice.appendChild(doneBtn); choice.appendChild(notBtn);
        field.appendChild(choice);
        modal.appendChild(field);
      }

      const noteField = el('div', { class: 'field' });
      noteField.appendChild(el('label', { text: 'Journal note' }));
      const noteInput = el('textarea', { placeholder: 'What happened today?' });
      noteInput.value = modalState.note;
      noteInput.addEventListener('input', e => modalState.note = e.target.value);
      noteField.appendChild(noteInput);
      modal.appendChild(noteField);

      const modalActions = el('div', { class: 'modal-actions' });
      if (habit.entries[modalState.dateKey]) {
        modalActions.appendChild(el('button', {
          class: 'btn', text: 'Clear entry', onclick: () => {
            delete habit.entries[modalState.dateKey]; saveHabits(); closeModal();
          }
        }));
      }
      modalActions.appendChild(el('button', { class: 'btn', text: 'Cancel', onclick: closeModal }));
      modalActions.appendChild(el('button', {
        class: 'btn btn-accent', text: 'Save', onclick: () => {
          const note = (modalState.note || '').trim();
          if (modalState.skipped) {
            habit.entries[modalState.dateKey] = { value: habit.mode === 'hours' ? 0 : false, note, skipped: true };
          } else if (habit.mode === 'hours') {
            const v = parseFloat(modalState.value);
            if (!isNaN(v) && v > 0) habit.entries[modalState.dateKey] = { value: v, note };
            else if (note) habit.entries[modalState.dateKey] = { value: 0, note };
            else delete habit.entries[modalState.dateKey];
          } else {
            if (modalState.value || note) habit.entries[modalState.dateKey] = { value: !!modalState.value, note };
            else delete habit.entries[modalState.dateKey];
          }
          saveHabits(); closeModal();
        }
      }));
      modal.appendChild(modalActions);
    }

    overlay.appendChild(modal);
    return overlay;
  }

  // ============ views ============
  function renderTabbar() {
    const bar = el('div', { class: 'tabbar' });
    const tabs = [['log', 'Log'], ['profile', 'Profile'], ['settings', 'Settings']];
    tabs.forEach(([key, label]) => {
      const tab = el('button', {
        class: 'tab' + (currentView === key ? ' active' : ''),
        text: label,
        onclick: () => { currentView = key; render(); }
      });
      bar.appendChild(tab);
    });
    return bar;
  }

  function renderLogView(wrap) {
    const weeks = buildWeeks(52);
    const addBar = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:18px;' });
    addBar.appendChild(el('button', { class: 'btn btn-accent', text: '+ New habit', onclick: openAddHabit }));
    wrap.appendChild(addBar);

    if (habits.length === 0) {
      const empty = el('div', { class: 'empty animate-in' });
      empty.appendChild(el('p', { text: 'No habits logged yet. Add one to start your streak.' }));
      empty.appendChild(el('button', { class: 'btn btn-accent', text: '+ New habit', onclick: openAddHabit }));
      wrap.appendChild(empty);
    } else {
      habits.forEach((h, i) => wrap.appendChild(renderCard(h, weeks, i)));
    }
  }

  function renderProfileView(wrap) {
    const weeks = buildWeeks(52);
    const today = todayDate();
    let scoredDays = 0, scoreSum = 0, bestScore = -1, bestDay = null, totalEntries = 0;
    weeks.forEach(week => week.forEach(d => {
      if (d > today) return;
      const s = dayScore(d);
      if (s !== null) {
        scoredDays++; scoreSum += s;
        if (s > bestScore) { bestScore = s; bestDay = d; }
      }
    }));
    habits.forEach(h => { totalEntries += Object.keys(h.entries).filter(k => entryHas(h, h.entries[k])).length; });
    const avgScore = scoredDays > 0 ? Math.round((scoreSum / scoredDays) * 100) : 0;

    const statsGrid = el('div', { class: 'profile-stats animate-in' });
    const statBox = (n, l) => {
      const b = el('div', { class: 'profile-stat' });
      b.appendChild(el('div', { class: 'n', text: n }));
      b.appendChild(el('div', { class: 'l', text: l }));
      return b;
    };
    statsGrid.appendChild(statBox(String(habits.length), 'Total habits'));
    statsGrid.appendChild(statBox(String(totalEntries), 'Entries this year'));
    statsGrid.appendChild(statBox(avgScore + '%', 'Average daily score'));
    statsGrid.appendChild(statBox(bestDay ? Math.round(bestScore * 100) + '%' : '—', 'Best day'));
    wrap.appendChild(statsGrid);

    const card = el('div', { class: 'card animate-in' });
    card.style.animationDelay = '.06s';
    card.appendChild(el('h2', { text: 'Year in review', style: 'font-family:var(--font-display);font-weight:600;font-size:20px;margin:0 0 16px;' }));
    card.appendChild(renderProfileHeatmap(weeks));
    wrap.appendChild(card);
  }

  // Settings are grouped into categories; each category is its own card.
  function settingsCategory(title) {
    const card = el('div', { class: 'card settings-cat animate-in' });
    card.appendChild(el('div', { class: 'settings-cat-title', text: title }));
    return card;
  }

  function settingRow(title, desc, control) {
    const row = el('div', { class: 'setting-row' });
    const text = el('div', { class: 'setting-text' });
    text.appendChild(el('h3', { text: title }));
    if (desc) text.appendChild(el('p', { text: desc }));
    row.appendChild(text);
    if (control) row.appendChild(control);
    return row;
  }

  function renderSettingsView(wrap) {
    // --- Appearance ---
    const appearance = settingsCategory('Appearance');
    const themeBlock = el('div', { class: 'settings-block' });
    themeBlock.appendChild(el('h3', { text: 'Theme' }));
    themeBlock.appendChild(el('p', { text: 'Choose how Field Log looks on this device.' }));
    const choice = el('div', { class: 'theme-choice' });
    const pref = getThemePref();
    [['light', '☀', 'Light'], ['dark', '☾', 'Dark'], ['system', '⚙', 'System']].forEach(([key, icon, label]) => {
      const btn = el('button', { class: pref === key ? 'active' : '', onclick: () => setThemePref(key) });
      btn.appendChild(el('div', { class: 'theme-icon', text: icon }));
      btn.appendChild(document.createTextNode(label));
      choice.appendChild(btn);
    });
    themeBlock.appendChild(choice);
    appearance.appendChild(themeBlock);
    wrap.appendChild(appearance);

    // --- Tracking ---
    const tracking = settingsCategory('Tracking');
    const on = skipEnabled();
    const sw = el('button', {
      class: 'switch' + (on ? ' on' : ''), type: 'button',
      role: 'switch', 'aria-checked': String(on), 'aria-label': 'Skip button',
      onclick: () => setSkipEnabled(!on)
    }, [el('span', { class: 'knob' })]);
    tracking.appendChild(settingRow(
      'Skip button',
      'Show a Skip option for days you miss because of unplanned events. Skipped days don\'t break your streak or count toward it. Days you already skipped stay skipped if you turn this off.',
      sw
    ));
    wrap.appendChild(tracking);

    // --- Account ---
    const account = settingsCategory('Account');
    const accountBlock = el('div', { class: 'settings-block' });
    accountBlock.appendChild(el('h3', { text: 'Signed in' }));
    accountBlock.appendChild(el('p', { text: session ? ('Signed in as ' + session.user.email) : '' }));
    accountBlock.appendChild(el('button', {
      class: 'btn', text: 'Sign out',
      onclick: async () => { await sb.auth.signOut(); }
    }));
    account.appendChild(accountBlock);
    wrap.appendChild(account);

    // --- Data ---
    const data = settingsCategory('Data');
    const dangerBlock = el('div', { class: 'settings-block' });
    dangerBlock.appendChild(el('h3', { text: 'Delete all my data', style: 'color:var(--bad);' }));
    dangerBlock.appendChild(el('p', {
      text: 'Permanently deletes all your habits and entries from the database, then signs you out. To also remove your email/login itself, remove yourself from Authentication → Users in your Supabase project dashboard.'
    }));
    dangerBlock.appendChild(el('button', { class: 'btn btn-danger', text: 'Delete all my data', onclick: deleteAllData }));
    data.appendChild(dangerBlock);
    wrap.appendChild(data);
  }

  function renderConfigMissing() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    const wrap = el('div', { class: 'wrap' });
    const box = el('div', { class: 'card', style: 'margin-top:60px;' });
    box.appendChild(el('h2', { text: 'Almost there' }));
    box.appendChild(el('p', {
      text: 'Field Log needs a Supabase project to store your data. Open js/config.js and paste in your Project URL and anon key, then reload this page.',
      style: 'color:var(--ink-dim);font-size:13px;line-height:1.6;'
    }));
    wrap.appendChild(box);
    app.appendChild(wrap);
  }

  function renderLogin() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    const wrap = el('div', { class: 'wrap' });

    const masthead = el('div', { class: 'masthead' });
    const left = el('div');
    left.appendChild(el('h1', { text: 'Field Log' }));
    left.appendChild(el('div', { class: 'sub', text: 'A daily record of discipline' }));
    masthead.appendChild(left);
    wrap.appendChild(masthead);

    const box = el('div', { class: 'card animate-in', style: 'max-width:360px;margin:40px auto 0;' });
    box.appendChild(el('h2', { text: 'Sign in', style: 'font-family:var(--font-display);font-size:20px;margin:0 0 6px;' }));
    box.appendChild(el('p', {
      text: 'Enter your email and we\'ll send you a sign-in link. No password needed.',
      style: 'color:var(--ink-dim);font-size:12px;line-height:1.6;margin:0 0 16px;'
    }));

    const field = el('div', { class: 'field' });
    const emailInput = el('input', { type: 'text', placeholder: 'you@example.com' });
    field.appendChild(emailInput);
    box.appendChild(field);

    if (authNotice) {
      box.appendChild(el('p', { text: authNotice, style: 'color:var(--amber-4);font-size:12px;margin:0 0 12px;' }));
    }

    const sendBtn = el('button', {
      class: 'btn btn-accent', text: 'Send sign-in link', style: 'width:100%;',
      onclick: async () => {
        const email = (emailInput.value || '').trim();
        if (!email) { emailInput.focus(); return; }
        sendBtn.textContent = 'Sending…';
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
        authNotice = error ? ('Error: ' + error.message) : 'Check your email for the sign-in link.';
        renderLogin();
      }
    });
    box.appendChild(sendBtn);
    wrap.appendChild(box);
    app.appendChild(wrap);
  }

  function render() {
    if (!configReady()) { renderConfigMissing(); return; }
    if (!session) { renderLogin(); return; }

    const app = document.getElementById('app');
    app.innerHTML = '';
    const wrap = el('div', { class: 'wrap' });

    const masthead = el('div', { class: 'masthead' });
    const left = el('div');
    left.appendChild(el('h1', { text: 'Field Log' }));
    left.appendChild(el('div', { class: 'sub', text: 'A daily record of discipline' }));
    left.appendChild(el('div', { class: 'habit-counter' }, [
      document.createTextNode('Habits tracked: '),
      el('b', { text: String(habits.length) })
    ]));
    masthead.appendChild(left);
    const right = el('div', { class: 'date' });
    right.appendChild(document.createTextNode(todayDate().toDateString()));
    masthead.appendChild(right);
    wrap.appendChild(masthead);

    wrap.appendChild(renderTabbar());

    const viewContainer = el('div', { class: 'animate-fade' });
    if (currentView === 'log') renderLogView(viewContainer);
    else if (currentView === 'profile') renderProfileView(viewContainer);
    else renderSettingsView(viewContainer);
    wrap.appendChild(viewContainer);

    app.appendChild(wrap);
    const modal = renderModal();
    if (modal) app.appendChild(modal);
  }

  // ============ boot ============
  async function boot() {
    applyTheme(getThemePref());
    if (!configReady()) { render(); return; }

    // Show auth errors carried in the URL (e.g. an expired link) and clear the
    // fragment, so a stale '#error=...' can never be reused as a redirect target.
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (hashParams.get('error_code') || hashParams.get('error')) {
      authNotice = hashParams.get('error_code') === 'otp_expired'
        ? 'That sign-in link expired or was already used. Request a new one and open it right away.'
        : 'Sign-in error: ' + (hashParams.get('error_description') || hashParams.get('error'));
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (!sb) sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (getThemePref() === 'system') { applyTheme('system'); render(); }
      });
    }

    const { data: { session: initial } } = await sb.auth.getSession();
    session = initial;
    if (session) { await loadHabits(); }
    render();

    sb.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      currentView = 'log';
      if (session) { await loadHabits(); } else { habits = []; }
      render();
    });
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    boot();
  }

  // Expose pure functions for the Node test harness (no-op in the browser).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      toKey, fromKey, todayDate, addDays, mondayOf, isoIndex,
      isScheduled, isSkipped, entryHas, buildWeeks, scheduledDatesInWeeks,
      computeStreaks, dayScore, migrateHabits,
      __setHabits: (h) => { habits = h; },
    };
  }
})();
