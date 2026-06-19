# AGENTS.md — Porras Mundial 2026

## Quick start

```bash
npm install                          # better-sqlite3, express, bcryptjs, cors
npm start                            # node server.js on :3000
pm2 restart mundo-porras             # production restart (see ecosystem.config.js)
```

`npm run seed` references a missing `seed.js` — ignore it.

## Architecture

Single Express app (`server.js`), no monorepo.

| File | Role |
|---|---|
| `server.js` | Express router, auth, cache layer, admin endpoints, SSE |
| `database.js` | SQLite (WAL mode), schema, queries, `autoRepairMatches` (60s cron) |
| `live-api.js` | TheSportsDB client, polling 1min/5min, SSE events, name translation |
| `result-checker.js` | Multi-source result sync (openfootball, football-data.org, TheSportsDB) |
| `public/dashboard.html` | SPA frontend (vanilla JS, no framework) |
| `public/css/style.css` | ~1900 lines, SVGs use `fill="currentColor"`, sizes via `!important` |

All auth required except `/api/version`. Admin routes under `/api/admin/*`.

## Key gotchas

- **TheSportsDB free key (3)** has aggressive rate limiting — max 2-4 searches per match with 200ms delay between. Avoid multiplying requests.
- **Historical match filter**: every `searchevents.php` result must be filtered by `idLeague === '4429' && strSeason === '2026'`. Without it, 2009 matches leak in.
- **Team name translation** (`TEAM_NAME_ES` in `live-api.js` and `database.js` — keep them synced): Spanish→English. TheSportsDB variant takes priority (e.g. `Bosnia-Herzegovina` over `Bosnia & Herzegovina`).
- **DB triggers**: `trg_matches_played_integrity` (rejects played=1 with NULL scores), `trg_matches_future_date` + `trg_matches_future_date_insert` (rejects played=1 with future date). `autoRepairMatches` runs every 60s and reverts violations.
- **Deadline**: enforced for user bets only. Admin can set/correct any match result at any time.
- **Knockout phase**: backend fully prepared (all stages in schema), frontend UI hidden until groups complete.
- **Caching**: in-memory `Map` with 30s TTL in `server.js`. `invalidateCache(pattern)` clears by substring.
- **Logs**: `pm2 logs mundo-porras`. `Sync check` lines show BD vs live diff.
- **SVGs** replace emojis throughout. Use `class="icon"` with `fill="currentColor"` and CSS size classes.
- **`seed.js` does not exist** — `npm run seed` will fail.

## Useful commands

```bash
sqlite3 mundo-porras.db "SELECT id, home_score, away_score, played, match_date FROM matches WHERE played=0 ORDER BY match_date;"
sqlite3 mundo-porras.db "SELECT m.id, h.name, a.name, m.home_score, m.away_score, m.played FROM matches m JOIN teams h ON m.home_team_id=h.id JOIN teams a ON m.away_team_id=a.id WHERE m.id = 153;"
# Verify integrity
sqlite3 mundo-porras.db "SELECT id, played, home_score, away_score, match_date FROM matches WHERE played=1 AND (home_score IS NULL OR away_score IS NULL OR datetime(match_date, '+5 minutes') > datetime('now'));"
# Cache headers for live endpoint
curl -s "http://localhost:3000/api/live/matches" -b "connect.sid=<session>"
```
