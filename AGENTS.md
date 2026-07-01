# AGENTS.md — Porras Mundial 2026

## Quick start

```bash
npm install                          # better-sqlite3, express, bcryptjs, cors
npm start                            # node server.js on :3000
pm2 restart mundo-porras             # production restart (see ecosystem.config.js)
```

`npm run seed` references a missing `seed.js` — ignore it.

## Architecture

Single Express app (`server.js`), vanilla JS SPA (`public/dashboard.html`), no frameworks.

| File | Role |
|---|---|
| `server.js` | Express router, auth, cache layer, phase deadlines / countdown API, default view config, SSE |
| `database.js` | SQLite (WAL mode), schema with auto-migrations, queries, 60s auto-repair cron, scoring logic |
| `live-api.js` | TheSportsDB client, polling, SSE events, name translation |
| `result-checker.js` | Multi-source result sync (openfootball, football-data.org, TheSportsDB) — also triggers `autoFillPhaseResults` |
| `public/dashboard.html` | SPA frontend (~3800 lines, vanilla JS, `<script>` at bottom) |
| `public/js/api.js` | Thin fetch wrapper, all API methods |
| `public/css/style.css` | ~2650 lines, dark theme via `:root` CSS variables, SVGs use `fill="currentColor"`, sizes via `!important` |

## Auth

All routes require auth except `/api/version`. Admin under `/api/admin/*`. Admin is whoever created the group (first user), can promote others.

### Test credentials

- **Username:** `testuser` — **Password:** `test`
- User_id: 8, no R32 bets. Useful for testing the UI without partial data.
- It does not belong to the principal group (where the admin is). It can be used to test with many things.

## Database migrations (`database.js` `initDB`)

Automatic on startup. Current migrations:
- `matches.status` column (TEXT, default `'scheduled'`)
- `phase_deadlines.duration_seconds` (migrated from `duration_minutes`)
- `bets.penalty_winner_id` (INTEGER, FK to teams, for knockout draw predictions)
- `matches.penalty_home_score` / `matches.penalty_away_score` (INTEGER, nullable) — **penalty shootout** score (only if there was one). `home_score`/`away_score` ALWAYS store the 120' result (never the shootout).

## Scoring system

### Match points (`calculateMatchPoints` in `database.js`)

#### Group stage (no penalties)

| Scenario | Pts |
|---|---|
| Exact score | 10 |
| Correct winner or draw | 5 |
| Wrong | 0 |

#### Knockout WITHOUT penalties (AET or 90' result)

| Scenario | Pts |
|---|---|
| Exact score | 15 |
| Correct winner | 7 |
| Wrong | 0 |

#### Knockout WITH penalties (120' result is a draw)

The 120' score is what gets compared to your prediction. The penalty shootout only decides which team advances, but is scored separately. **The more specific your prediction, the more points it's worth**.

| Scenario | Pts |
|---|---|
| Exact 120' score + correct PK pick | 15 |
| Correct 120' (draw) + wrong PK *(partial credit)* | 7 |
| Only correct who advances (wrong 120') | 5 |
| Predicted PK but no penalties happened → their team won by score | 5 |
| Different draw score at 120' + correct PK | 3 |
| Predicted draw without selecting who advances | 3 |
| Wrong | 0 |

**Resolution logic in penalty matches**:
- `exactRight` = correct 120' score + (no penalties OR correct PK pick). In penalties, only getting the 120' right is NOT an exact result.
- `predictWinner`/`actualWinner` are determined from the 120' score with PK pick adjustment. If the user predicts a draw and picks a PK winner, their prediction resolves as `'home'/'away'`.
- Partial credit (7 pts): match went to penalties, 120' is a draw, user got the 120' right but not the PK. Worth more than just getting the winner right (5 pts) because predicting there will be penalties is more specific.
- Only correct winner (5 pts): user got who advances right but not the 120' (predicted a non-draw that went to penalties).
- Predicted PK but no penalties occurred (5 pts): user picked a team for penalties that didn't happen, but that team ended up winning by score. Gets 5 pts for getting the team right.
- Different draw score + correct PK (3 pts): predicted a draw with a different score than reality but got the PK right. Less than partial credit because the 120' score is wrong.

### Phase points (`calculatePhasePoints`)

**Phase points are only awarded in round of 32** (round_of_32), derived from the user's group bets. In all other knockout rounds, `phase_bets` auto-save from match winners and are already rewarded with match points (15/7) — giving additional phase points would be double-rewarding.

| Stage | Pts/correct team |
|---|---|
| `round_of_32` (round of 32) | 2 |
| `round_of_16` (round of 16) | 0 |
| `quarter` (quarter-finals) | 0 |
| `semi` (semi-finals) | 0 |
| `final` | 0 |

One `phase_bets` per (user, team, stage) → adds `stagePoints[stage]` if the team is in `phase_results` for that stage, 0 otherwise. `phase_bets` for R16/Q/SF/F still auto-save (to keep a record of which teams reached each stage), but no longer award points.

**`phase_results`** = teams that actually reached that stage. For R32 it comes from the openfootball schedule (the 32 teams that played R32); for later stages, `advanceWinners()` fills them in from knockout results.

**`phase_bets`** = what each user *predicted* would reach each stage. Auto-saved from the user's group bets (not chosen manually — there is no team selection UI for users in the Phases tab, only the admin can modify `phase_results`).

#### Deriving `phase_bets` from group bets

`computeQualifiedTeams(userBetsMap)` in `dashboard.html:1610`:
1. Simulates group matches using the **user's bets** in `bets` (not real results).
2. Per group, sorts by FIFA criteria: pts → H2H pts → H2H GD → H2H GF → GD → GF.
3. Top 2 from each group (24) + 8 best 3rd-placed (24+8 = 32 teams) → saves to `phase_bets` with `stage='round_of_32'`.

#### Auto-save and the guard gotcha

Two places auto-save in `dashboard.html` (for R32 stage):
- `autoSavePhaseBets()` in `saveBet` (line ~1639) — called after each group bet.
- `showPhaseContent()` (line ~1368) — when rendering the Phases tab.

Both have a guard `if (myPhaseBets.some(b => b.stage === 'round_of_32')) return;`. **Effect**: R32 phase_bets are saved once, and from then on are NEVER overwritten even if the user changes group bets. Since there's no UI to edit `phase_bets` manually, the guard is essentially "save once, never update".

**Consequence**: if the user edits group bets after the auto-save, R32 points reflect the *old* projection, not the current one. To regenerate from the current projection:

```sql
DELETE FROM phase_bets WHERE user_id = ? AND stage = 'round_of_32';
-- then, for each user, recalculate via API or insert from the projection query
```

Or via admin: `POST /api/admin/recalculate` (does not regenerate phase_bets, only recalculates points). To force regeneration, you must delete and re-insert (not exposed in UI).

#### Auto-save in ALL knockout stages

`autoSaveNextPhaseBets(matchId)` in `database.js` runs automatically at the end of `setMatchResult()` and from `live-api.js` and `result-checker.js` (after updating a match result). For each user who bet on the match and **got the winner right** (exact winner or correct winner with `penalty_winner_id`), it saves a `phase_bets` for the next stage with that team.

Mapping (points are 0 since 2026-06-30, see "Phase points" section):
- R32 (round of 32) → R16 (round of 16)
- R16 (round of 16) → Q (quarter-finals)
- Q (quarter-finals) → SF (semi-finals)
- SF (semi-finals) → F (final)
- F (final) and 3rd place → (no next stage, skip)

The function is **idempotent** (skips if the winner is already placed in home/away of the `next_match`, thanks to the double-advance fix) and uses `INSERT OR IGNORE` with `UNIQUE(user_id, team_id, stage)` to prevent duplicates.

`computeGroupStandings` (in `dashboard.html`) ALWAYS uses the user's bets (`userBetsMap[m.id]`), NEVER the real result, to simulate groups — as documented in AGENTS.md. The simulation diverges from reality if the user's predictions are wrong.

### Special bets

| Type | Pts |
|---|---|
| champion | 50 |
| runner_up | 30 |
| third_place | 20 |
| pichichi | 40 |
| mvp | 40 |

## Key gotchas

- **TheSportsDB rate limiting**: max 2-4 searches per match, 200ms delay. Avoid multiplying requests.
- **Historical match filter**: every `searchevents.php` result must check `idLeague === '4429' && strSeason === '2026'` or old matches leak in.
- **Team name translation** (`TEAM_NAME_ES` in both `live-api.js` and `database.js` — must stay in sync): Spanish→English. TheSportsDB variant takes priority.
- **DB triggers**: `trg_matches_played_integrity` (rejects `played=1` with NULL scores), `trg_matches_future_date` + insert variant (rejects `played=1` with future date). `autoRepairMatches` (60s) reverts violations.
- **Caching**: in-memory `Map` with 30s TTL in `server.js`. `invalidateCache(pattern)` clears by substring.
- **Auto-fill phase results**: `autoFillPhaseResults()` runs on match create/update/delete, result set, sync, recalculate, and startup. Excludes "Por definir" (team_id: 305).
- **Stale `phase_bets` after group edits**: the guard `if (userHasPicks) return;` in `autoSavePhaseBets`/`showPhaseContent` prevents phase_bets from updating when group bets change. If the user edits, their R32 points remain based on the old projection. Regenerate with the SQL in the "Auto-save and the guard gotcha" section.
- **Default view config**: stored in `app_config` table. `default_view` (tab) + `default_view_stage` (phase). Read by all users, written by admin only.
- **Phase deadlines (countdown)**: per-stage timer that enables knockout betting during active countdown. The admin sets an **end datetime** (not a duration) via the admin panel (`PUT /api/admin/phase-deadlines/:stage` accepts `{ endDatetime }`). The `isPhaseEditingAllowed` check auto-deactivates the row when the deadline passes (self-healing). The frontend `startCountdownUpdater` clears the interval when `remaining <= 0` to avoid the stuck-countdown bug. SSE broadcast on toggle.
- **Auto-advance enabled**: `advanceWinners()` runs automatically when setting a result (`setMatchResult`, `syncMatchResults`, `syncLiveResultsWithDb`, admin endpoints). Places the winner of a match into the `next_match_id` of the next round. Has a global idempotent check (`alreadyPlacedInNext` Set) that prevents the original bug: if two previous matches had the same winner, it doesn't place them twice in different matches of the next round. If the admin already filled a slot manually, it is not overwritten.
- **Admin can edit results manually**: the "Edit" toggle (`PUT /api/admin/matches/:id`) now includes a "Result" section with 120' score, penalty winner, penalty score, and status. When saving result fields, `autoSaveNextPhaseBets` + `advanceWinners` + `autoFillPhaseResults` + `recalculateAllPoints` run automatically. Useful for correcting when the API gets a result wrong (e.g. wrong PK winner).
- **"pasa" → "gana"**: penalty display texts say "X team wins" (not "advances"). Cosmetic change in `buildMatchHtml`, `renderUserBetRow`, `showMatchGroupBets`, and the other showUserBets modal.
- **Orphaned team references**: if sync-fixtures deletes teams, existing `phase_bets` and `special_bets` referencing deleted team_ids become invisible (INNER JOIN hides them). Clean up with `DELETE FROM phase_bets WHERE team_id NOT IN (SELECT id FROM teams)`. Auto-save regenerates on next match prediction.
- **SVGs** replace emojis. Use `class="icon"` with `fill="currentColor"`.
- **`seed.js` does not exist** — `npm run seed` fails.
- **bcrypt import**: `bcryptjs` is imported at the top of `server.js` (module scope). Do NOT use local `require('bcryptjs')` inside individual route handlers — it works but is redundant and causes bugs when a new handler references `bcrypt` without its own require (e.g. the `/api/auth/password` endpoint).
- **PM2 Node version**: pm2 uses Node 22, system node is 18. Don't run node scripts directly outside pm2.

## Theme & UI (dark mode)

The site uses a **dark theme** (`color-scheme: dark` on `body`). Colors are controlled via CSS variables in `:root` (`public/css/style.css`).

### Main palette

| Variable | Value | Usage |
|---|---|---|
| `--pitch-green` | `#166b2e` | Pitch green (brand accent) |
| `--pitch-dark` | `#0c3d18` | Dark green (gradient with pitch-green) |
| `--pitch-light` | `#1e8a38` | Light green (accents) |
| `--gold` | `#e5b800` | Gold (accents, topbar and card borders) |
| `--gold-light` | `#ffe066` | Light gold (text on dark backgrounds) |
| `--blue` / `--blue-light` | `#1a3a6b` / `#2a5a9b` | Blue (reserved) |
| `--on-color` | `#ffffff` | White text on colored surfaces (buttons, badges) |
| `--bg` | `#0f1419` | Body and main-content background (very dark blue) |
| `--surface` | `#1a1f2e` | Card and modal surface |
| `--surface-2` | `#232a3d` | Nested surface (headers, inputs) |
| `--white` | `#1a1f2e` | Redefined to surface (so `var(--white)` in backgrounds is dark) |
| `--gray-50` to `--gray-900` | Inverted scale | `gray-50=#0f1419` (darker) → `gray-900=#f0f0f0` (lighter) |

**Brand marks preserved**: pitch green and gold. Everything else is dark navy.

### Layout

- **`.main-content`**: edge-to-edge (`width:100%`, `padding:0`, no max-width or centering). Fills the screen (`min-height: calc(100vh - 60px)`) with `var(--bg)` background.
- **`.card`**: `width:100%`, no border-radius or shadow. Top border 3px in `var(--gold)` (section mark). Bottom border `1px solid var(--gray-200)` to separate cards. Background: `linear-gradient(180deg, var(--surface) 0%, #1e2536 100%)`.
- **`.card-header`**: `linear-gradient(180deg, #232a3d 0%, #1e2536 100%)` with `padding: 16px 24px`.
- **`.card-body`**: `padding: 20px 24px`.
- **`.topbar`**: `linear-gradient(180deg, #1a1f2e 0%, #131822 100%)` with `border-bottom: 2px solid var(--gold)`. Consistent with mobile navbar.

### Dark-adapted elements

- **Primary buttons** (`.btn-primary`): pitch green with white text (`--on-color`).
- **Outline buttons** (`.btn-outline`): `var(--gray-100)` background, `var(--gray-300)` border, `var(--gray-800)` text.
- **Inputs / selects**: `var(--gray-100)` background, `var(--gray-900)` text. Native selects use `color-scheme: dark`.
- **Hit pills** (`.match-bet-prediction.hit-exact` / `.hit-winner` / `.hit-none`): solid dark backgrounds with white text and colored border.
- **`.match-points`**: `background: transparent`, `color: var(--gold-light)` (gold text without background, on the dark card).
- **Live matches** (`.match-item.live-now`): `background: rgba(239,68,68,0.12)` (translucent red tint). Suspended/delayed variants use translucent amber/purple tints.
- **Modals**: `var(--white)` background = `#1a1f2e` (dark). The "Group Bets" modal header uses a lighter green (`#2d8a3e` → `#1e6b2c`) to stand out.

### Conventions for new elements

- **Surface backgrounds**: use variables (`var(--bg)`, `var(--surface)`, `var(--surface-2)`, `var(--gray-100)`) instead of hardcoded colors.
- **Text on colored surfaces**: use `var(--on-color)` (white). Do NOT use `var(--white)` for text (it's dark).
- **Primary text**: `var(--gray-900)` (near-white). Secondary text: `var(--gray-600)` or `var(--gray-500)`.
- **Accents**: `var(--gold)` for borders/highlights, `var(--pitch-green)` for green, `var(--red)` for alerts.
- **Do NOT use hardcoded light colors** (`#fff`, `#fef2f2`, `#f0fdf4`, etc.) in backgrounds — the theme is dark. If you need a pill/badge, use solid dark colors (`#064e1f`, `#3d2e02`) or translucent rgba over the card.

## Frontend state variables (`dashboard.html`)

Key globals: `selectedGroup`, `selectedPhase`, `selectedPhaseStage`, `allMatches`, `allMyBetsMap`, `phaseDeadlines`, `phaseDeadlines`, `penaltyWinners`, `_defaultViewStage`.

## Useful commands

```bash
sqlite3 mundo-porras.db "SELECT id, home_score, away_score, played, match_date FROM matches WHERE played=0 ORDER BY match_date;"
sqlite3 mundo-porras.db "SELECT m.id, h.name, a.name, m.home_score, m.away_score, m.played FROM matches m JOIN teams h ON m.home_team_id=h.id JOIN teams a ON m.away_team_id=a.id WHERE m.id = 153;"
# Verify integrity
sqlite3 mundo-porras.db "SELECT id, played, home_score, away_score, match_date FROM matches WHERE played=1 AND (home_score IS NULL OR away_score IS NULL OR datetime(match_date, '+5 minutes') > datetime('now'));"
# Orphaned references
sqlite3 mundo-porras.db "SELECT COUNT(*) FROM phase_bets WHERE team_id NOT IN (SELECT id FROM teams);"
sqlite3 mundo-porras.db "SELECT COUNT(*) FROM special_bets WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams);"
# Phase results
sqlite3 mundo-porras.db "SELECT pr.team_id, t.name FROM phase_results pr JOIN teams t ON pr.team_id = t.id WHERE pr.stage = 'round_of_32';"
# Phase points per user
sqlite3 mundo-porras.db "SELECT u.username, SUM(pb.points_earned) FROM phase_bets pb JOIN users u ON pb.user_id = u.id GROUP BY u.username;"
# Per-user R32 hits (projection from group_bets vs phase_results)
sqlite3 mundo-porras.db "SELECT u.username, COUNT(*) as hits FROM phase_bets pb JOIN users u ON pb.user_id=u.id JOIN phase_results pr ON pb.team_id=pr.team_id AND pb.stage=pr.stage WHERE pb.stage='round_of_32' GROUP BY u.username;"
# Regenerate R32 phase_bets for a user (run after the DELETE step above, with the computeQualifiedTeams query)
# Count match predictions per user
sqlite3 mundo-porras.db "SELECT u.username, COUNT(*) FROM bets b JOIN users u ON b.user_id = u.id JOIN matches m ON b.match_id = m.id WHERE m.stage='group' AND b.home_score IS NOT NULL GROUP BY u.username;"
# Logs
pm2 logs mundo-porras
```
