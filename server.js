const express = require('express');
const session = require('express-session');
const SQLiteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const db = require('./database');
const resultChecker = require('./result-checker');
const liveApi = require('./live-api');

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 30000; // 30 seconds

function getCached(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_TTL) {
    return item.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

function invalidateCache(pattern) {
  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      cache.delete(key);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));

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

app.put('/api/auth/profile', requireAuth, (req, res) => {
  const { username, profile_photo } = req.body;
  const user = db.getUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (username && username !== user.username) {
    const existing = db.getUser(username);
    if (existing) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    if (username.length < 3) return res.status(400).json({ error: 'Mínimo 3 caracteres' });
    db.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.session.userId);
  }
  if (profile_photo !== undefined) {
    db.db.prepare('UPDATE users SET profile_photo = ? WHERE id = ?').run(profile_photo || null, req.session.userId);
  }
  const updated = db.getUserById(req.session.userId);
  res.json(updated);
});

// Teams
app.get('/api/teams', requireAuth, (req, res) => {
  res.json(db.getTeams());
});

// Matches
app.get('/api/matches', requireAuth, (req, res) => {
  const { stage, group } = req.query;
  const cacheKey = `matches_${stage || 'all'}_${group || 'all'}`;
  
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }
  
  let result;
  if (group) {
    result = db.getMatchesByGroup(group);
  } else {
    result = db.getMatches(stage);
  }
  
  setCache(cacheKey, result);
  res.json(result);
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
  const cacheKey = `bets_${req.session.userId}`;
  
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }
  
  const result = db.getBets(req.session.userId);
  setCache(cacheKey, result);
  res.json(result);
});

app.get('/api/bets/match/:matchId', requireAuth, (req, res) => {
  const bet = db.getUserBet(req.session.userId, parseInt(req.params.matchId));
  res.json(bet || {});
});

app.get('/api/bets/match/:matchId/group', requireAuth, (req, res) => {
  const matchId = parseInt(req.params.matchId);
  const user = db.getUserById(req.session.userId);
  const match = db.getMatch(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Partido no encontrado' });
  }
  const bets = db.getMatchBetsByGroup(matchId, user.group_id);
  res.json({
    match: {
      id: match.id,
      home_score: match.home_score,
      away_score: match.away_score,
      played: match.played
    },
    bets: bets
  });
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
  res.json({ bets, phaseBets, specialBets, username: target.username, profile_photo: target.profile_photo || null });
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
  invalidateCache('bets');
  invalidateCache('standings');
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
  if (isPastDeadline()) {
    return res.status(403).json({ error: 'Plazo vencido — las apuestas especiales se cerraron a las 20:45' });
  }
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

app.get('/api/stats', requireAuth, (req, res) => {
  try {
    const user = db.getUserById(req.session.userId);
    const groupId = user.group_id;
    const members = db.getGroupMembers(groupId);
    const matches = db.getMatches();
    const playedMatches = matches.filter(m => m.played === 1);
    const totalPlayed = playedMatches.length;

    const stats = members.map(m => {
      const bets = db.getBets(m.id);
      const specialBets = db.getSpecialBets(m.id);
      const phaseBets = db.getPhaseBets(m.id);

      let exactHits = 0;
      let winnerHits = 0;
      let totalHits = 0;
      let totalMisses = 0;
      let totalPredicted = 0;
      let totalPoints = 0;
      let bestStreak = 0;
      let currentStreak = 0;
      let skipped = 0;

      const sortedBets = [...bets].sort((a, b) => {
        const ma = matches.find(mt => mt.id === a.match_id);
        const mb = matches.find(mt => mt.id === b.match_id);
        return (ma?.match_date || '') > (mb?.match_date || '') ? 1 : -1;
      });

      for (const bet of sortedBets) {
        if (bet.home_score === null || bet.away_score === null) {
          skipped++;
          continue;
        }
        totalPredicted++;
        if (!bet.played) continue;

        const actualHome = bet.actual_home;
        const actualAway = bet.actual_away;
        if (actualHome === null || actualAway === null) continue;

        const predictWinner = bet.home_score > bet.away_score ? 'home' : (bet.away_score > bet.home_score ? 'away' : 'draw');
        const actualWinner = actualHome > actualAway ? 'home' : (actualAway > actualHome ? 'away' : 'draw');

        if (bet.home_score === actualHome && bet.away_score === actualAway) {
          exactHits++;
          totalHits++;
          currentStreak++;
          if (currentStreak > bestStreak) bestStreak = currentStreak;
        } else if (predictWinner === actualWinner) {
          winnerHits++;
          totalHits++;
          currentStreak++;
          if (currentStreak > bestStreak) bestStreak = currentStreak;
        } else {
          totalMisses++;
          currentStreak = 0;
        }
        totalPoints += bet.points_earned || 0;
      }

      const phasePoints = phaseBets.reduce((s, p) => s + (p.points_earned || 0), 0);
      const specialPoints = specialBets.reduce((s, b) => s + (b.points_earned || 0), 0);

      const completed = bets.filter(b => b.played === 1 && b.home_score !== null).length;
      const accuracy = completed > 0 ? Math.round((totalHits / completed) * 100) : 0;

      return {
        id: m.id,
        username: m.username,
        is_admin: m.is_admin,
        totalPoints: totalPoints + phasePoints + specialPoints,
        matchPoints: totalPoints,
        phasePoints,
        specialPoints,
        exactHits,
        winnerHits,
        totalHits,
        totalMisses,
        totalPredicted,
        completed,
        accuracy,
        bestStreak,
        skipped,
      };
    });

    stats.sort((a, b) => b.totalPoints - a.totalPoints);

    const matchResults = playedMatches.map(m => {
      const home = db.getTeam(m.home_team_id);
      const away = db.getTeam(m.away_team_id);
      return {
        matchId: m.id,
        homeTeam: home ? home.name : '?',
        awayTeam: away ? away.name : '?',
        homeScore: m.home_score,
        awayScore: m.away_score,
        stage: m.stage,
        groupLetter: m.group_letter,
      };
    });

    const upsetMatches = [];
    for (const match of matchResults) {
      if (match.stage !== 'group') continue;
      let totalBets = 0;
      let exactCount = 0;

      for (const member of members) {
        const bets = db.getBets(member.id);
        const bet = bets.find(b => b.match_id === match.matchId);
        if (!bet || bet.home_score === null) continue;
        totalBets++;
        if (bet.home_score === match.homeScore && bet.away_score === match.awayScore) {
          exactCount++;
        }
      }

      upsetMatches.push({
        ...match,
        totalBets,
        exactCount,
        surpriseLevel: totalBets > 0 ? Math.round(((totalBets - exactCount) / totalBets) * 100) : 0,
      });
    }
    upsetMatches.sort((a, b) => b.surpriseLevel - a.surpriseLevel);

    res.json({
      members: stats,
      totalPlayed,
      totalMatches: matches.length,
      totalMembers: members.length,
      upsetMatches: upsetMatches.filter(m => m.surpriseLevel > 80),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/standings', requireAuth, (req, res) => {
  const user = db.getUserById(req.session.userId);
  const cacheKey = `standings_${user.group_id}`;
  
  const cached = getCached(cacheKey);
  if (cached) {
    return res.json(cached);
  }
  
  const result = db.getStandings(user.group_id);
  setCache(cacheKey, result);
  res.json(result);
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
  const match = db.getMatch(matchId);
  if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
  const h = Number(homeScore);
  const a = Number(awayScore);
  if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) {
    return res.status(400).json({ error: 'Resultados inválidos: deben ser números enteros no negativos' });
  }
  db.setMatchResult(matchId, h, a);
  db.recalculateAllPoints();
  
  invalidateCache('matches');
  invalidateCache('bets');
  invalidateCache('standings');

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

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const user = db.getUserById(req.session.userId);
    const groupId = user.group_id;
    const members = db.getGroupMembers(groupId);
    const matches = db.getMatches();
    const playedMatches = matches.filter(m => m.played === 1);
    const totalPlayed = playedMatches.length;

    const stats = members.map(m => {
      const bets = db.getBets(m.id);
      const specialBets = db.getSpecialBets(m.id);
      const phaseBets = db.getPhaseBets(m.id);

      let exactHits = 0;
      let winnerHits = 0;
      let totalHits = 0;
      let totalMisses = 0;
      let totalPredicted = 0;
      let totalPoints = 0;

      for (const bet of bets) {
        if (bet.home_score === null || bet.away_score === null) continue;
        totalPredicted++;
        if (!bet.played) continue;

        const actualHome = bet.actual_home;
        const actualAway = bet.actual_away;
        if (actualHome === null || actualAway === null) continue;

        const predictWinner = bet.home_score > bet.away_score ? 'home' : (bet.away_score > bet.home_score ? 'away' : 'draw');
        const actualWinner = actualHome > actualAway ? 'home' : (actualAway > actualHome ? 'away' : 'draw');

        if (bet.home_score === actualHome && bet.away_score === actualAway) {
          exactHits++;
          totalHits++;
        } else if (predictWinner === actualWinner) {
          winnerHits++;
          totalHits++;
        } else {
          totalMisses++;
        }
        totalPoints += bet.points_earned || 0;
      }

      const phasePoints = phaseBets.reduce((s, p) => s + (p.points_earned || 0), 0);
      const specialPoints = specialBets.reduce((s, b) => s + (b.points_earned || 0), 0);

      const completed = bets.filter(b => b.played === 1 && b.home_score !== null).length;
      const accuracy = completed > 0 ? Math.round((totalHits / completed) * 100) : 0;

      return {
        id: m.id,
        username: m.username,
        is_admin: m.is_admin,
        totalPoints: totalPoints + phasePoints + specialPoints,
        matchPoints: totalPoints,
        phasePoints,
        specialPoints,
        exactHits,
        winnerHits,
        totalHits,
        totalMisses,
        totalPredicted,
        completed,
        accuracy,
        pendingPredictions: totalPredicted - completed,
        specialBetsCount: specialBets.length,
        phaseBetsCount: phaseBets.length,
      };
    });

    stats.sort((a, b) => b.totalPoints - a.totalPoints);

    const matchResults = playedMatches.map(m => {
      const home = db.getTeam(m.home_team_id);
      const away = db.getTeam(m.away_team_id);
      return {
        matchId: m.id,
        homeTeam: home ? home.name : '?',
        awayTeam: away ? away.name : '?',
        homeScore: m.home_score,
        awayScore: m.away_score,
        stage: m.stage,
        groupLetter: m.group_letter,
      };
    });

    const upsetMatches = [];
    for (const match of matchResults) {
      if (match.stage !== 'group') continue;
      const betCounts = { exactHome: 0, exactAway: 0, exactDraw: 0, winnerHome: 0, winnerAway: 0, winnerDraw: 0, wrong: 0 };
      let totalBets = 0;
      let exactCount = 0;

      for (const member of members) {
        const bets = db.getBets(member.id);
        const bet = bets.find(b => b.match_id === match.matchId);
        if (!bet || bet.home_score === null) continue;
        totalBets++;
        if (bet.home_score === match.homeScore && bet.away_score === match.awayScore) {
          exactCount++;
          continue;
        }
        const pw = bet.home_score > bet.away_score ? 'home' : (bet.away_score > bet.home_score ? 'away' : 'draw');
        const aw = match.homeScore > match.awayScore ? 'home' : (match.awayScore > match.homeScore ? 'away' : 'draw');
        if (pw !== aw) betCounts.wrong++;
      }

      upsetMatches.push({
        ...match,
        totalBets,
        exactCount,
        surpriseLevel: totalBets > 0 ? Math.round(((totalBets - exactCount) / totalBets) * 100) : 0,
      });
    }
    upsetMatches.sort((a, b) => b.surpriseLevel - a.surpriseLevel);

    res.json({
      members: stats,
      totalPlayed,
      totalMatches: matches.length,
      totalMembers: members.length,
      upsetMatches: upsetMatches.filter(m => m.surpriseLevel > 80),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

app.post('/api/admin/sync-from-thesportsdb', requireAdmin, async (req, res) => {
  try {
    const before = db.db.prepare(`
      SELECT COUNT(*) as c FROM matches
      WHERE played = 0 AND stage = 'group' AND match_date IS NOT NULL
        AND datetime(match_date) <= datetime('now', '-75 minutes')
    `).get().c;

    await liveApi.fetchLiveMatches(db);
    const result = await liveApi.syncLiveResultsWithDb(db);
    db.recalculateAllPoints();

    invalidateCache('matches');
    invalidateCache('bets');
    invalidateCache('standings');

    const after = db.db.prepare(`
      SELECT COUNT(*) as c FROM matches
      WHERE played = 0 AND stage = 'group' AND match_date IS NOT NULL
        AND datetime(match_date) <= datetime('now', '-75 minutes')
    `).get().c;

    res.json({
      success: true,
      updated: result.updated,
      liveCount: result.liveCount,
      pendingBefore: before,
      pendingAfter: after
    });
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

app.post('/api/admin/check-results', requireAdmin, async (req, res) => {
  try {
    const result = await resultChecker.checkAndUpdateResults(db, { force: true });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/check-stats', requireAdmin, (req, res) => {
  res.json(resultChecker.getCheckStats());
});

const sseClients = new Set();

app.get('/api/live/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res };
  sseClients.add(client);

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepAlive); }
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
});

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

liveApi.onLiveUpdate((event) => {
  broadcastSSE(event);
  if (event.finished) {
    broadcastSSE({ type: 'standings_update' });
  }
});

app.get('/api/live/matches', requireAuth, async (req, res) => {
  try {
    const { translateTeamName, getCachedMatches } = require('./live-api');
    let liveMatches = getCachedMatches();
    if (liveMatches.length === 0 || req.query.force === '1') {
      liveMatches = await liveApi.getLiveMatches(req.query.force === '1');
    }
    const dbMatches = db.getMatches();
    const result = [];

    for (const live of liveMatches) {
      const homeName = translateTeamName(live.homeTeam);
      const awayName = translateTeamName(live.awayTeam);

      const dbMatch = dbMatches.find(m => {
        const ht = m.home_team;
        const at = m.away_team;
        return (ht === homeName && at === awayName) || (ht === awayName && at === homeName);
      });

      result.push({
        matchId: dbMatch ? dbMatch.id : null,
        homeTeam: homeName,
        awayTeam: awayName,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        status: live.status,
        minute: live.minute,
        isLive: live.isLive,
        isFinished: live.isFinished,
        timestamp: live.timestamp,
      });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live/status', requireAuth, async (req, res) => {
  try {
    const liveMatches = await liveApi.getLiveMatches();
    res.json({
      hasLiveMatches: liveApi.hasLiveMatchesNow(),
      liveCount: liveMatches.filter(m => m.isLive).length,
      finishedCount: liveMatches.filter(m => m.isFinished).length,
      lastUpdate: lastFetch,
    });
  } catch (e) {
    res.json({ hasLiveMatches: false, liveCount: 0, finishedCount: 0, lastUpdate: null });
  }
});

(async () => {
  try {
    await db.initData();
  } catch (e) {
    console.error('initData error:', e.message);
  }
  resultChecker.startResultChecker(db);
  liveApi.startLivePolling(db);

  setInterval(() => {
    try {
      const result = db.autoRepairMatches();
      if (result.repaired > 0) {
        console.log(`🔧 Auto-reparación: ${result.repaired} partido(s) corregido(s)`);
        db.recalculateAllPoints();
        invalidateCache('matches');
        invalidateCache('bets');
        invalidateCache('standings');
      }
    } catch (e) {
      console.error('Auto-repair error:', e.message);
    }
  }, 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Mundial Porras app corriendo en http://localhost:${PORT}`);
    console.log('🔄 Verificación de resultados finales: activa');
    console.log('📡 Live polling (TheSportsDB): activo');
    console.log('🔧 Auto-reparación de integridad: activa (cada 60s)');
  });
})();
