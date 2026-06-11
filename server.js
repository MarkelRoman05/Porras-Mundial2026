const express = require('express');
const session = require('express-session');
const SQLiteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Global no-cache for all responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.use(session({
  store: new SQLiteStore({ client: db.db, expired: { clear: true, intervalMs: 60000 } }),
  secret: 'mundial-2026-porras-secret-key',
  resave: true,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: false,
    sameSite: 'lax'
  }
}));

// Root route: redirect to dashboard if logged in, else login
app.get('/', (req, res) => {
  if (req.session?.userId) {
    return res.redirect('/dashboard.html');
  }
  res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  const user = db.getUserById(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Se requiere ser admin' });
  }
  next();
}

// Deadline: 11-Jun-2026 20:45 Europe/Madrid (UTC+2 → 18:45 UTC)
const GROUP_DEADLINE = new Date('2026-06-11T18:45:00Z').getTime();
function isPastDeadline() {
  return Date.now() >= GROUP_DEADLINE;
}

// Auth routes
app.post('/api/auth/register', (req, res) => {
  const { username, password, groupName, inviteCode } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  if (username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'Usuario (min 3) y contraseña (min 4)' });
  }

  const existing = db.getUser(username);
  if (existing) {
    return res.status(400).json({ error: 'El usuario ya existe' });
  }

  let groupId;
  if (inviteCode) {
    const group = db.getGroupByInvite(inviteCode.toUpperCase());
    if (!group) {
      return res.status(400).json({ error: 'Código de grupo inválido' });
    }
    groupId = group.id;
  } else {
    const group = db.createGroup(groupName || `Grupo de ${username}`);
    groupId = group.id;
  }

  const isAdmin = inviteCode ? 0 : 1;
  db.createUser(username, password, groupId, isAdmin);
  const user = db.getUser(username);
  req.session.userId = user.id;
  res.json({ success: true, user: { id: user.id, username: user.username } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, rememberMe } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }

  const user = db.getUser(username);
  if (!user) {
    return res.status(400).json({ error: 'Usuario no encontrado' });
  }

  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: 'Contraseña incorrecta' });
  }

  req.session.userId = user.id;
  if (rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
  }
  res.json({
    success: true,
    user: { id: user.id, username: user.username, is_admin: user.is_admin, group_id: user.group_id }
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'Usuario no encontrado' });
  }
  const group = db.getGroup(user.group_id);
  res.json({
    ...user,
    group_name: group ? group.name : null,
    invite_code: group ? group.invite_code : null
  });
});

// Teams
app.get('/api/teams', requireAuth, (req, res) => {
  res.json(db.getTeams());
});

// Matches
app.get('/api/matches', requireAuth, (req, res) => {
  const { stage, group } = req.query;
  if (group) {
    return res.json(db.getMatchesByGroup(group));
  }
  res.json(db.getMatches(stage));
});

app.get('/api/matches/:id', requireAuth, (req, res) => {
  res.json(db.getMatch(parseInt(req.params.id)));
});

app.put('/api/matches/:id/result', requireAdmin, (req, res) => {
  const { home_score, away_score } = req.body;
  const id = parseInt(req.params.id);
  db.setMatchResult(id, home_score, away_score);
  db.calculateMatchPoints(req.session.userId);
  res.json({ success: true });
});

app.post('/api/admin/matches', requireAdmin, (req, res) => {
  const { homeTeamId, awayTeamId, stage, groupLetter, matchDate } = req.body;
  if (!homeTeamId || !awayTeamId || !stage) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  const id = db.createMatch(homeTeamId, awayTeamId, stage, groupLetter, matchDate);
  res.json({ success: true, matchId: id });
});

// Bets
app.get('/api/bets', requireAuth, (req, res) => {
  res.json(db.getBets(req.session.userId));
});

app.get('/api/bets/match/:matchId', requireAuth, (req, res) => {
  const bet = db.getUserBet(req.session.userId, parseInt(req.params.matchId));
  res.json(bet || {});
});

app.get('/api/bets/user/:userId', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.userId);
  const me = db.getUserById(req.session.userId);
  const target = db.getUserById(targetId);
  if (!target || target.group_id !== me.group_id) {
    return res.status(403).json({ error: 'No puedes ver pronósticos de ese usuario' });
  }
  const bets = db.getBets(targetId);
  const phaseBets = db.getPhaseBets(targetId);
  const specialBets = db.getSpecialBets(targetId);
  res.json({ bets, phaseBets, specialBets, username: target.username });
});

app.post('/api/bets', requireAuth, (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  if (homeScore === undefined || awayScore === undefined || matchId === undefined) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
  if (match.stage === 'group' && isPastDeadline()) {
    return res.status(403).json({ error: 'Plazo vencido — los pronósticos de grupos se cerraron a las 20:45' });
  }
  db.saveBet(req.session.userId, matchId, homeScore, awayScore);
  res.json({ success: true });
});

app.post('/api/bets/batch', requireAuth, (req, res) => {
  const { bets } = req.body;
  if (!Array.isArray(bets)) {
    return res.status(400).json({ error: 'Formato inválido' });
  }
  if (isPastDeadline()) {
    for (const bet of bets) {
      if (bet.matchId) {
        const match = db.getMatch(bet.matchId);
        if (match && match.stage === 'group') {
          return res.status(403).json({ error: 'Plazo vencido — los pronósticos de grupos se cerraron a las 20:45' });
        }
      }
    }
  }
  const insert = db.db.prepare(`
    INSERT INTO bets (user_id, match_id, home_score, away_score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id)
    DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score, points_earned = 0
  `);
  const txn = db.db.transaction(() => {
    for (const bet of bets) {
      if (bet.homeScore !== undefined && bet.awayScore !== undefined && bet.matchId) {
        insert.run(req.session.userId, bet.matchId, bet.homeScore, bet.awayScore);
      }
    }
  });
  txn();
  res.json({ success: true });
});

// Phase bets
app.get('/api/bets/phase', requireAuth, (req, res) => {
  res.json(db.getPhaseBets(req.session.userId));
});

app.post('/api/bets/phase', requireAuth, (req, res) => {
  const { teamIds, stage } = req.body;
  if (!stage || !Array.isArray(teamIds)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  db.clearPhaseBets(req.session.userId, stage);
  const insert = db.db.prepare(`
    INSERT INTO phase_bets (user_id, team_id, stage) VALUES (?, ?, ?)
  `);
  const txn = db.db.transaction(() => {
    for (const teamId of teamIds) {
      insert.run(req.session.userId, teamId, stage);
    }
  });
  txn();
  res.json({ success: true });
});

// Special bets
app.get('/api/bets/special', requireAuth, (req, res) => {
  res.json(db.getSpecialBets(req.session.userId));
});

app.post('/api/bets/special', requireAuth, (req, res) => {
  const { betType, teamId, playerName } = req.body;
  if (!betType) {
    return res.status(400).json({ error: 'Tipo de apuesta requerido' });
  }
  const validTypes = ['champion', 'runner_up', 'third_place', 'pichichi', 'mvp'];
  if (!validTypes.includes(betType)) {
    return res.status(400).json({ error: 'Tipo inválido' });
  }
  db.saveSpecialBet(req.session.userId, betType, teamId || null, playerName || null);
  res.json({ success: true });
});

// Standings
app.get('/api/standings', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  res.json(db.getStandings(user.group_id));
});

// Group info
app.get('/api/group', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const group = db.getGroup(user.group_id);
  const members = db.getGroupMembers(user.group_id);
  res.json({ ...group, members });
});

app.patch('/api/group', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Nombre inválido' });
  }
  const user = db.getUserById(req.session.userId);
  db.updateGroupName(user.group_id, name.trim());
  res.json({ success: true });
});

// Admin routes
app.post('/api/admin/phase-results', requireAdmin, (req, res) => {
  const { stage, teamIds } = req.body;
  if (!stage || !Array.isArray(teamIds)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  db.clearPhaseResults(stage);
  const insert = db.db.prepare('INSERT INTO phase_results (team_id, stage) VALUES (?, ?)');
  const txn = db.db.transaction(() => {
    for (const teamId of teamIds) {
      insert.run(teamId, stage);
    }
  });
  txn();
  db.recalculateAllPoints();
  res.json({ success: true });
});

app.get('/api/admin/phase-results', requireAdmin, (req, res) => {
  res.json(db.getPhaseResults(req.query.stage));
});

app.post('/api/admin/special-results', requireAdmin, (req, res) => {
  const { betType, teamId, playerName } = req.body;
  if (!betType) return res.status(400).json({ error: 'Tipo requerido' });
  db.setSpecialResult(betType, teamId || null, playerName || null);
  db.recalculateAllPoints();
  res.json({ success: true });
});

app.get('/api/admin/special-results', requireAdmin, (req, res) => {
  res.json(db.getSpecialResults());
});

app.post('/api/admin/recalculate', requireAdmin, (req, res) => {
  db.recalculateAllPoints();
  res.json({ success: true });
});

app.post('/api/admin/set-match-result', requireAdmin, (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  db.setMatchResult(matchId, homeScore, awayScore);
  db.recalculateAllPoints();

  res.json({ success: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/admin/users/:id/toggle-admin', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const newAdmin = user.is_admin ? 0 : 1;
  db.setUserAdmin(userId, newAdmin);
  res.json({ success: true, is_admin: newAdmin });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (userId === req.session.userId) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
  db.deleteUser(userId);
  res.json({ success: true });
});

app.get('/api/admin/group-info', requireAdmin, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const group = db.getGroup(user.group_id);
  const members = db.getGroupMembers(user.group_id);
  res.json({ ...group, members });
});

app.get('/api/admin/group-bets', requireAdmin, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const members = db.getGroupMembers(user.group_id);
  const matches = db.getMatches();
  const data = members.map(m => ({
    id: m.id,
    username: m.username,
    is_admin: m.is_admin,
    bets: db.getBets(m.id),
    phaseBets: db.getPhaseBets(m.id),
    specialBets: db.getSpecialBets(m.id)
  }));
  res.json({ members: data, matches });
});

app.post('/api/admin/sync-fixtures', requireAdmin, async (req, res) => {
  try {
    const stats = await db.syncFixturesFromApi();
    db.recalculateAllPoints();
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/update-results', requireAdmin, async (req, res) => {
  try {
    const stats = await db.syncMatchResults();
    db.recalculateAllPoints();
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Players
app.get('/api/players', requireAuth, (req, res) => {
  const { team_id, q } = req.query;
  if (q) {
    return res.json(db.searchPlayers(q));
  }
  res.json(db.getPlayers(team_id ? parseInt(team_id) : null));
});

app.post('/api/admin/sync-players', requireAdmin, async (req, res) => {
  try {
    const stats = await db.syncPlayersFromWikipedia();
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hot-reload version endpoint
let _version = Date.now().toString(36);
if (process.env.NODE_ENV !== 'production') {
  const fs = require('fs');
  const watchDir = path.join(__dirname, 'public');
  try {
    fs.watch(watchDir, { recursive: true }, (ev, file) => {
      if (file && !file.startsWith('.')) {
        _version = Date.now().toString(36);
        console.log('File changed:', file, '- version:', _version);
      }
    });
  } catch (e) { console.error('Watch error:', e.message); }
}
app.get('/api/version', (req, res) => res.json({ version: _version }));

(async () => {
  try {
    await db.initData();
  } catch (e) {
    console.error('initData error:', e.message);
  }
  app.listen(PORT, () => {
    console.log(`Mundial Porras app corriendo en http://localhost:${PORT}`);
  });
})();
