# Field Log

A habit-streak tracker with a GitHub-style heatmap, per-habit colors, and daily journal notes. Pure HTML/CSS/JS — no build step, no dependencies.

## Setup

This version stores data in [Supabase](https://supabase.com) (free tier) instead of the browser, so it syncs across devices and survives clearing browser data. See the step-by-step setup guide your assistant gave you, or in short:

1. Create a free Supabase project.
2. Run `supabase-setup.sql` in its SQL Editor.
3. Copy your Project URL and anon key from Settings → API into `js/config.js`.
4. Open `index.html` (locally, or hosted anywhere) and sign in with your email — you'll get a magic link, no password.

## Run it

Once `js/config.js` is filled in, just open `index.html` in a browser, or host the folder anywhere static (GitHub Pages, Netlify, Cloudflare Pages, etc.).

## Project structure

```
field-log/
├── index.html          # page shell, loads Supabase SDK + app
├── supabase-setup.sql   # run once in Supabase's SQL Editor
├── css/
│   └── style.css       # all styling (CSS variables at the top control the theme)
└── js/
    ├── config.js        # your Supabase URL + anon key go here
    └── app.js           # all app logic — state, rendering, auth, storage
```

`app.js` is a single self-contained IIFE with no framework. Main pieces:

- **State** — `habits` array in memory, persisted to Supabase (table `habits_data`, one row per signed-in user) via `loadHabits()` / `saveHabits()`.
- **Data model** — each habit: `{ id, name, mode, color, entries }`, where `mode` is `'hours'` or `'check'`, and `entries` maps `'YYYY-MM-DD'` → `{ value, note }`. The whole array is stored as one JSON blob per user — simple, and plenty for this scale of data.
- **Date helpers** — `toKey`, `fromKey`, `buildWeeks`, etc.
- **Color helpers** — `hexToRgb`/`rgbToHex`/`mix` generate the 4-step heatmap shades from each habit's chosen color.
- **Rendering** — plain DOM building via the small `el()` helper (no innerHTML templating), so there's no build tooling to fight with.

## Features

- Add/edit/delete habits, each with its own name and color (pick a preset or any custom color).
- Two tracking modes per habit: hours logged, or simple done/not-done.
- Click any day on the heatmap to log or edit that day — including a journal note.
- "Log today" shortcut for quick same-day entries.
- Per-habit stats: longest streak, current streak, entry count, and (for hours mode) average/total.
- Collapsible journal view per habit, listing every entry with its note, most recent first.

## Ideas to extend

- **Export/import**: add a button that downloads `JSON.stringify(habits)` as a file, and a matching import that parses it back in.
- **Reminders**: use the Notifications API to nudge at a set time if today isn't logged yet.
- **Weekly/monthly view**: add a toggle to switch the heatmap for a calendar-month grid.
- **Multiple heatmap metrics**: e.g. color by note length or a custom tag instead of just hours/done.
