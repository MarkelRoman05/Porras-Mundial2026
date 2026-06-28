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
| `public/css/style.css` | ~2500 lines, SVGs use `fill="currentColor"`, sizes via `!important` |

## Auth

All routes require auth except `/api/version`. Admin under `/api/admin/*`. Admin is whoever created the group (first user), can promote others.

## Database migrations (`database.js` `initDB`)

Automatic on startup. Current migrations:
- `matches.status` column (TEXT, default `'scheduled'`)
- `phase_deadlines.duration_seconds` (migrated from `duration_minutes`)
- `bets.penalty_winner_id` (INTEGER, FK to teams, for knockout draw predictions)

## Scoring system

### Match points (`calculateMatchPoints` in `database.js`)

| Scenario | Group | Knockout |
|---|---|---|
| Exact score | 10 | 15 |
| Correct winner | 5 | 7 |
| Correct draw (no PK pick) | 5 | 3 |
| Wrong | 0 | 0 |

**Knockout penalty winner**: if user selects a team when predicting a draw (`penalty_winner_id`), both `predictWinner` and `actualWinner` are resolved using that pick. If `actualWinner` would be `'draw'` but user has `penalty_winner_id`, it's treated as a win for that team. This means:
- Draw + PK pick → prediction becomes `'home'/'away'` → 7 pts if match also resolved that way
- Exact score + PK pick → 15 pts regardless
- No PK pick → treated as draw prediction (3 pts)

### Phase points (`calculatePhasePoints`)

Per team correctly predicted to reach each stage: 2/4/6/10/15 pts (dieciseisavos/final).

**autoFillPhaseResults** extracts distinct teams from matches in each knockout stage (excluding "Por definir") and populates `phase_results`. Called on every result set, sync, and startup.

**phase_bets** auto-saved from user's group projections (computed from their match predictions). Only saved when empty (not overwritten if user manually set picks via Fases tab).

### Bonus: "Cruce acertado"

+5 pts if both teams in a knockout match are in the user's `phase_bets` for that stage.

### Special bets

| Tipo | Pts |
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
- **Default view config**: stored in `app_config` table. `default_view` (tab) + `default_view_stage` (phase). Read by all users, written by admin only.
- **Phase deadlines (countdown)**: per-stage timer that enables knockout betting during active countdown. Configured in admin panel. SSE broadcast on toggle.
- **Orphaned team references**: if sync-fixtures deletes teams, existing `phase_bets` and `special_bets` referencing deleted team_ids become invisible (INNER JOIN hides them). Clean up with `DELETE FROM phase_bets WHERE team_id NOT IN (SELECT id FROM teams)`. Auto-save regenerates on next match prediction.
- **SVGs** replace emojis. Use `class="icon"` with `fill="currentColor"`.
- **`seed.js` does not exist** — `npm run seed` fails.
- **PM2 Node version**: pm2 uses Node 22, system node is 18. Don't run node scripts directly outside pm2.

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
# Count match predictions per user
sqlite3 mundo-porras.db "SELECT u.username, COUNT(*) FROM bets b JOIN users u ON b.user_id = u.id JOIN matches m ON b.match_id = m.id WHERE m.stage='group' AND b.home_score IS NOT NULL GROUP BY u.username;"
# Logs
pm2 logs mundo-porras
```
