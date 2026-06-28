# Porra Mundial 2026

Aplicación web para gestionar porras (pronósticos) del Mundial FIFA 2026. Permite a grupos de usuarios crear pronósticos de partidos, fases del torneo y apuestas especiales, con sistema de puntuación automático y actualización en tiempo real de resultados.

## Arquitectura

Aplicación monolítica con Express.js (backend) y SPA vanilla JavaScript (frontend).

| Componente | Descripción |
|---|---|
| `server.js` | API REST, autenticación, caching, SSE, rutas admin |
| `database.js` | SQLite (WAL), esquema con auto-migraciones, queries, scoring |
| `live-api.js` | Cliente TheSportsDB, polling de partidos en vivo, eventos SSE |
| `result-checker.js` | Sincronización multi-fuente (openfootball, football-data.org, TheSportsDB) |
| `public/dashboard.html` | SPA frontend (~3800 líneas) |
| `public/js/api.js` | Wrapper de fetch para todas las llamadas API |
| `public/css/style.css` | Estilos (~2500 líneas) |

## Instalación

```bash
npm install
npm start
```

El servidor arranca en `http://localhost:3000`.

## Base de datos

SQLite con WAL mode. Tablas principales:

- `groups` — Grupos de usuarios con código de invitación
- `users` — Usuarios con hash bcrypt, photo de perfil
- `teams` — Equipos del mundial (48 selecciones)
- `matches` — Partidos con estado, resultado y fecha
- `bets` — Pronósticos de partidos por usuario
- `phase_bets` — Pronósticos de fases (octavos, cuartos, etc.)
- `special_bets` — Apuestas especiales (campeón, goleador, MVP)
- `phase_results` — Resultados reales por fase
- `players` — Jugadores (sincronizados desde Wikipedia)
- `phase_deadlines` — Temporizadores por fase knockout
- `app_config` — Configuración de la aplicación

Migraciones automáticas al iniciar. Triggers de integridad que rechazan `played=1` con scores NULL o fecha futura.

## Autenticación

- Registro con usuario + contraseña + código de invitación de grupo
- Sesiones SQLite (7 días, extensible a 30 con "recordarme")
- Admin = creador del grupo; puede promover otros usuarios
- Rutas `/api/admin/*` requieren permisos de admin

## Sistema de puntuación

### Partidos

| Escenario | Fase de grupos | Eliminatorias |
|---|---|---|
| Marcador exacto | 10 pts | 15 pts |
| Ganador correcto | 5 pts | 7 pts |
| Empate correcto (sin pick de penales) | 5 pts | 3 pts |
| Incorrecto | 0 pts | 0 pts |

### Penales en eliminatorias

Si el usuario predice empate y selecciona un ganador de penales (`penalty_winner_id`), ambos `predictWinner` y `actualWinner` se resuelven con ese pick. Esto significa que un empate + pick de penales se convierte en predicción de ganador.

### Fases del torneo

Por cada equipo correctamente predicho en cada fase: 2/4/6/10/15 pts (dieciseisavos → final).

### Apuestas especiales

| Tipo | Puntos |
|---|---|
| Campeón | 50 |
| Subcampeón | 30 |
| Tercer lugar | 20 |
| Goleador (Pichichi) | 40 |
| MVP | 40 |

### Bonus: Cruce acertado

+5 pts si ambos equipos de un partido de eliminatorias están en las predicciones de fase del usuario.

## Funcionalidades principales

### Pronósticos de partidos
- Predicciones por grupo con countdown por deadline
- Tabla de comparación con otros miembros del grupo
- Edición bloqueada después del deadline o si el partido ya comenzó

### Fases del torneo
- Predicciones de clasificación por ronda (dieciseisavos → final)
- Auto-generación desde predicciones de partidos (solo si vacío)
- Temporizadores configurables por fase desde panel admin

### Apuestas especiales
- Campeón, subcampeón, tercero, goleador, MVP
- Búsqueda de jugadores desde Wikipedia
- Advertencia si faltan por completar

### Clasificación
- Ranking con puntos totales (partidos + fases + especiales)
- Precisión de predicciones (hits exactos vs ganador)
- Partidos sorpresa (donde >80% se equivocó)

### Panel de administración
- Gestión de partidos (CRUD)
- Sincronización desde APIs externas
- Resultados automáticos multi-fuente
- Gestión de usuarios y permisos
- Configuración de deadlines por fase

## Fuentes de datos

### Resultados (result-checker.js)
1. **openfootball** — GitHub con datos JSON del mundial
2. **TheSportsDB** — API gratuita con resultados en vivo
3. **football-data.org** — API con token (opcional)

### Partidos en vivo (live-api.js)
- Polling a TheSportsDB cada 60s (partidos activos) o 5min (inactivo)
- Eventos SSE para actualización en tiempo real al frontend

## Despliegue

### PM2 (producción)
```bash
pm2 start ecosystem.config.js    # inicia mundo-porras
pm2 restart mundo-porras          # reiniciar
pm2 logs mundo-porras             # ver logs
```

### Variables de entorno
- `PORT` — Puerto del servidor (default: 3000)
- `FOOTBALL_DATA_TOKEN` — Token API football-data.org (opcional)
- `NODE_ENV=production` — Desactiva hot-reload del frontend

## Notas técnicas

- Caching en memoria con TTL de 30s, invalidación por patrón
- `autoFillPhaseResults()` se ejecuta en cada operación de resultado/sync
- Triggers SQLite rechazan violaciones de integridad; `autoRepairMatches()` las revierte cada 60s
- Nombres de equipo traducidos al español con mapa `TEAM_NAME_ES` (sincronizado entre database.js y live-api.js)
- El endpoint `/api/version` habilita hot-reload en desarrollo
- `seed.js` no existe — `npm run seed` falla (ignorar)
