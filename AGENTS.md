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

## Database migrations (`database.js` `initDB`)

Automatic on startup. Current migrations:
- `matches.status` column (TEXT, default `'scheduled'`)
- `phase_deadlines.duration_seconds` (migrated from `duration_minutes`)
- `bets.penalty_winner_id` (INTEGER, FK to teams, for knockout draw predictions)
- `matches.penalty_home_score` / `matches.penalty_away_score` (INTEGER, nullable) — score de la **tanda de penaltis** (solo si hubo). `home_score`/`away_score` almacenan SIEMPRE el resultado a 120' (nunca el de la shootout).

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
- **NEW (partial credit)**: if the match was decided by penalties (`match.penalty_winner_id` is set) AND the user got the 120-min score right AND the 120-min score is a draw (1-1 etc.) AND the user's PK pick is wrong or absent → **3 pts in knockout / 5 in group** (correct 120-min draw, even though the PK winner was missed).

### Phase points (`calculatePhasePoints`)

| Stage | Pts/eq correcto |
|---|---|
| `round_of_32` (dieciseisavos) | 2 |
| `round_of_16` (octavos) | 4 |
| `quarter` (cuartos) | 6 |
| `semi` (semifinal) | 10 |
| `final` | 15 |

Una `phase_bets` por (user, team, stage) → suma `stagePoints[stage]` si el equipo está en `phase_results` para esa fase, 0 si no.

**`phase_results`** = equipos que realmente alcanzaron esa fase. Para R32 viene del schedule de openfootball (los 32 que jugaron R32); para fases posteriores los va rellenando `advanceWinners()` desde resultados de eliminatorias.

**`phase_bets`** = lo que cada usuario *pronosticó* que alcanzaría cada fase. Se autoguarda desde las apuestas de grupos del usuario (no se elige a mano — no hay UI de selección de equipos para el usuario en el tab Fases, solo el admin puede tocar `phase_results`).

#### Derivación de `phase_bets` desde apuestas de grupos

`computeQualifiedTeams(userBetsMap)` en `dashboard.html:1610`:
1. Simula los partidos de grupo usando las **apuestas del usuario** en `bets` (no los resultados reales).
2. Por grupo, ordena con criterios FIFA: pts → H2H pts → H2H GD → H2H GF → GD → GF.
3. Top 2 de cada grupo (24) + 8 mejores 3ros (24+8 = 32 equipos) → guarda en `phase_bets` con `stage='round_of_32'`.

#### Auto-guardado y gotcha del guard

Dos sitios autoguardan en `dashboard.html` (para la fase R32):
- `autoSavePhaseBets()` en `saveBet` (línea ~1639) — se llama tras cada apuesta de grupo.
- `showPhaseContent()` (línea ~1368) — al renderizar el tab Fases.

Ambos tienen un guard `if (myPhaseBets.some(b => b.stage === 'round_of_32')) return;`. **Efecto**: phase_bets R32 se guarda la primera vez, y a partir de ahí NO se sobreescribe aunque el usuario cambie apuestas de grupos. Como no hay UI para editar `phase_bets` a mano, el guard es esencialmente "save once, never update".

**Consecuencia**: si el usuario edita apuestas de grupos después de autoguardar, los puntos de R32 reflejan la predicción *vieja*, no la actual. Para regenerar desde la proyección actual:

```sql
DELETE FROM phase_bets WHERE user_id = ? AND stage = 'round_of_32';
-- luego, para cada usuario, recalcular vía API o insertar desde la query de proyección
```

O vía admin: `POST /api/admin/recalculate` (no regenera phase_bets, solo recalcula puntos). Para forzar regeneración, hay que borrar y re-insertar (no expuesto en UI).

#### Auto-guardado en TODAS las fases eliminatorias

`autoSaveNextPhaseBets(matchId)` en `database.js` se ejecuta automáticamente al final de `setMatchResult()` y desde `live-api.js` y `result-checker.js` (tras actualizar el resultado de un partido). Para cada usuario que apostó en el partido y **acertó quién pasa** (ganador exacto o ganador correcto con `penalty_winner_id`), guarda un `phase_bets` para la siguiente fase con ese equipo.

Mapping:
- R32 (dieciseisavos) → R16 (octavos) → 4 pts por acierto
- R16 (octavos) → Q (cuartos) → 6 pts por acierto
- Q (cuartos) → SF (semifinal) → 10 pts por acierto
- SF (semifinal) → F (final) → 15 pts por acierto
- F (final) y 3er puesto → (no hay siguiente fase, skip)

La función es **idempotente** (salta al ganador si ya está colocado en home/away del `next_match`, gracias al fix de doble-avance) y usa `INSERT OR IGNORE` con `UNIQUE(user_id, team_id, stage)` para evitar duplicados.

`computeGroupStandings` (en `dashboard.html`) usa **SIEMPRE** las apuestas del usuario (`userBetsMap[m.id]`), NUNCA el resultado real, para simular los grupos — tal como dice AGENTS.md. La simulación diverge del real si el usuario falló.

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
- **Stale `phase_bets` after group edits**: el guard `if (userHasPicks) return;` en `autoSavePhaseBets`/`showPhaseContent` impide que phase_bets se actualice al cambiar apuestas de grupos. Si el usuario edita, sus puntos de R32 quedan con la proyección antigua. Regenerar con el SQL de la sección "Auto-guardado y gotcha del guard".
- **Default view config**: stored in `app_config` table. `default_view` (tab) + `default_view_stage` (phase). Read by all users, written by admin only.
- **Phase deadlines (countdown)**: per-stage timer that enables knockout betting during active countdown. The admin sets an **end datetime** (not a duration) via the admin panel (`PUT /api/admin/phase-deadlines/:stage` accepts `{ endDatetime }`). The `isPhaseEditingAllowed` check auto-deactivates the row when the deadline passes (self-healing). The frontend `startCountdownUpdater` clears the interval when `remaining <= 0` to avoid the stuck-countdown bug. SSE broadcast on toggle.
- **Auto-advance deshabilitado**: `advanceWinners()` (que ponía al ganador de un partido en el `next_match_id` de la siguiente fase) está **DESHABILITADO** en todos los call sites. El admin asigna manualmente los equipos que pasan de ronda editando los partidos (vía el toggle "Editar" en la UI). La función sigue definida y exportada por si en el futuro se quiere reactivar, pero ya no se ejecuta sola. Esto evita bugs donde un equipo aparecía duplicado en varios partidos (p.ej. Canadá en dos partidos de R16 por llamar a `advanceWinners` dos veces).
- **Orphaned team references**: if sync-fixtures deletes teams, existing `phase_bets` and `special_bets` referencing deleted team_ids become invisible (INNER JOIN hides them). Clean up with `DELETE FROM phase_bets WHERE team_id NOT IN (SELECT id FROM teams)`. Auto-save regenerates on next match prediction.
- **SVGs** replace emojis. Use `class="icon"` with `fill="currentColor"`.
- **`seed.js` does not exist** — `npm run seed` fails.
- **PM2 Node version**: pm2 uses Node 22, system node is 18. Don't run node scripts directly outside pm2.

## Theme & UI (dark mode)

La web está en **tema oscuro** (`color-scheme: dark` en `body`). Los colores se controlan vía variables CSS en `:root` (`public/css/style.css`).

### Paleta principal

| Variable | Valor | Uso |
|---|---|---|
| `--pitch-green` | `#166b2e` | Verde campo (acento de marca) |
| `--pitch-dark` | `#0c3d18` | Verde oscuro (gradient con pitch-green) |
| `--pitch-light` | `#1e8a38` | Verde claro (acentos) |
| `--gold` | `#e5b800` | Dorado (acentos, borde de topbar y cards) |
| `--gold-light` | `#ffe066` | Dorado claro (texto sobre fondos oscuros) |
| `--blue` / `--blue-light` | `#1a3a6b` / `#2a5a9b` | Azul (reservado) |
| `--on-color` | `#ffffff` | Texto blanco sobre superficies de color (botones, badges) |
| `--bg` | `#0f1419` | Fondo del body y main-content (azul muy oscuro) |
| `--surface` | `#1a1f2e` | Superficie de cards y modales |
| `--surface-2` | `#232a3d` | Superficie anidada (headers, inputs) |
| `--white` | `#1a1f2e` | Redefinido a surface (para que `var(--white)` en fondos sea oscuro) |
| `--gray-50` a `--gray-900` | Escala invertida | `gray-50=#0f1419` (más oscuro) → `gray-900=#f0f0f0` (más claro) |

**Marcas de marca conservadas**: verde campo y dorado. El resto es navy oscuro.

### Layout

- **`.main-content`**: edge-to-edge (`width:100%`, `padding:0`, sin max-width ni centrado). Ocupa toda la pantalla (`min-height: calc(100vh - 60px)`) con fondo `var(--bg)`.
- **`.card`**: `width:100%`, sin border-radius ni sombra. Borde superior de 3px en `var(--gold)` (marca de cada sección). Borde inferior `1px solid var(--gray-200)` para separar cards. Fondo: `linear-gradient(180deg, var(--surface) 0%, #1e2536 100%)`.
- **`.card-header`**: `linear-gradient(180deg, #232a3d 0%, #1e2536 100%)` con `padding: 16px 24px`.
- **`.card-body`**: `padding: 20px 24px`.
- **`.topbar`**: `linear-gradient(180deg, #1a1f2e 0%, #131822 100%)` con `border-bottom: 2px solid var(--gold)`. Consistente con el navbar móvil.

### Elementos adaptados al oscuro

- **Botones primarios** (`.btn-primary`): verde campo con texto blanco (`--on-color`).
- **Botones outline** (`.btn-outline`): fondo `var(--gray-100)`, borde `var(--gray-300)`, texto `var(--gray-800)`.
- **Inputs / selects**: fondo `var(--gray-100)`, texto `var(--gray-900)`. Los selects nativos usan `color-scheme: dark`.
- **Pills de acierto** (`.match-bet-prediction.hit-exact` / `.hit-winner` / `.hit-none`): fondos sólidos oscuros con texto blanco y borde de color.
- **`.match-points`**: `background: transparent`, `color: var(--gold-light)` (texto dorado sin fondo, sobre la card oscura).
- **Partidos en juego** (`.match-item.live-now`): `background: rgba(239,68,68,0.12)` (tinte rojo translúcido). Variantes suspended/delayed usan tintes amber/púrpura translúcidos.
- **Modales**: fondo `var(--white)` = `#1a1f2e` (oscuro). El header del modal "Porras del grupo" usa un verde más claro (`#2d8a3e` → `#1e6b2c`) para destacar.

### Convenciones para nuevos elementos

- **Fondo de superficies**: usar variables (`var(--bg)`, `var(--surface)`, `var(--surface-2)`, `var(--gray-100)`) en vez de colores hardcoded.
- **Texto sobre superficies de color**: usar `var(--on-color)` (blanco). No usar `var(--white)` para texto (es oscuro).
- **Texto principal**: `var(--gray-900)` (casi blanco). Texto secundario: `var(--gray-600)` o `var(--gray-500)`.
- **Acentos**: `var(--gold)` para bordes/destacados, `var(--pitch-green)` para verde, `var(--red)` para alertas.
- **No usar colores claros hardcoded** (`#fff`, `#fef2f2`, `#f0fdf4`, etc.) en fondos — el tema es oscuro. Si necesitas un pill/badge, usa colores sólidos oscuros (`#064e1f`, `#3d2e02`) o rgba translúcido sobre la card.

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
# Per-user R32 hits (proyección desde group_bets vs phase_results)
sqlite3 mundo-porras.db "SELECT u.username, COUNT(*) as hits FROM phase_bets pb JOIN users u ON pb.user_id=u.id JOIN phase_results pr ON pb.team_id=pr.team_id AND pb.stage=pr.stage WHERE pb.stage='round_of_32' GROUP BY u.username;"
# Regenerar phase_bets R32 para un usuario (ejecutar tras DELETE del paso anterior, con la query de computeQualifiedTeams)
# Count match predictions per user
sqlite3 mundo-porras.db "SELECT u.username, COUNT(*) FROM bets b JOIN users u ON b.user_id = u.id JOIN matches m ON b.match_id = m.id WHERE m.stage='group' AND b.home_score IS NOT NULL GROUP BY u.username;"
# Logs
pm2 logs mundo-porras
```
