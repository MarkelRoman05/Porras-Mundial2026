const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'mundial-2026-porras-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
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
  const { username, password } = req.body;
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

app.post('/api/bets', requireAuth, (req, res) => {
  const { matchId, homeScore, awayScore } = req.body;
  if (homeScore === undefined || awayScore === undefined || matchId === undefined) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  db.saveBet(req.session.userId, matchId, homeScore, awayScore);
  res.json({ success: true });
});

app.post('/api/bets/batch', requireAuth, (req, res) => {
  const { bets } = req.body;
  if (!Array.isArray(bets)) {
    return res.status(400).json({ error: 'Formato inválido' });
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

app.get('/api/admin/group-info', requireAdmin, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const group = db.getGroup(user.group_id);
  const members = db.getGroupMembers(user.group_id);
  res.json({ ...group, members });
});

app.listen(PORT, () => {
  console.log(`Mundial Porras app corriendo en http://localhost:${PORT}`);
});
