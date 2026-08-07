(function () {
  'use strict';

  const BASE_TONE = '#28211a'; // matches --surface-2, the "empty cell" tone
  const TABLE = 'habits_data';

  const SWATCHES = [
    '#e0a93b', // amber
    '#b5482a', // rust
    '#6b8f5c', // moss
    '#4a7a8c', // teal
    '#7a6bb0', // violet
    '#c25a8a', // rose
    '#5b7fc7', // blue
    '#c7943f', // ochre
  ];

  let habits = [];
  let modalState = null; // {type:'addHabit'|'editHabit'|'editEntry', ...}
  let openJournals = {}; // habitId -> bool

  let sb = null;
  let session = null;
  let authNotice = '';
  let saving = false;

  function configReady() {
    return window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
      !window.SUPABASE_URL.startsWith('PASTE_') && !window.SUPABASE_ANON_KEY.startsWith('PASTE_');
  }

  function migrateHabits() {
    habits.forEach(h => {
      if (!h.color) h.color = SWATCHES[0];
      Object.keys(h.entries || {}).forEach(k => {
        const v = h.entries[k];
        if (v === null || typeof v !== 'object') {
          h.entries[k] = { value: v, note: '' };
        }
      });
    });
  }

  // ---------- persistence (Supabase) ----------
  async function loadHabits() {
    if (!session) { habits = []; return; }
    const { data, error } = await sb
      .from(TABLE)
      .select('habits')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (error) { console.error('Load error', error); habits = []; return; }
    habits = (data && data.habits) ? data.habits : [];
    migrateHabits();
  }

  async function saveHabits() {
    if (!session) return;
    saving = true;
    const { error } = await sb.from(TABLE).upsert({
      user_id: session.user.id,
      habits: habits,
      updated_at: new Date().toISOString(),
    });
    saving = false;
    if (error) console.error('Save error', error);
  }

  // ---------- date helpers ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function startOfDay(d) { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
  function todayDate() { return startOfDay(new Date()); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function mondayOf(d) { const day = d.getDay(); const diff = (day === 0 ? -6 : 1 - day); return addDays(startOfDay(d), diff); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

  function uid() { return 'h_' + Math.random().toString(36).slice(2, 9); }

  // ---------- color helpers ----------
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

  function cellColor(entry, habit) {
    const value = entry ? entry.value : undefined;
    if (habit.mode === 'check') {
      return value ? habit.color : mix(BASE_TONE, habit.color, 0.1);
    }
    const v = Number(value) || 0;
    if (v <= 0) return mix(BASE_TONE, habit.color, 0.1);
    if (v < 1) return mix(BASE_TONE, habit.color, 0.42);
    if (v < 2) return mix(BASE_TONE, habit.color, 0.72);
    return habit.color;
  }

  // ---------- stats ----------
  function computeStreaks(entries, mode) {
    const keys = Object.keys(entries).filter(k => mode === 'hours' ? entries[k].value > 0 : entries[k].value);
    if (keys.length === 0) return { longest: 0, current: 0, count: 0, total: 0, avg: 0 };
    const dates = keys.map(fromKey).sort((a, b) => a - b);
    let longest = 1, run = 1;
    for (let i = 1; i < dates.length; i++) {
      const diff = Math.round((dates[i] - dates[i - 1]) / 86400000);
      if (diff === 1) { run++; } else { run = 1; }
      if (run > longest) longest = run;
    }
    const today = todayDate();
    const yesterday = addDays(today, -1);
    const last = dates[dates.length - 1];
    let current = 0;
    if (toKey(last) === toKey(today) || toKey(last) === toKey(yesterday)) {
      current = 1;
      let cursor = last;
      for (let i = dates.length - 2; i >= 0; i--) {
        const expected = addDays(cursor, -1);
        if (toKey(dates[i]) === toKey(expected)) { current++; cursor = dates[i]; } else { break; }
      }
    }
    const count = keys.length;
    let total = 0;
    if (mode === 'hours') keys.forEach(k => total += Number(entries[k].value) || 0);
    const avg = mode === 'hours' && count > 0 ? total / count : 0;
    return { longest, current, count, total, avg };
  }

  // ---------- weeks ----------
  function buildWeeks() {
    const today = todayDate();
    const thisMonday = mondayOf(today);
    const firstMonday = addDays(thisMonday, -52 * 7);
    const weeks = [];
    let cursor = firstMonday;
    for (let i = 0; i < 53; i++) {
      const week = [];
      for (let j = 0; j < 7; j++) week.push(addDays(cursor, j));
      weeks.push(week);
      cursor = addDays(cursor, 7);
    }
    return weeks;
  }

  // ---------- dom helper ----------
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

  // ---------- rendering ----------
  function renderHeatmap(habit) {
    const weeks = buildWeeks();
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
        const entry = habit.entries[key];
        let cls = 'cell';
        if (toKey(day) === toKey(today)) cls += ' today';
        if (isFuture) cls += ' future';
        if (entry && entry.note) cls += ' has-note';
        const titleParts = [key];
        if (entry) {
          if (habit.mode === 'hours' && entry.value) titleParts.push(entry.value + 'h');
          if (habit.mode === 'check' && entry.value) titleParts.push('done');
          if (entry.note) titleParts.push('"' + entry.note + '"');
        }
        const cell = el('div', { class: cls, title: titleParts.join(' — ') });
        cell.style.background = cellColor(entry, habit);
        if (!isFuture) cell.addEventListener('click', () => openEditEntry(habit.id, key));
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
          const valueText = habit.mode === 'hours'
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

  function renderCard(habit) {
    const stats = computeStreaks(habit.entries, habit.mode);
    const card = el('div', { class: 'card' });

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

    card.appendChild(renderHeatmap(habit));

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
    const logWrap = el('div', { class: 'log-control' });
    if (habit.mode === 'hours') {
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
    modalState = { type: 'addHabit', name: '', mode: 'hours', color: SWATCHES[0] };
    render();
  }

  function openEditHabit(habitId) {
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return;
    modalState = { type: 'editHabit', habitId, name: habit.name, color: habit.color };
    render();
  }

  function openEditEntry(habitId, dateKey) {
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return;
    const existing = habit.entries[dateKey] || { value: '', note: '' };
    modalState = { type: 'editEntry', habitId, dateKey, value: existing.value || '', note: existing.note || '' };
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

  function renderModal() {
    if (!modalState) return null;
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el('div', { class: 'modal' });

    if (modalState.type === 'addHabit') {
      modal.appendChild(el('h3', { text: 'New habit' }));

      const nameField = el('div', { class: 'field' });
      nameField.appendChild(el('label', { text: 'Habit name' }));
      const nameInput = el('input', { type: 'text', placeholder: 'e.g. Study' });
      nameInput.value = modalState.name;
      nameInput.addEventListener('input', e => modalState.name = e.target.value);
      nameField.appendChild(nameInput);
      modal.appendChild(nameField);

      const modeField = el('div', { class: 'field' });
      modeField.appendChild(el('label', { text: 'Tracking type' }));
      const choice = el('div', { class: 'mode-choice' });
      const hoursBtn = el('button', { class: modalState.mode === 'hours' ? 'active' : '', text: 'Hours logged' });
      const checkBtn = el('button', { class: modalState.mode === 'check' ? 'active' : '', text: 'Done / not done' });
      hoursBtn.addEventListener('click', () => { modalState.mode = 'hours'; render(); });
      checkBtn.addEventListener('click', () => { modalState.mode = 'check'; render(); });
      choice.appendChild(hoursBtn); choice.appendChild(checkBtn);
      modeField.appendChild(choice);
      modal.appendChild(modeField);

      modal.appendChild(renderColorField(() => modalState.color, (c) => { modalState.color = c; }));

      const modalActions = el('div', { class: 'modal-actions' });
      modalActions.appendChild(el('button', { class: 'btn', text: 'Cancel', onclick: closeModal }));
      modalActions.appendChild(el('button', {
        class: 'btn btn-accent', text: 'Add habit', onclick: () => {
          const name = (modalState.name || '').trim();
          if (!name) { nameInput.focus(); return; }
          habits.push({ id: uid(), name, mode: modalState.mode, color: modalState.color, entries: {} });
          saveHabits();
          closeModal();
        }
      }));
      modal.appendChild(modalActions);
      setTimeout(() => nameInput.focus(), 0);
    }

    if (modalState.type === 'editHabit') {
      const habit = habits.find(h => h.id === modalState.habitId);
      modal.appendChild(el('h3', { text: 'Edit habit' }));

      const nameField = el('div', { class: 'field' });
      nameField.appendChild(el('label', { text: 'Habit name' }));
      const nameInput = el('input', { type: 'text' });
      nameInput.value = modalState.name;
      nameInput.addEventListener('input', e => modalState.name = e.target.value);
      nameField.appendChild(nameInput);
      modal.appendChild(nameField);

      modal.appendChild(renderColorField(() => modalState.color, (c) => { modalState.color = c; }));

      const modalActions = el('div', { class: 'modal-actions' });
      modalActions.appendChild(el('button', { class: 'btn', text: 'Cancel', onclick: closeModal }));
      modalActions.appendChild(el('button', {
        class: 'btn btn-accent', text: 'Save', onclick: () => {
          const name = (modalState.name || '').trim();
          if (!name) { nameInput.focus(); return; }
          habit.name = name;
          habit.color = modalState.color;
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

      if (habit.mode === 'hours') {
        const field = el('div', { class: 'field' });
        field.appendChild(el('label', { text: 'Hours logged' }));
        const input = el('input', { type: 'number', step: '0.25', min: '0' });
        input.value = modalState.value;
        input.addEventListener('input', e => modalState.value = e.target.value);
        field.appendChild(input);
        modal.appendChild(field);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const done = !!modalState.value;
        const field = el('div', { class: 'field' });
        field.appendChild(el('label', { text: 'Status' }));
        const choice = el('div', { class: 'mode-choice' });
        const doneBtn = el('button', { class: modalState.value ? 'active' : '', text: 'Done' });
        const notBtn = el('button', { class: !modalState.value ? 'active' : '', text: 'Not done' });
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
          if (habit.mode === 'hours') {
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

    const box = el('div', { class: 'card', style: 'max-width:360px;margin:40px auto 0;' });
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
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.href }
        });
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
    masthead.appendChild(left);
    const right = el('div', { class: 'date' });
    right.appendChild(document.createTextNode(todayDate().toDateString()));
    if (session) {
      const signOutBtn = el('button', {
        class: 'btn btn-ghost', text: 'Sign out', style: 'display:block;margin-top:6px;font-size:10px;',
        onclick: async () => { await sb.auth.signOut(); }
      });
      right.appendChild(signOutBtn);
    }
    masthead.appendChild(right);
    wrap.appendChild(masthead);

    const addBar = el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:18px;' });
    addBar.appendChild(el('button', { class: 'btn btn-accent', text: '+ New habit', onclick: openAddHabit }));
    wrap.appendChild(addBar);

    if (habits.length === 0) {
      const empty = el('div', { class: 'empty' });
      empty.appendChild(el('p', { text: 'No habits logged yet. Add one to start your streak.' }));
      empty.appendChild(el('button', { class: 'btn btn-accent', text: '+ New habit', onclick: openAddHabit }));
      wrap.appendChild(empty);
    } else {
      habits.forEach(h => wrap.appendChild(renderCard(h)));
    }

    app.appendChild(wrap);
    const modal = renderModal();
    if (modal) app.appendChild(modal);
  }

  async function boot() {
    if (!configReady()) { render(); return; }
    if (!sb) sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

    const { data: { session: initial } } = await sb.auth.getSession();
    session = initial;
    if (session) { await loadHabits(); }
    render();

    sb.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;
      if (session) { await loadHabits(); } else { habits = []; }
      render();
    });
  }

  boot();
})();
