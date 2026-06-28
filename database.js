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
      profile_photo TEXT DEFAULT NULL,
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
      status TEXT DEFAULT 'scheduled',
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

    CREATE TABLE IF NOT EXISTS phase_deadlines (
      stage TEXT PRIMARY KEY,
      deadline DATETIME,
      duration_seconds INTEGER DEFAULT 1800,
      active INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      team_id INTEGER NOT NULL,
      position TEXT,
      jersey_number INTEGER,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );

    CREATE INDEX IF NOT EXISTS idx_matches_stage ON matches(stage);
    CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);
    CREATE INDEX IF NOT EXISTS idx_matches_group ON matches(group_letter);
    CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
    CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id);
    CREATE INDEX IF NOT EXISTS idx_users_group ON users(group_id);
    CREATE INDEX IF NOT EXISTS idx_phase_bets_user ON phase_bets(user_id);
    CREATE INDEX IF NOT EXISTS idx_special_bets_user ON special_bets(user_id);
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_matches_played_integrity
    BEFORE UPDATE OF played ON matches
    FOR EACH ROW
    WHEN NEW.played = 1 AND (NEW.home_score IS NULL OR NEW.away_score IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'No se puede marcar played=1 con home_score o away_score NULL');
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_matches_future_date
    BEFORE UPDATE OF played, match_date ON matches
    FOR EACH ROW
    WHEN NEW.played = 1 AND NEW.match_date IS NOT NULL
      AND datetime(NEW.match_date, '+5 minutes') > datetime('now')
    BEGIN
      SELECT RAISE(ABORT, 'No se puede marcar played=1 con match_date en el futuro');
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_matches_future_date_insert
    BEFORE INSERT ON matches
    FOR EACH ROW
    WHEN NEW.played = 1 AND NEW.match_date IS NOT NULL
      AND datetime(NEW.match_date, '+5 minutes') > datetime('now')
    BEGIN
      SELECT RAISE(ABORT, 'No se puede insertar partido con played=1 y match_date en el futuro');
    END;
  `);

  // Migration: add status column if missing
  const hasStatus = db.prepare("PRAGMA table_info(matches)").all().some(c => c.name === 'status');
  if (!hasStatus) {
    db.exec("ALTER TABLE matches ADD COLUMN status TEXT DEFAULT 'scheduled'");
    console.log('📦 Migración: columna status agregada a matches');
  }

  // Migration: add penalty_winner_id to bets
  const hasPenalty = db.prepare("PRAGMA table_info(bets)").all().some(c => c.name === 'penalty_winner_id');
  if (!hasPenalty) {
    db.exec("ALTER TABLE bets ADD COLUMN penalty_winner_id INTEGER DEFAULT NULL REFERENCES teams(id)");
    console.log('📦 Migración: columna penalty_winner_id agregada a bets');
  }

  // Migration: migrate phase_deadlines from duration_minutes to duration_seconds
  const hasDurationSec = db.prepare("PRAGMA table_info(phase_deadlines)").all().some(c => c.name === 'duration_seconds');
  if (!hasDurationSec) {
    db.exec("ALTER TABLE phase_deadlines ADD COLUMN duration_seconds INTEGER DEFAULT 1800");
    db.exec("UPDATE phase_deadlines SET duration_seconds = duration_minutes * 60 WHERE duration_minutes IS NOT NULL");
    console.log('📦 Migración: columna duration_seconds agregada a phase_deadlines');
  }

  const groupCount = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  if (groupCount.count === 0) {
    const code = generateCode();
    db.prepare('INSERT INTO groups (name, invite_code) VALUES (?, ?)').run('Grupo General', code);
  }
}

const TEAM_NAME_ES = {
  'Mexico': 'México',
  'South Africa': 'Sudáfrica',
  'South Korea': 'Corea del Sur',
  'Korea Republic': 'Corea del Sur',
  'Korea DPR': 'Corea del Norte',
  'Czech Republic': 'República Checa',
  'Czechia': 'República Checa',
  'Canada': 'Canadá',
  'Bosnia & Herzegovina': 'Bosnia y Herzegovina',
  'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Bosnia-Herzegovina': 'Bosnia y Herzegovina',
  'Qatar': 'Catar',
  'Switzerland': 'Suiza',
  'Brazil': 'Brasil',
  'Morocco': 'Marruecos',
  'Haiti': 'Haití',
  'Scotland': 'Escocia',
  'USA': 'EE.UU.',
  'United States': 'EE.UU.',
  'US': 'EE.UU.',
  'Paraguay': 'Paraguay',
  'Australia': 'Australia',
  'Turkey': 'Turquía',
  'Türkiye': 'Turquía',
  'Turkiye': 'Turquía',
  'Germany': 'Alemania',
  'Curaçao': 'Curazao',
  'Curacao': 'Curazao',
  'Ivory Coast': 'Costa de Marfil',
  "Côte d'Ivoire": 'Costa de Marfil',
  'Cote dIvoire': 'Costa de Marfil',
  'Ecuador': 'Ecuador',
  'Netherlands': 'Países Bajos',
  'Holland': 'Países Bajos',
  'The Netherlands': 'Países Bajos',
  'Japan': 'Japón',
  'Sweden': 'Suecia',
  'Tunisia': 'Túnez',
  'Belgium': 'Bélgica',
  'Egypt': 'Egipto',
  'IR Iran': 'Irán',
  'Iran': 'Irán',
  'New Zealand': 'Nueva Zelanda',
  'Spain': 'España',
  'Cape Verde': 'Cabo Verde',
  'Cabo Verde': 'Cabo Verde',
  'Saudi Arabia': 'Arabia Saudí',
  'Uruguay': 'Uruguay',
  'France': 'Francia',
  'Senegal': 'Senegal',
  'Iraq': 'Irak',
  'Norway': 'Noruega',
  'Argentina': 'Argentina',
  'Algeria': 'Argelia',
  'Austria': 'Austria',
  'Jordan': 'Jordania',
  'Portugal': 'Portugal',
  'DR Congo': 'RD del Congo',
  'Congo DR': 'RD del Congo',
  'Democratic Republic of the Congo': 'RD del Congo',
  'Uzbekistan': 'Uzbekistán',
  'Colombia': 'Colombia',
  'England': 'Inglaterra',
  'Croatia': 'Croacia',
  'Ghana': 'Ghana',
  'Panama': 'Panamá',
  'Albania': 'Albania',
  'Algeria': 'Argelia',
  'Angola': 'Angola',
  'Cameroon': 'Camerún',
  'Chile': 'Chile',
  'China': 'China',
  'China PR': 'China',
  'Costa Rica': 'Costa Rica',
  'Denmark': 'Dinamarca',
  'Finland': 'Finlandia',
  'Gabon': 'Gabón',
  'Greece': 'Grecia',
  'Hungary': 'Hungría',
  'Iceland': 'Islandia',
  'India': 'India',
  'Indonesia': 'Indonesia',
  'Ireland': 'Irlanda',
  'Republic of Ireland': 'Irlanda',
  'Israel': 'Israel',
  'Italy': 'Italia',
  'Ivory Coast': 'Costa de Marfil',
  'Jamaica': 'Jamaica',
  'Kenya': 'Kenia',
  'Kuwait': 'Kuwait',
  'Malaysia': 'Malasia',
  'Mali': 'Malí',
  'Mexico': 'México',
  'Morocco': 'Marruecos',
  'Netherlands': 'Países Bajos',
  'New Zealand': 'Nueva Zelanda',
  'Nigeria': 'Nigeria',
  'North Korea': 'Corea del Norte',
  'Northern Ireland': 'Irlanda del Norte',
  'Oman': 'Omán',
  'Pakistan': 'Pakistán',
  'Peru': 'Perú',
  'Poland': 'Polonia',
  'Qatar': 'Catar',
  'Romania': 'Rumanía',
  'Russia': 'Rusia',
  'Saudi Arabia': 'Arabia Saudí',
  'Scotland': 'Escocia',
  'Serbia': 'Serbia',
  'Slovakia': 'Eslovaquia',
  'Slovenia': 'Eslovenia',
  'South Africa': 'Sudáfrica',
  'South Korea': 'Corea del Sur',
  'Spain': 'España',
  'Sweden': 'Suecia',
  'Switzerland': 'Suiza',
  'Syria': 'Siria',
  'Thailand': 'Tailandia',
  'Tunisia': 'Túnez',
  'Turkey': 'Turquía',
  'Ukraine': 'Ucrania',
  'United Arab Emirates': 'Emiratos Árabes Unidos',
  'UAE': 'Emiratos Árabes Unidos',
  'United States': 'EE.UU.',
  'USA': 'EE.UU.',
  'Uruguay': 'Uruguay',
  'Venezuela': 'Venezuela',
  'Vietnam': 'Vietnam',
  'Wales': 'Gales',
  'Bosnia-Herzegovina': 'Bosnia y Herzegovina',
};

function translateTeamName(name) {
  return TEAM_NAME_ES[name] || name;
}

async function syncFixturesFromApi() {
  const url = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

  const response = await fetch(url);
  if (!response.ok) throw new Error('Error API: ' + response.status);
  const data = await response.json();

  const matches = data.matches || [];
  const groupMatches = matches.filter(m => m.group && m.group.startsWith('Group'));
  const knockoutMatches = matches.filter(m => !m.group || !m.group.startsWith('Group'));

  const teamsByGroup = {};
  for (const m of groupMatches) {
    const letter = m.group.replace('Group ', '');
    if (!teamsByGroup[letter]) teamsByGroup[letter] = new Set();
    teamsByGroup[letter].add(m.team1);
    teamsByGroup[letter].add(m.team2);
  }

  const knockoutTeams = new Set();
  for (const m of knockoutMatches) {
    if (m.team1) knockoutTeams.add(m.team1);
    if (m.team2) knockoutTeams.add(m.team2);
  }

  let stats = { teams: 0, matches: 0, knockoutMatches: 0 };

  const nameMap = {};
  for (const eng of Object.keys(TEAM_NAME_ES)) {
    nameMap[eng] = TEAM_NAME_ES[eng];
  }

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
        const esName = nameMap[name] || name;
        insertTeam.run(esName, group);
        stats.teams++;
      }
    }

    for (const name of knockoutTeams) {
      const esName = nameMap[name] || name;
      const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(esName);
      if (!existing) {
        insertTeam.run(esName, null);
        stats.teams++;
      }
    }

    const getTeamId = db.prepare('SELECT id FROM teams WHERE name = ?');
    const insertMatch = db.prepare(
      'INSERT INTO matches (home_team_id, away_team_id, stage, group_letter, match_date, home_score, away_score, played) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );

    for (const m of groupMatches) {
      const homeName = nameMap[m.team1] || m.team1;
      const awayName = nameMap[m.team2] || m.team2;
      const home = getTeamId.get(homeName);
      const away = getTeamId.get(awayName);
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
      const isValidScore = score[0] !== null && score[1] !== null
        && Number.isFinite(score[0]) && Number.isFinite(score[1])
        && score[0] >= 0 && score[1] >= 0;
      const played = isValidScore ? 1 : 0;
      const finalScore = isValidScore ? score : [null, null];

      insertMatch.run(home.id, away.id, 'group', letter, dateStr, finalScore[0], finalScore[1], played);
      stats.matches++;
    }

    for (const m of knockoutMatches) {
      if (!m.team1 || !m.team2) continue;
      const homeName = nameMap[m.team1] || m.team1;
      const awayName = nameMap[m.team2] || m.team2;
      const home = getTeamId.get(homeName);
      const away = getTeamId.get(awayName);
      if (!home || !away) continue;

      let stage = 'round_of_32';
      if (m.group) {
        const g = m.group.toLowerCase();
        if (g.includes('round of 32') || g.includes('r32')) stage = 'round_of_32';
        else if (g.includes('round of 16') || g.includes('r16')) stage = 'round_of_16';
        else if (g.includes('quarter')) stage = 'quarter';
        else if (g.includes('semi')) stage = 'semi';
        else if (g.includes('third') || g.includes('3rd')) stage = 'third_place';
        else if (g.includes('final')) stage = 'final';
      }

      let dateStr = m.date;
      if (m.time) {
        const parts = m.time.match(/^(\d{2}:\d{2})\s*UTC([+-]\d+)/);
        if (parts) {
          const [_, time, offset] = parts;
          const [h, min] = time.split(':').map(Number);
          const off = parseInt(offset);
          const day = parseInt(m.date.split('-')[2]);
          const utcDate = new Date(Date.UTC(2026, 5, day, h - off, min));
          dateStr = utcDate.toISOString();
        } else {
          dateStr = `${m.date}T${m.time.split(' ')[0]}:00`;
        }
      }
      const score = m.score || [null, null];
      const isValidScore = score[0] !== null && score[1] !== null
        && Number.isFinite(score[0]) && Number.isFinite(score[1])
        && score[0] >= 0 && score[1] >= 0;
      const played = isValidScore ? 1 : 0;
      const finalScore = isValidScore ? score : [null, null];

      insertMatch.run(home.id, away.id, stage, null, dateStr, finalScore[0], finalScore[1], played);
      stats.knockoutMatches++;
    }
  });

  txn();
  return stats;
}

async function syncMatchResults() {
  const url = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

  const response = await fetch(url);
  if (!response.ok) throw new Error('Error API: ' + response.status);
  const data = await response.json();

  const matches = data.matches || [];
  const groupMatches = matches.filter(m => m.group && m.group.startsWith('Group'));
  const knockoutMatches = matches.filter(m => !m.group || !m.group.startsWith('Group'));

  let updated = 0;

  const getTeamByName = db.prepare('SELECT id FROM teams WHERE name = ?');

  for (const m of groupMatches) {
    const homeName = translateTeamName(m.team1);
    const awayName = translateTeamName(m.team2);
    const home = getTeamByName.get(homeName);
    const away = getTeamByName.get(awayName);
    if (!home || !away) continue;

    const letter = m.group.replace('Group ', '');
    const score = m.score || [null, null];
    const isValidScore = score[0] !== null && score[1] !== null
      && Number.isFinite(score[0]) && Number.isFinite(score[1])
      && score[0] >= 0 && score[1] >= 0;
    const played = isValidScore ? 1 : 0;
    const finalScore = isValidScore ? score : [null, null];

    const existing = db.prepare(`
      SELECT id, home_score, away_score FROM matches
      WHERE home_team_id = ? AND away_team_id = ? AND group_letter = ? AND stage = 'group'
    `).get(home.id, away.id, letter);

    if (!existing) continue;
    if (existing.home_score === finalScore[0] && existing.away_score === finalScore[1]) continue;

    db.prepare('UPDATE matches SET home_score = ?, away_score = ?, played = ? WHERE id = ?')
      .run(finalScore[0], finalScore[1], played, existing.id);
    updated++;
  }

  for (const m of knockoutMatches) {
    if (!m.team1 || !m.team2) continue;
    const homeName = translateTeamName(m.team1);
    const awayName = translateTeamName(m.team2);
    const home = getTeamByName.get(homeName);
    const away = getTeamByName.get(awayName);
    if (!home || !away) continue;

    let stage = 'round_of_32';
    if (m.group) {
      const g = m.group.toLowerCase();
      if (g.includes('round of 32') || g.includes('r32')) stage = 'round_of_32';
      else if (g.includes('round of 16') || g.includes('r16')) stage = 'round_of_16';
      else if (g.includes('quarter')) stage = 'quarter';
      else if (g.includes('semi')) stage = 'semi';
      else if (g.includes('third') || g.includes('3rd')) stage = 'third_place';
      else if (g.includes('final')) stage = 'final';
    }

    const score = m.score || [null, null];
    const isValidScore = score[0] !== null && score[1] !== null
      && Number.isFinite(score[0]) && Number.isFinite(score[1])
      && score[0] >= 0 && score[1] >= 0;
    const played = isValidScore ? 1 : 0;
    const finalScore = isValidScore ? score : [null, null];

    const existing = db.prepare(`
      SELECT id, home_score, away_score FROM matches
      WHERE home_team_id = ? AND away_team_id = ? AND stage = ?
    `).get(home.id, away.id, stage);

    if (!existing) continue;
    if (existing.home_score === finalScore[0] && existing.away_score === finalScore[1]) continue;

    db.prepare('UPDATE matches SET home_score = ?, away_score = ?, played = ? WHERE id = ?')
      .run(finalScore[0], finalScore[1], played, existing.id);
    updated++;
  }

  return { updated };
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
    ['México', 'A'], ['Sudáfrica', 'A'], ['Corea del Sur', 'A'], ['República Checa', 'A'],
    ['Canadá', 'B'], ['Bosnia y Herzegovina', 'B'], ['Catar', 'B'], ['Suiza', 'B'],
    ['Brasil', 'C'], ['Marruecos', 'C'], ['Haití', 'C'], ['Escocia', 'C'],
    ['EE.UU.', 'D'], ['Paraguay', 'D'], ['Australia', 'D'], ['Turquía', 'D'],
    ['Alemania', 'E'], ['Curazao', 'E'], ['Costa de Marfil', 'E'], ['Ecuador', 'E'],
    ['Países Bajos', 'F'], ['Japón', 'F'], ['Suecia', 'F'], ['Túnez', 'F'],
    ['Bélgica', 'G'], ['Egipto', 'G'], ['Irán', 'G'], ['Nueva Zelanda', 'G'],
    ['España', 'H'], ['Cabo Verde', 'H'], ['Arabia Saudí', 'H'], ['Uruguay', 'H'],
    ['Francia', 'I'], ['Senegal', 'I'], ['Irak', 'I'], ['Noruega', 'I'],
    ['Argentina', 'J'], ['Argelia', 'J'], ['Austria', 'J'], ['Jordania', 'J'],
    ['Portugal', 'K'], ['RD del Congo', 'K'], ['Uzbekistán', 'K'], ['Colombia', 'K'],
    ['Inglaterra', 'L'], ['Croacia', 'L'], ['Ghana', 'L'], ['Panamá', 'L']
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

function getMatchesInWindow() {
  return db.prepare(`
    SELECT m.id, m.home_team_id, m.away_team_id, m.match_date,
           h.name as home_team, a.name as away_team, m.group_letter, m.stage
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE m.played = 0
      AND m.match_date IS NOT NULL
      AND datetime(m.match_date) <= datetime('now', '+15 minutes')
      AND datetime(m.match_date, '+2.5 hours') >= datetime('now')
  `).all();
}

function setMatchResult(id, homeScore, awayScore) {
  const h = Number(homeScore);
  const a = Number(awayScore);
  if (!Number.isFinite(h) || !Number.isFinite(a)) {
    throw new Error('Resultados inválidos: deben ser números');
  }
  if (h < 0 || a < 0) {
    throw new Error('Resultados inválidos: no pueden ser negativos');
  }
  const match = db.prepare('SELECT match_date FROM matches WHERE id = ?').get(id);
  if (match && match.match_date) {
    const matchTime = new Date(match.match_date).getTime();
    const now = Date.now();
    if (matchTime - now > 5 * 60 * 1000) {
      throw new Error('No se puede marcar como finalizado un partido que aún no se ha jugado');
    }
  }
  db.prepare(`
    UPDATE matches SET home_score = ?, away_score = ?, played = 1 WHERE id = ?
  `).run(h, a, id);
}

function createMatch(homeTeamId, awayTeamId, stage, groupLetter, matchDate) {
  const result = db.prepare(`
    INSERT INTO matches (home_team_id, away_team_id, stage, group_letter, match_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(homeTeamId, awayTeamId, stage, groupLetter || null, matchDate || null);
  return result.lastInsertRowid;
}

function updateMatch(matchId, homeTeamId, awayTeamId, matchDate, stage) {
  const match = db.prepare('SELECT id, played FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Partido no encontrado');
  const sets = [];
  const params = [];
  if (homeTeamId != null) { sets.push('home_team_id = ?'); params.push(homeTeamId); }
  if (awayTeamId != null) { sets.push('away_team_id = ?'); params.push(awayTeamId); }
  if (stage != null) { sets.push('stage = ?'); params.push(stage); }
  if (matchDate !== undefined) { sets.push('match_date = ?'); params.push(matchDate || null); }
  if (sets.length === 0) throw new Error('Sin cambios');
  params.push(matchId);
  db.prepare(`UPDATE matches SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function deleteMatch(matchId) {
  const match = db.prepare('SELECT id, played FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Partido no encontrado');
  if (match.played) throw new Error('No se puede eliminar un partido ya jugado');
  db.prepare('DELETE FROM bets WHERE match_id = ?').run(matchId);
  db.prepare('DELETE FROM matches WHERE id = ?').run(matchId);
}

function updateMatchStatus(matchId, status, scores = null) {
  if (scores && Number.isFinite(scores.home) && Number.isFinite(scores.away)) {
    db.prepare('UPDATE matches SET status = ?, home_score = ?, away_score = ? WHERE id = ?')
      .run(status, scores.home, scores.away, matchId);
  } else {
    db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, matchId);
  }
}

function resetMatchStatus(matchId) {
  db.prepare("UPDATE matches SET status = 'scheduled', home_score = NULL, away_score = NULL, played = 0 WHERE id = ?").run(matchId);
}

// Bets
function getBets(userId) {
  return db.prepare(`
    SELECT b.*, b.penalty_winner_id,
           m.home_team_id, m.away_team_id, m.stage, m.group_letter, m.played,
           m.home_score as actual_home, m.away_score as actual_away,
           m.status as match_status, m.match_date,
           h.name as home_team, a.name as away_team
    FROM bets b
    JOIN matches m ON b.match_id = m.id
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE b.user_id = ?
  `).all(userId);
}

function saveBet(userId, matchId, homeScore, awayScore, penaltyWinnerId) {
  const pw = penaltyWinnerId != null ? parseInt(penaltyWinnerId) : null;
  db.prepare(`
    INSERT INTO bets (user_id, match_id, home_score, away_score, penalty_winner_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, match_id)
    DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score,
                  penalty_winner_id = excluded.penalty_winner_id, points_earned = 0
  `).run(userId, matchId, homeScore, awayScore, pw);
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

function getConfig(key) {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getPhaseDeadlines() {
  return db.prepare('SELECT * FROM phase_deadlines ORDER BY stage').all();
}

function getPhaseDeadline(stage) {
  return db.prepare('SELECT * FROM phase_deadlines WHERE stage = ?').get(stage);
}

function setPhaseDeadline(stage, durationSeconds) {
  db.prepare(`
    INSERT INTO phase_deadlines (stage, duration_seconds, deadline, active)
    VALUES (?, ?, NULL, 0)
    ON CONFLICT(stage)
    DO UPDATE SET duration_seconds = excluded.duration_seconds
  `).run(stage, durationSeconds);
}

function activatePhaseDeadline(stage) {
  const row = db.prepare('SELECT * FROM phase_deadlines WHERE stage = ?').get(stage);
  if (!row) return null;
  const deadline = new Date(Date.now() + row.duration_seconds * 1000).toISOString();
  db.prepare('UPDATE phase_deadlines SET deadline = ?, active = 1 WHERE stage = ?').run(deadline, stage);
  return { stage, deadline, duration_seconds: row.duration_seconds, active: 1 };
}

function deactivatePhaseDeadline(stage) {
  db.prepare('UPDATE phase_deadlines SET active = 0, deadline = NULL WHERE stage = ?').run(stage);
}

function isPhaseEditingAllowed(stage) {
  const row = db.prepare('SELECT * FROM phase_deadlines WHERE stage = ? AND active = 1').get(stage);
  if (!row || !row.deadline) return false;
  return Date.now() < new Date(row.deadline).getTime();
}

function getUserBet(userId, matchId) {
  return db.prepare(`
    SELECT b.*, b.penalty_winner_id,
           m.home_score as actual_home, m.away_score as actual_away, m.played,
           h.name as home_team, a.name as away_team
    FROM bets b
    JOIN matches m ON b.match_id = m.id
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_score = a.id
    WHERE b.user_id = ? AND b.match_id = ?
  `).get(userId, matchId);
}

function getMatchBetsByGroup(matchId, groupId) {
  return db.prepare(`
    SELECT u.id as user_id, u.username, u.profile_photo,
           b.home_score, b.away_score, b.penalty_winner_id, b.points_earned
    FROM users u
    LEFT JOIN bets b ON u.id = b.user_id AND b.match_id = ?
    WHERE u.group_id = ?
    ORDER BY u.username
  `).all(matchId, groupId);
}

// Phase bets
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
  // Zero out points for bets on matches that are no longer played
  db.prepare(`
    UPDATE bets SET points_earned = 0
    WHERE user_id = ? AND match_id IN (
      SELECT id FROM matches WHERE played = 0
    )
  `).run(userId);

  const userBets = db.prepare(`
    SELECT b.*, m.home_score as actual_home, m.away_score as actual_away,
           m.home_team_id, m.away_team_id, m.played, m.stage
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
    let predictWinner = predictHome > predictAway ? 'home' : (predictAway > predictHome ? 'away' : 'draw');
    let actualWinner = actualHome > actualAway ? 'home' : (actualAway > actualHome ? 'away' : 'draw');

    // If the user predicted a draw but selected a penalty winner, use that as their prediction
    if (predictWinner === 'draw' && bet.penalty_winner_id) {
      predictWinner = bet.penalty_winner_id === bet.home_team_id ? 'home' : 'away';
    }
    // If the match ended in a draw and user selected a penalty winner, use that as actual
    if (actualWinner === 'draw' && bet.penalty_winner_id) {
      actualWinner = bet.penalty_winner_id === bet.home_team_id ? 'home' : 'away';
    }

    if (exactRight) {
      points = isGroup ? 10 : 15;
    } else if (predictWinner === actualWinner) {
      if (predictWinner === 'draw') {
        points = isGroup ? 5 : 3;
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
    'quarter': 6,
    'semi': 10,
    'final': 15
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

function autoFillPhaseResults() {
  const placeholderTeamId = db.prepare("SELECT id FROM teams WHERE name = 'Por definir'").get()?.id;
  const stages = ['round_of_32', 'round_of_16', 'quarter', 'semi', 'third_place', 'final'];
  for (const stage of stages) {
    let teams = db.prepare(`
      SELECT DISTINCT home_team_id as team_id FROM matches WHERE stage = ?
      UNION
      SELECT DISTINCT away_team_id FROM matches WHERE stage = ?
    `).all(stage, stage);
    if (placeholderTeamId) teams = teams.filter(t => t.team_id !== placeholderTeamId);
    if (teams.length === 0) continue;
    db.prepare('DELETE FROM phase_results WHERE stage = ?').run(stage);
    const ins = db.prepare('INSERT OR IGNORE INTO phase_results (team_id, stage) VALUES (?, ?)');
    const txn = db.transaction(() => { for (const row of teams) ins.run(row.team_id, stage); });
    txn();
  }
  recalculateAllPoints();
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
  const users = db.prepare('SELECT id, username, profile_photo FROM users WHERE group_id = ?').all(groupId);
  const standings = users.map(u => ({
    id: u.id,
    username: u.username,
    profile_photo: u.profile_photo || null,
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
  return db.prepare('SELECT id, username, group_id, is_admin, profile_photo FROM users WHERE id = ?').get(id);
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
  'Korea Republic': 'Corea del Sur',
  'South Korea': 'Corea del Sur',
  'IR Iran': 'Irán',
  'Iran': 'Irán',
  'Cabo Verde': 'Cabo Verde',
  'Cape Verde': 'Cabo Verde',
  "Côte d'Ivoire": 'Costa de Marfil',
  'Ivory Coast': 'Costa de Marfil',
  'Congo DR': 'RD del Congo',
  'DR Congo': 'RD del Congo',
  'Czechia': 'República Checa',
  'Czech Republic': 'República Checa',
  'Türkiye': 'Turquía',
  'Turkey': 'Turquía',
  'USA': 'EE.UU.',
  'United States': 'EE.UU.',
  'Netherlands': 'Países Bajos',
  'Países Bajos': 'Países Bajos',
  'Bosnia & Herzegovina': 'Bosnia y Herzegovina',
  'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Curacao': 'Curazao',
  'Curaçao': 'Curazao',
  'Mexico': 'México',
  'South Africa': 'Sudáfrica',
  'Canada': 'Canadá',
  'Qatar': 'Catar',
  'Switzerland': 'Suiza',
  'Brazil': 'Brasil',
  'Morocco': 'Marruecos',
  'Haiti': 'Haití',
  'Scotland': 'Escocia',
  'Paraguay': 'Paraguay',
  'Australia': 'Australia',
  'Germany': 'Alemania',
  'Ecuador': 'Ecuador',
  'Japan': 'Japón',
  'Sweden': 'Suecia',
  'Tunisia': 'Túnez',
  'Belgium': 'Bélgica',
  'Egypt': 'Egipto',
  'New Zealand': 'Nueva Zelanda',
  'Spain': 'España',
  'Saudi Arabia': 'Arabia Saudí',
  'Uruguay': 'Uruguay',
  'France': 'Francia',
  'Senegal': 'Senegal',
  'Iraq': 'Irak',
  'Norway': 'Noruega',
  'Argentina': 'Argentina',
  'Algeria': 'Argelia',
  'Austria': 'Austria',
  'Jordan': 'Jordania',
  'Portugal': 'Portugal',
  'Uzbekistan': 'Uzbekistán',
  'Colombia': 'Colombia',
  'England': 'Inglaterra',
  'Croatia': 'Croacia',
  'Ghana': 'Ghana',
  'Panama': 'Panamá',
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
      const h3Match = sectionHtml.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      if (!h3Match) continue;
      const rawTeamName = h3Match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
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
  getMatchesInWindow,
  setMatchResult,
  getBets,
  saveBet,
  getUserBet,
  getMatchBetsByGroup,
  getSpecialBets,
  saveSpecialBet,
  setSpecialResult,
  getSpecialResults,
  getPhaseBets,
  savePhaseBet,
  deletePhaseBet,
  clearPhaseBets,
  getPhaseResults,
  clearPhaseResults,
  calculateMatchPoints,
  calculatePhasePoints,
  autoFillPhaseResults,
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
  updateMatch,
  deleteMatch,
  updateMatchStatus,
  resetMatchStatus,
  syncFixturesFromApi,
  syncMatchResults,
  initData,
  syncPlayersFromWikipedia,
  getPlayers,
  searchPlayers,
  verifyMatchIntegrity,
  autoRepairMatches,
  getConfig,
  setConfig,
  getPhaseDeadlines,
  getPhaseDeadline,
  setPhaseDeadline,
  activatePhaseDeadline,
  deactivatePhaseDeadline,
  isPhaseEditingAllowed
};

function verifyMatchIntegrity() {
  const issues = db.prepare(`
    SELECT id, home_score, away_score, played, match_date, 'null_scores' as reason
    FROM matches
    WHERE played = 1 AND (home_score IS NULL OR away_score IS NULL)
    UNION ALL
    SELECT id, home_score, away_score, played, match_date, 'future_date' as reason
    FROM matches
    WHERE played = 1 AND match_date IS NOT NULL
      AND datetime(match_date, '+5 minutes') > datetime('now')
  `).all();
  return issues;
}

function autoRepairMatches() {
  const issues = verifyMatchIntegrity();
  const futurePlayed = db.prepare(`
    SELECT id, home_score, away_score, played, match_date, status
    FROM matches
    WHERE played = 1 AND match_date IS NOT NULL
      AND datetime(match_date, '+5 minutes') > datetime('now')
  `).all();

  let repairedCount = 0;
  const stmt = db.prepare('UPDATE matches SET played = 0, home_score = NULL, away_score = NULL, status = ? WHERE id = ?');

  if (issues.length === 0 && futurePlayed.length === 0) return { repaired: 0 };

  for (const m of issues) {
    const resetStatus = (m.status === 'suspended' || m.status === 'postponed' || m.status === 'delayed') ? m.status : 'scheduled';
    stmt.run(resetStatus, m.id);
    console.log(`🔧 Auto-reparado: partido ${m.id} marcado played=0 (scores: ${m.home_score}-${m.away_score}, status: ${resetStatus})`);
    repairedCount++;
  }
  for (const m of futurePlayed) {
    const resetStatus = (m.status === 'suspended' || m.status === 'postponed' || m.status === 'delayed') ? m.status : 'scheduled';
    stmt.run(resetStatus, m.id);
    console.log(`🔧 Auto-reparado: partido ${m.id} marcado played=0 (fecha futura: ${m.match_date}, status: ${resetStatus})`);
    repairedCount++;
  }
  return { repaired: repairedCount };
}
