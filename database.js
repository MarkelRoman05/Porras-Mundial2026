const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'mundo-porras.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      group_id INTEGER NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES groups(id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      group_letter TEXT,
      eliminated INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      home_team_id INTEGER NOT NULL,
      away_team_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      group_letter TEXT,
      match_date DATETIME,
      home_score INTEGER,
      away_score INTEGER,
      played INTEGER DEFAULT 0,
      FOREIGN KEY (home_team_id) REFERENCES teams(id),
      FOREIGN KEY (away_team_id) REFERENCES teams(id)
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      match_id INTEGER NOT NULL,
      home_score INTEGER,
      away_score INTEGER,
      points_earned INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (match_id) REFERENCES matches(id),
      UNIQUE(user_id, match_id)
    );

    CREATE TABLE IF NOT EXISTS phase_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      team_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      points_earned INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      UNIQUE(user_id, team_id, stage)
    );

    CREATE TABLE IF NOT EXISTS special_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bet_type TEXT NOT NULL,
      team_id INTEGER,
      player_name TEXT,
      points_earned INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      UNIQUE(user_id, bet_type)
    );

    CREATE TABLE IF NOT EXISTS phase_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id),
      UNIQUE(team_id, stage)
    );

    CREATE TABLE IF NOT EXISTS special_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bet_type TEXT NOT NULL,
      team_id INTEGER,
      player_name TEXT,
      UNIQUE(bet_type)
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      position TEXT,
      jersey_number INTEGER,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `);

  const groupCount = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  if (groupCount.count === 0) {
    const code = generateCode();
    db.prepare('INSERT INTO groups (name, invite_code) VALUES (?, ?)').run('Grupo General', code);
  }
}

async function syncFixturesFromApi() {
  const url = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

  const response = await fetch(url);
  if (!response.ok) throw new Error('Error API: ' + response.status);
  const data = await response.json();

  const matches = data.matches || [];
  const groupMatches = matches.filter(m => m.group && m.group.startsWith('Group'));

  const teamsByGroup = {};
  for (const m of groupMatches) {
    const letter = m.group.replace('Group ', '');
    if (!teamsByGroup[letter]) teamsByGroup[letter] = new Set();
    teamsByGroup[letter].add(m.team1);
    teamsByGroup[letter].add(m.team2);
  }

  let stats = { teams: 0, matches: 0 };

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM bets').run();
    db.prepare('DELETE FROM phase_bets').run();
    db.prepare('DELETE FROM special_bets').run();
    db.prepare('DELETE FROM phase_results').run();
    db.prepare('DELETE FROM special_results').run();
    db.prepare('DELETE FROM matches').run();
    db.prepare('DELETE FROM teams').run();

    const insertTeam = db.prepare('INSERT INTO teams (name, group_letter) VALUES (?, ?)');
    for (const [group, teamSet] of Object.entries(teamsByGroup)) {
      for (const name of teamSet) {
        insertTeam.run(name, group);
        stats.teams++;
      }
    }

    const getTeamId = db.prepare('SELECT id FROM teams WHERE name = ?');
    const insertMatch = db.prepare(
      'INSERT INTO matches (home_team_id, away_team_id, stage, group_letter, match_date, home_score, away_score, played) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    for (const m of groupMatches) {
      const home = getTeamId.get(m.team1);
      const away = getTeamId.get(m.team2);
      if (!home || !away) continue;

      const letter = m.group.replace('Group ', '');
      let dateStr = m.date;
      if (m.time) {
        const parts = m.time.match(/^(\d{2}:\d{2})\s*UTC([+-]\d+)/);
        if (parts) {
          const [_, time, offset] = parts;
          const [h, min] = time.split(':').map(Number);
          const off = parseInt(offset);
          const utcDate = new Date(Date.UTC(2026, 5, parseInt(m.date.split('-')[2]), h - off, min));
          dateStr = utcDate.toISOString();
        } else {
          dateStr = `${m.date}T${m.time.split(' ')[0]}:00`;
        }
      }
      const score = m.score || [null, null];
      const played = score[0] !== null && score[1] !== null ? 1 : 0;

      insertMatch.run(home.id, away.id, 'group', letter, dateStr, score[0], score[1], played);
      stats.matches++;
    }
  });

  txn();
  return stats;
}

async function initData() {
  const count = db.prepare('SELECT COUNT(*) as count FROM teams').get();
  if (count.count === 0) {
    try {
      const stats = await syncFixturesFromApi();
      console.log(`Sincronizados ${stats.teams} equipos y ${stats.matches} partidos desde openfootball`);
    } catch (e) {
      console.error('Error al sincronizar desde API, usando seed local:', e.message);
      seedTeams();
      seedGroupMatches();
    }
  }
  // Auto-sync players if empty
  const playerCount = db.prepare('SELECT COUNT(*) as count FROM players').get();
  if (playerCount.count === 0) {
    try {
      const stats = await syncPlayersFromWikipedia();
      console.log(`Sincronizados ${stats.players} jugadores desde Wikipedia`);
    } catch (e) {
      console.error('Error al sincronizar jugadores:', e.message);
    }
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function seedTeams() {
  const teams = [
    ['Argentina', 'A'], ['Brasil', 'A'], ['Uruguay', 'A'], ['Colombia', 'A'],
    ['España', 'B'], ['Francia', 'B'], ['Portugal', 'B'], ['Países Bajos', 'B'],
    ['Alemania', 'C'], ['Inglaterra', 'C'], ['Italia', 'C'], ['Bélgica', 'C'],
    ['Japón', 'D'], ['Corea del Sur', 'D'], ['Australia', 'D'], ['Irán', 'D'],
    ['Marruecos', 'E'], ['Senegal', 'E'], ['Nigeria', 'E'], ['Egipto', 'E'],
    ['Croacia', 'F'], ['Suiza', 'F'], ['Dinamarca', 'F'], ['Serbia', 'F'],
    ['Ecuador', 'G'], ['Perú', 'G'], ['Chile', 'G'], ['Paraguay', 'G'],
    ['Arabia Saudí', 'H'], ['Catar', 'H'], ['EAU', 'H'], ['Irak', 'H'],
    ['Túnez', 'I'], ['Argelia', 'I'], ['Camerún', 'I'], ['Ghana', 'I'],
    ['Suecia', 'J'], ['Polonia', 'J'], ['Austria', 'J'], ['Ucrania', 'J'],
    ['EE.UU.', 'K'], ['México', 'K'], ['Canadá', 'K'], ['Jamaica', 'K'],
    ['Nueva Zelanda', 'L'], ['Costa Rica', 'L'], ['Panamá', 'L'], ['Honduras', 'L']
  ];
  const insert = db.prepare('INSERT INTO teams (name, group_letter) VALUES (?, ?)');
  for (const t of teams) {
    insert.run(t[0], t[1]);
  }
}

function seedGroupMatches() {
  const groups = 'ABCDEFGHIJKL';
  const insert = db.prepare(`
    INSERT INTO matches (home_team_id, away_team_id, stage, group_letter, match_date)
    VALUES (?, ?, 'group', ?, ?)
  `);

  for (const letter of groups) {
    const groupTeams = db.prepare('SELECT id FROM teams WHERE group_letter = ?').all(letter);
    const ids = groupTeams.map(t => t.id);
    const pairings = [[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
    let day = 0;
    for (const pair of pairings) {
      day++;
      const date = new Date(2026, 5, 11 + day).toISOString();
      insert.run(ids[pair[0]], ids[pair[1]], letter, date);
    }
  }
}

function getTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY group_letter, id').all();
}

function getTeam(teamId) {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
}

function getMatches(stage) {
  if (stage) {
    return db.prepare(`
      SELECT m.*, h.name as home_team, a.name as away_team
      FROM matches m
      JOIN teams h ON m.home_team_id = h.id
      JOIN teams a ON m.away_team_id = a.id
      WHERE m.stage = ?
      ORDER BY m.match_date, m.id
    `).all(stage);
  }
  return db.prepare(`
    SELECT m.*, h.name as home_team, a.name as away_team
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    ORDER BY m.match_date, m.id
  `).all();
}

function getMatchesByGroup(groupLetter) {
  return db.prepare(`
    SELECT m.*, h.name as home_team, a.name as away_team
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE m.group_letter = ? AND m.stage = 'group'
    ORDER BY m.match_date, m.id
  `).all(groupLetter);
}

function getMatch(id) {
  return db.prepare(`
    SELECT m.*, h.name as home_team, a.name as away_team
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE m.id = ?
  `).get(id);
}

function setMatchResult(id, homeScore, awayScore) {
  const played = homeScore !== null && awayScore !== null ? 1 : 0;
  db.prepare(`
    UPDATE matches SET home_score = ?, away_score = ?, played = ? WHERE id = ?
  `).run(homeScore, awayScore, played, id);
}

function createMatch(homeTeamId, awayTeamId, stage, groupLetter, matchDate) {
  const result = db.prepare(`
    INSERT INTO matches (home_team_id, away_team_id, stage, group_letter, match_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(homeTeamId, awayTeamId, stage, groupLetter || null, matchDate || null);
  return result.lastInsertRowid;
}

// Bets
function getBets(userId) {
  return db.prepare(`
    SELECT b.*, m.home_team_id, m.away_team_id, m.stage, m.group_letter, m.played,
           m.home_score as actual_home, m.away_score as actual_away,
           h.name as home_team, a.name as away_team
    FROM bets b
    JOIN matches m ON b.match_id = m.id
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE b.user_id = ?
  `).all(userId);
}

function saveBet(userId, matchId, homeScore, awayScore) {
  db.prepare(`
    INSERT INTO bets (user_id, match_id, home_score, away_score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id)
    DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score, points_earned = 0
  `).run(userId, matchId, homeScore, awayScore);
}

function getUserBet(userId, matchId) {
  return db.prepare(`
    SELECT b.*, m.home_score as actual_home, m.away_score as actual_away, m.played,
           h.name as home_team, a.name as away_team
    FROM bets b
    JOIN matches m ON b.match_id = m.id
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE b.user_id = ? AND b.match_id = ?
  `).get(userId, matchId);
}

// Phase bets
function getPhaseBets(userId) {
  return db.prepare(`
    SELECT pb.*, t.name as team_name, t.group_letter
    FROM phase_bets pb
    JOIN teams t ON pb.team_id = t.id
    WHERE pb.user_id = ?
    ORDER BY pb.stage, t.group_letter, t.name
  `).all(userId);
}

function savePhaseBet(userId, teamId, stage) {
  db.prepare(`
    INSERT INTO phase_bets (user_id, team_id, stage)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, team_id, stage)
    DO NOTHING
  `).run(userId, teamId, stage);
}

function deletePhaseBet(userId, teamId, stage) {
  db.prepare(`
    DELETE FROM phase_bets WHERE user_id = ? AND team_id = ? AND stage = ?
  `).run(userId, teamId, stage);
}

function clearPhaseBets(userId, stage) {
  db.prepare('DELETE FROM phase_bets WHERE user_id = ? AND stage = ?').run(userId, stage);
}

// Special bets
function getSpecialBets(userId) {
  return db.prepare(`
    SELECT sb.*, t.name as team_name
    FROM special_bets sb
    LEFT JOIN teams t ON sb.team_id = t.id
    WHERE sb.user_id = ?
    ORDER BY sb.bet_type
  `).all(userId);
}

function saveSpecialBet(userId, betType, teamId, playerName) {
  db.prepare(`
    INSERT INTO special_bets (user_id, bet_type, team_id, player_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, bet_type)
    DO UPDATE SET team_id = excluded.team_id, player_name = excluded.player_name, points_earned = 0
  `).run(userId, betType, teamId, playerName || null);
}

// Phase results (admin sets which teams reached which stage)
function setPhaseResult(teamId, stage) {
  db.prepare(`
    INSERT INTO phase_results (team_id, stage)
    VALUES (?, ?)
    ON CONFLICT(team_id, stage) DO NOTHING
  `).run(teamId, stage);
}

function getPhaseResults(stage) {
  if (stage) {
    return db.prepare(`
      SELECT pr.*, t.name as team_name, t.group_letter
      FROM phase_results pr
      JOIN teams t ON pr.team_id = t.id
      WHERE pr.stage = ?
      ORDER BY t.name
    `).all(stage);
  }
  return db.prepare(`
    SELECT pr.*, t.name as team_name, t.group_letter
    FROM phase_results pr
    JOIN teams t ON pr.team_id = t.id
    ORDER BY pr.stage, t.name
  `).all();
}

function clearPhaseResults(stage) {
  db.prepare('DELETE FROM phase_results WHERE stage = ?').run(stage);
}

// Special results
function setSpecialResult(betType, teamId, playerName) {
  db.prepare(`
    INSERT INTO special_results (bet_type, team_id, player_name)
    VALUES (?, ?, ?)
    ON CONFLICT(bet_type)
    DO UPDATE SET team_id = excluded.team_id, player_name = excluded.player_name
  `).run(betType, teamId, playerName || null);
}

function getSpecialResults() {
  return db.prepare(`
    SELECT sr.*, t.name as team_name
    FROM special_results sr
    LEFT JOIN teams t ON sr.team_id = t.id
    ORDER BY sr.bet_type
  `).all();
}

// Score calculation
function calculateMatchPoints(userId) {
  const userBets = db.prepare(`
    SELECT b.*, m.home_score as actual_home, m.away_score as actual_away,
           m.played, m.stage
    FROM bets b
    JOIN matches m ON b.match_id = m.id
    WHERE b.user_id = ? AND m.played = 1
  `).all(userId);

  let total = 0;
  const updatePoints = db.prepare('UPDATE bets SET points_earned = ? WHERE id = ?');

  for (const bet of userBets) {
    let points = 0;
    const predictHome = bet.home_score;
    const predictAway = bet.away_score;
    const actualHome = bet.actual_home;
    const actualAway = bet.actual_away;

    if (predictHome === null || predictAway === null) continue;

    const isGroup = bet.stage === 'group';
    const exactRight = predictHome === actualHome && predictAway === actualAway;
    const predictWinner = predictHome > predictAway ? 'home' : (predictAway > predictHome ? 'away' : 'draw');
    const actualWinner = actualHome > actualAway ? 'home' : (actualAway > actualHome ? 'away' : 'draw');

    if (exactRight) {
      points = isGroup ? 10 : 15;
    } else if (predictWinner === actualWinner) {
      if (predictWinner === 'draw') {
        points = isGroup ? 5 : 0;
      } else {
        points = isGroup ? 5 : 7;
      }
    }

    // "Cruce acertado" - both teams in knockout correctly predicted in phase bets
    if (!isGroup) {
      const matchInfo = getMatch(bet.match_id);
      if (matchInfo && matchInfo.home_team_id && matchInfo.away_team_id) {
        const homeInPhase = db.prepare(`
          SELECT 1 FROM phase_bets WHERE user_id = ? AND team_id = ? AND stage = ?
        `).get(userId, matchInfo.home_team_id, matchInfo.stage);
        const awayInPhase = db.prepare(`
          SELECT 1 FROM phase_bets WHERE user_id = ? AND team_id = ? AND stage = ?
        `).get(userId, matchInfo.away_team_id, matchInfo.stage);
        if (homeInPhase && awayInPhase) {
          points += 5;
        }
      }
    }

    total += points;
    updatePoints.run(points, bet.id);
  }

  return total;
}

function calculatePhasePoints(userId) {
  const userBets = db.prepare(`
    SELECT * FROM phase_bets WHERE user_id = ?
  `).all(userId);

  const stagePoints = {
    'round_of_32': 2,
    'round_of_16': 4,
    'quarter': 8,
    'semi': 16,
    'final': 25
  };

  let total = 0;
  const updatePoints = db.prepare('UPDATE phase_bets SET points_earned = ? WHERE id = ?');

  for (const bet of userBets) {
    const result = db.prepare(`
      SELECT * FROM phase_results WHERE team_id = ? AND stage = ?
    `).get(bet.team_id, bet.stage);

    const points = result ? (stagePoints[bet.stage] || 0) : 0;
    total += points;
    updatePoints.run(points, bet.id);
  }

  return total;
}

function calculateSpecialPoints(userId) {
  const userBets = db.prepare(`
    SELECT * FROM special_bets WHERE user_id = ?
  `).all(userId);

  const specialPoints = {
    'champion': 50,
    'runner_up': 30,
    'third_place': 20,
    'pichichi': 40,
    'mvp': 40
  };

  let total = 0;
  const updatePoints = db.prepare('UPDATE special_bets SET points_earned = ? WHERE id = ?');

  for (const bet of userBets) {
    const result = db.prepare(`
      SELECT * FROM special_results WHERE bet_type = ?
    `).get(bet.bet_type);

    if (!result) {
      updatePoints.run(0, bet.id);
      continue;
    }

    let points = 0;

    if (bet.bet_type === 'pichichi' || bet.bet_type === 'mvp') {
      if (result.player_name && bet.player_name &&
          result.player_name.toLowerCase() === bet.player_name.toLowerCase()) {
        points = specialPoints[bet.bet_type];
      }
    } else {
      if (result.team_id && bet.team_id && result.team_id === bet.team_id) {
        points = specialPoints[bet.bet_type];
      }
    }

    total += points;
    updatePoints.run(points, bet.id);
  }

  return total;
}

function getUserTotalPoints(userId) {
  const matchPts = db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM bets WHERE user_id = ?').get(userId).pts;
  const phasePts = db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM phase_bets WHERE user_id = ?').get(userId).pts;
  const specialPts = db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM special_bets WHERE user_id = ?').get(userId).pts;
  return matchPts + phasePts + specialPts;
}

function getStandings(groupId) {
  const users = db.prepare('SELECT id, username FROM users WHERE group_id = ?').all(groupId);
  const standings = users.map(u => ({
    id: u.id,
    username: u.username,
    total_points: getUserTotalPoints(u.id),
    match_points: db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM bets WHERE user_id = ?').get(u.id).pts,
    phase_points: db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM phase_bets WHERE user_id = ?').get(u.id).pts,
    special_points: db.prepare('SELECT COALESCE(SUM(points_earned), 0) as pts FROM special_bets WHERE user_id = ?').get(u.id).pts
  }));
  standings.sort((a, b) => b.total_points - a.total_points);
  return standings;
}

function createUser(username, password, groupId, isAdmin = 0) {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO users (username, password, group_id, is_admin) VALUES (?, ?, ?, ?)
  `).run(username, hash, groupId, isAdmin);
}

function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare('SELECT id, username, group_id, is_admin FROM users WHERE id = ?').get(id);
}

function createGroup(name) {
  const code = generateCode();
  db.prepare('INSERT INTO groups (name, invite_code) VALUES (?, ?)').run(name, code);
  return db.prepare('SELECT * FROM groups WHERE name = ?').get(name);
}

function getGroupByInvite(code) {
  return db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(code);
}

function getGroup(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

function updateGroupName(groupId, name) {
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, groupId);
}

function getGroupMembers(groupId) {
  return db.prepare('SELECT id, username, is_admin FROM users WHERE group_id = ?').all(groupId);
}

function getAllUsers() {
  return db.prepare('SELECT id, username, group_id, is_admin FROM users ORDER BY username').all();
}

function setUserAdmin(userId, isAdmin) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
}

function deleteUser(userId) {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM bets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM phase_bets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM special_bets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  txn();
}

function recalculateAllPoints() {
  const users = db.prepare('SELECT id FROM users').all();
  for (const user of users) {
    calculateMatchPoints(user.id);
    calculatePhasePoints(user.id);
    calculateSpecialPoints(user.id);
  }
}

// Team name aliases for Wikipedia matching
const TEAM_ALIASES = {
  'Korea Republic': 'South Korea',
  'IR Iran': 'Iran',
  'Cabo Verde': 'Cape Verde',
  "Côte d'Ivoire": 'Ivory Coast',
  'Congo DR': 'DR Congo',
  'Czechia': 'Czech Republic',
  'Türkiye': 'Turkey',
  'USA': 'EE.UU.',
  'United States': 'EE.UU.',
  'Netherlands': 'Países Bajos',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina'
};

function normalizeTeamName(name) {
  return name.replace(/<[^>]+>/g, '').replace(/[#*]/g, '').replace(/&amp;/g, '&').trim();
}

async function syncPlayersFromWikipedia() {
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&page=2026_FIFA_World_Cup_squads&format=json&prop=text&disablelimitreport=1';
  
  const response = await fetch(url);
  if (!response.ok) throw new Error('Wikipedia API error: ' + response.status);
  const data = await response.json();
  const html = data.parse.text['*'];

  // Extract team sections: h3 heading followed by a table
  const sectionPattern = /<h3[^>]*>[\s\S]*?<\/h3>[\s\S]*?<table[\s\S]*?class="sortable wikitable plainrowheaders"[\s\S]*?<\/table>/g;

  const allTeams = db.prepare('SELECT id, name FROM teams').all();

  let synced = 0;

  // Build team name map (case-insensitive)
  const teamMap = {};
  for (const t of allTeams) {
    const lower = t.name.toLowerCase().trim();
    teamMap[lower] = t.id;
    // Add reverse alias (our name -> id)
    for (const [wiki, our] of Object.entries(TEAM_ALIASES)) {
      if (our.toLowerCase() === lower) {
        teamMap[wiki.toLowerCase()] = t.id;
      }
    }
  }
  // Also add direct aliases
  for (const [wiki, our] of Object.entries(TEAM_ALIASES)) {
    teamMap[our.toLowerCase()] = teamMap[our.toLowerCase()] || teamMap[wiki.toLowerCase()];
  }

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM players').run();

    const insertPlayer = db.prepare(
      'INSERT INTO players (name, team_id, position, jersey_number) VALUES (?, ?, ?, ?)'
    );

    let sectionMatch;
    while ((sectionMatch = sectionPattern.exec(html)) !== null) {
      const sectionHtml = sectionMatch[0];

      // Extract team name from h3 tag
      const h3Match = sectionHtml.match(/<h3[^>]*>([^<]+)<\/h3>/);
      if (!h3Match) continue;
      const rawTeamName = h3Match[1].replace(/&amp;/g, '&').trim();
      let teamLower = rawTeamName.toLowerCase();

      // Find team ID by direct match, alias, or fuzzy
      let teamId = teamMap[teamLower];
      if (!teamId) {
        // Try matching via aliases more aggressively
        for (const [wiki, our] of Object.entries(TEAM_ALIASES)) {
          if (wiki.toLowerCase() === teamLower) {
            teamId = teamMap[our.toLowerCase()];
            break;
          }
        }
      }
      if (!teamId) {
        // Try direct match against DB team names (case-insensitive)
        for (const t of allTeams) {
          if (t.name.toLowerCase() === teamLower) {
            teamId = t.id;
            break;
          }
        }
      }
      if (!teamId) {
        console.log('Unknown team:', rawTeamName);
        continue;
      }

      // Parse player rows within this section's table
      const tableContent = sectionHtml.match(/<table[\s\S]*?class="sortable wikitable plainrowheaders"[\s\S]*?<\/table>/);
      if (!tableContent) continue;

      const rowPattern = /<tr class="nat-fs-player">([\s\S]*?)<\/tr>/g;
      let rowMatch;
      while ((rowMatch = rowPattern.exec(tableContent[0])) !== null) {
        const rowHtml = rowMatch[1];

        // Extract jersey number
        const numMatch = rowHtml.match(/<td[^>]*>\s*(\d+)\s*<\/td>/);
        if (!numMatch) continue;
        const number = parseInt(numMatch[1]);

        // Extract position (GK, DF, MF, FW)
        const posMatch = rowHtml.match(/(GK|DF|MF|FW)<\/a>\s*<\/td>/);
        const position = posMatch ? posMatch[1] : null;

        // Extract player name from <th> content
        const thMatch = rowHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/);
        if (!thMatch) continue;
        let playerName = thMatch[1].replace(/<[^>]+>/g, '').replace(/\s*\(.*?\)\s*/g, '').trim();

        insertPlayer.run(playerName, teamId, position, number);
        synced++;
      }
    }
  });

  txn();
  return { players: synced };
}

function getPlayers(teamId) {
  if (teamId) {
    return db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY jersey_number').all(teamId);
  }
  return db.prepare(`
    SELECT p.*, t.name as team_name, t.group_letter
    FROM players p
    JOIN teams t ON p.team_id = t.id
    ORDER BY t.group_letter, t.name, p.jersey_number
  `).all();
}

function searchPlayers(query) {
  return db.prepare(`
    SELECT p.*, t.name as team_name, t.group_letter
    FROM players p
    JOIN teams t ON p.team_id = t.id
    WHERE p.name LIKE ?
    ORDER BY t.group_letter, t.name, p.jersey_number
    LIMIT 50
  `).all(`%${query}%`);
}

initDB();

module.exports = {
  db,
  getTeams,
  getTeam,
  getMatches,
  getMatchesByGroup,
  getMatch,
  setMatchResult,
  getBets,
  saveBet,
  getUserBet,
  getPhaseBets,
  savePhaseBet,
  deletePhaseBet,
  clearPhaseBets,
  getSpecialBets,
  saveSpecialBet,
  setPhaseResult,
  getPhaseResults,
  clearPhaseResults,
  setSpecialResult,
  getSpecialResults,
  calculateMatchPoints,
  calculatePhasePoints,
  calculateSpecialPoints,
  getStandings,
  createUser,
  getUser,
  getUserById,
  createGroup,
  getGroupByInvite,
  getGroup,
  getGroupMembers,
  updateGroupName,
  getAllUsers,
  setUserAdmin,
  deleteUser,
  recalculateAllPoints,
  createMatch,
  syncFixturesFromApi,
  initData,
  syncPlayersFromWikipedia,
  getPlayers,
  searchPlayers
};
