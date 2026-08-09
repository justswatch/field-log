# Field Log

A habit-streak tracker with a GitHub-style heatmap, per-habit colors and schedules, daily journal notes, light/dark themes, and a yearly profile view. Pure HTML/CSS/JS — no build step, no dependencies. Data syncs via Supabase.

## Setup

1. Create a free Supabase project.
2. Run `supabase-setup.sql` in its SQL Editor (safe to re-run any time).
3. Copy your Project URL and anon key from Settings → API into `js/config.js`.
4. In Supabase, go to Authentication → URL Configuration and set both the **Site URL** and a **Redirect URL** to wherever you're hosting the app (e.g. `https://yourname.github.io/field-log/**` for the redirect, wildcard included).
5. Open `index.html` (locally, or hosted anywhere static) and sign in with your email — you'll get a magic link, no password.

## Project structure

```
field-log/
├── index.html          # page shell, pre-applies saved theme, loads Supabase SDK + app
├── supabase-setup.sql   # run once (or re-run any time) in Supabase's SQL Editor
├── css/
│   └── style.css       # dark + light theme variables, animations, all component styles
└── js/
    ├── config.js        # your Supabase URL + anon key go here
    └── app.js           # all app logic — state, rendering, auth, storage, streak math
```

## Features

- **Habits**: add/edit/delete, each with its own name, color (preset or custom picker), and tracking mode (hours logged, or done/not-done).
- **Active days**: pick which days of the week count for a habit. Days outside that schedule are skipped entirely by the streak math — a "gym, Mon/Wed/Fri only" habit won't be penalized for the days in between.
- **Journal**: click any day on a habit's heatmap to log it and leave a note. A collapsible journal list per habit shows every entry, most recent first.
- **Profile tab**: a year-long heatmap of your overall daily "score" (% of that day's scheduled habits you completed), plus totals for habits, entries, and your best day.
- **Settings tab**: switch between Light / Dark / System appearance, sign out, or permanently delete all your data.
- **Habit counter**: a small badge in the header always shows how many habits you're tracking.

## Data model

Each habit: `{ id, name, mode, color, schedule, entries }`

- `mode`: `'hours'` or `'check'`
- `schedule`: array of 7 booleans, Monday first (`[Mon, Tue, Wed, Thu, Fri, Sat, Sun]`)
- `entries`: maps `'YYYY-MM-DD'` → `{ value, note }`

The whole `habits` array is stored as one JSON blob per signed-in user in Supabase (table `habits_data`), keyed by `user_id`. Row-level security policies mean each user can only ever read/write their own row.

The one thing that's *not* synced is your theme preference — that's saved to `localStorage` on each device, since "what this screen looks like" is a per-device setting, not data worth syncing.

## Account deletion

The Settings tab's "Delete all my data" button deletes your Supabase row (all habits and entries) and signs you out. It does **not** delete your login/email from Supabase Auth itself — doing that safely requires a privileged server-side call (a service-role key), which this client-only app intentionally never holds, for your security. If you also want your email removed from the project entirely, delete yourself from Authentication → Users in the Supabase dashboard.

## Testing

The streak/schedule/aggregation logic (`computeStreaks`, `isScheduled`, `dayScore`, `migrateHabits`, etc.) is written as pure functions and exported for Node so it can be tested outside the browser. Scenarios verified before shipping:

- A habit scheduled for specific days only (e.g. Mon/Wed/Fri) correctly ignores all other days — streaks aren't broken by non-scheduled gaps.
- A genuinely missed *scheduled* day does break the streak.
- Today gets a "grace period": if today is scheduled but not logged yet, the streak leading into today still counts (since the day isn't over).
- Hours-mode totals/averages compute correctly.
- The profile's daily score correctly returns `null` for days with nothing scheduled, and the right percentage otherwise.
- Migrating old data (no `schedule`/`color`, raw entry values instead of `{value, note}`) upgrades cleanly.

All scenarios pass. (Rendering/UI itself was checked by hand rather than automated, since this project deliberately has no headless-browser tooling.)

## Ideas to extend

- **Export/import**: add a button that downloads `JSON.stringify(habits)` as a file, and a matching import that parses it back in.
- **True account deletion**: add a Supabase Edge Function (using the service role key server-side, never in the client) that the Settings page calls to fully delete the auth user.
- **Reminders**: use the Notifications API to nudge at a set time if today isn't logged yet.
