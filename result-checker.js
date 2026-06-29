const OPENFOOTBALL_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const THESPORTSDB_URL = 'https://www.thesportsdb.com/api/v1/json/3';
const FOOTBALL_DATA_URL = 'https://api.football-data.org/v4';
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || '';

let currentPollingInterval = null;
let currentDbModule = null;
let eventListeners = [];
let lastCheck = 0;
let checkStats = { checked: 0, updated: 0, lastRun: null, source: 'openfootball' };

const POLL_INTERVAL_ACTIVE = 2 * 60 * 1000;
const POLL_INTERVAL_NORMAL = 5 * 60 * 1000;
const POLL_INTERVAL_IDLE = 15 * 60 * 1000;
const MIN_MATCH_AGE = 75 * 60 * 1000;
const ACTIVE_WINDOW_HOURS = 6;

let hasActiveMatchWindow = false;

function onResultUpdate(callback) {
  eventListeners.push(callback);
  return () => {
    eventListeners = eventListeners.filter(cb => cb !== callback);
  };
}

function emitResultUpdate(data) {
  eventListeners.forEach(cb => {
    try { cb(data); } catch (e) { console.error('Result update callback error:', e); }
  });
}

async function fetchFromOpenfootball() {
  const cacheBuster = `?_t=${Date.now()}`;
  const response = await fetch(OPENFOOTBALL_URL + cacheBuster, {
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  });
  if (!response.ok) throw new Error(`openfootball HTTP ${response.status}`);
  const data = await response.json();
  return parseOpenfootballResults(data);
}

async function fetchFromTheSportsDB() {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const results = {};
  for (const date of [yesterday, today, tomorrow]) {
    try {
      const response = await fetch(`${THESPORTSDB_URL}/eventsday.php?d=${date}&s=Soccer`);
      if (!response.ok) continue;
      const data = await response.json();
      for (const ev of (data.events || [])) {
        if (!ev.strLeague?.includes('World Cup')) continue;
        if (!ev.intHomeScore || !ev.intAwayScore) continue;
        const homeScore = parseInt(ev.intHomeScore);
        const awayScore = parseInt(ev.intAwayScore);
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
        const key = `${ev.strHomeTeam}|${ev.strAwayTeam}`;
        results[key] = {
          homeScore,
          awayScore,
          homeTeam: ev.strHomeTeam,
          awayTeam: ev.strAwayTeam,
        };
      }
    } catch (e) { /* continue */ }
  }
  return results;
}

async function fetchFromFootballDataOrg() {
  if (!FOOTBALL_DATA_TOKEN) return null;
  try {
    const wcId = await getWorldCupCompetitionId();
    if (!wcId) return null;

    const response = await fetch(`${FOOTBALL_DATA_URL}/competitions/${wcId}/matches?status=FINISHED`, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const results = {};
    for (const m of (data.matches || [])) {
      const key = `${m.homeTeam.name}|${m.awayTeam.name}`;
      results[key] = {
        homeScore: m.score.fullTime.home,
        awayScore: m.score.fullTime.away,
        homeTeam: m.homeTeam.name,
        awayTeam: m.awayTeam.name,
      };
    }
    return results;
  } catch (e) {
    return null;
  }
}

async function getWorldCupCompetitionId() {
  try {
    const response = await fetch(`${FOOTBALL_DATA_URL}/competitions`, {
      headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const wc = (data.competitions || []).find(c => c.code === 'WC');
    return wc ? wc.id : null;
  } catch (e) {
    return null;
  }
}

function parseOpenfootballResults(data) {
  const results = {};
  const matches = data.matches || [];
  const groupMatches = matches.filter(m => m.group && m.group.startsWith('Group'));
  const knockoutMatches = matches.filter(m => !m.group || !m.group.startsWith('Group'));

  for (const m of groupMatches) {
    const score = m.score || [null, null];
    if (score[0] === null || score[1] === null) continue;
    if (!Number.isFinite(score[0]) || !Number.isFinite(score[1])) continue;
    if (score[0] < 0 || score[1] < 0) continue;

    const homeName = translateTeamName(m.team1);
    const awayName = translateTeamName(m.team2);
    const letter = m.group.replace('Group ', '');

    const key = `${homeName}|${awayName}|${letter}`;
    results[key] = {
      homeScore: score[0],
      awayScore: score[1],
      homeTeam: homeName,
      awayTeam: awayName,
      groupLetter: letter,
      stage: 'group',
    };
  }

  for (const m of knockoutMatches) {
    if (!m.team1 || !m.team2) continue;
    const score = m.score || [null, null];
    if (score[0] === null || score[1] === null) continue;
    if (!Number.isFinite(score[0]) || !Number.isFinite(score[1])) continue;
    if (score[0] < 0 || score[1] < 0) continue;

    const homeName = translateTeamName(m.team1);
    const awayName = translateTeamName(m.team2);

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

    const key = `${homeName}|${awayName}|${stage}`;
    results[key] = {
      homeScore: score[0],
      awayScore: score[1],
      homeTeam: homeName,
      awayTeam: awayName,
      stage: stage,
    };
  }
  return results;
}

async function fetchAllResults() {
  const sources = [
    { name: 'openfootball', fn: fetchFromOpenfootball },
    { name: 'football-data.org', fn: fetchFromFootballDataOrg },
    { name: 'thesportsdb', fn: fetchFromTheSportsDB },
  ];

  for (const source of sources) {
    try {
      const results = await source.fn();
      if (results !== null && results !== undefined) {
        checkStats.source = source.name;
        return { results, source: source.name };
      }
    } catch (e) {
      console.log(`Source ${source.name} failed: ${e.message}`);
    }
  }

  return { results: null, source: 'none' };
}

const TEAM_NAME_ES = {
  'Mexico': 'México', 'South Africa': 'Sudáfrica', 'South Korea': 'Corea del Sur',
  'Korea Republic': 'Corea del Sur', 'Korea DPR': 'Corea del Norte',
  'Czech Republic': 'República Checa', 'Czechia': 'República Checa',
  'Canada': 'Canadá', 'Bosnia & Herzegovina': 'Bosnia y Herzegovina', 'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Bosnia-Herzegovina': 'Bosnia y Herzegovina',
  'Qatar': 'Catar', 'Switzerland': 'Suiza', 'Brazil': 'Brasil', 'Morocco': 'Marruecos',
  'Haiti': 'Haití', 'Scotland': 'Escocia', 'USA': 'EE.UU.', 'United States': 'EE.UU.', 'US': 'EE.UU.',
  'Paraguay': 'Paraguay', 'Australia': 'Australia', 'Turkey': 'Turquía', 'Türkiye': 'Turquía', 'Turkiye': 'Turquía',
  'Germany': 'Alemania', 'Curaçao': 'Curazao', 'Curacao': 'Curazao', 'Ivory Coast': 'Costa de Marfil',
  "Côte d'Ivoire": 'Costa de Marfil', 'Cote dIvoire': 'Costa de Marfil',
  'Ecuador': 'Ecuador', 'Netherlands': 'Países Bajos', 'Holland': 'Países Bajos', 'The Netherlands': 'Países Bajos',
  'Japan': 'Japón', 'Sweden': 'Suecia', 'Tunisia': 'Túnez', 'Belgium': 'Bélgica',
  'Egypt': 'Egipto', 'IR Iran': 'Irán', 'Iran': 'Irán', 'New Zealand': 'Nueva Zelanda',
  'Spain': 'España', 'Cape Verde': 'Cabo Verde', 'Cabo Verde': 'Cabo Verde',
  'Saudi Arabia': 'Arabia Saudí', 'Uruguay': 'Uruguay', 'France': 'Francia', 'Senegal': 'Senegal',
  'Iraq': 'Irak', 'Norway': 'Noruega', 'Argentina': 'Argentina', 'Algeria': 'Argelia',
  'Austria': 'Austria', 'Jordan': 'Jordania', 'Portugal': 'Portugal', 'DR Congo': 'RD del Congo',
  'Congo DR': 'RD del Congo', 'Democratic Republic of the Congo': 'RD del Congo',
  'Uzbekistan': 'Uzbekistán', 'Colombia': 'Colombia',
  'England': 'Inglaterra', 'Croatia': 'Croacia', 'Ghana': 'Ghana', 'Panama': 'Panamá',
  'Albania': 'Albania', 'Cameroon': 'Camerún', 'Chile': 'Chile', 'China': 'China', 'China PR': 'China',
  'Costa Rica': 'Costa Rica', 'Denmark': 'Dinamarca', 'Finland': 'Finlandia', 'Greece': 'Grecia',
  'Hungary': 'Hungría', 'Iceland': 'Islandia', 'India': 'India', 'Indonesia': 'Indonesia',
  'Ireland': 'Irlanda', 'Republic of Ireland': 'Irlanda', 'Israel': 'Israel', 'Italy': 'Italia',
  'Jamaica': 'Jamaica', 'Nigeria': 'Nigeria', 'North Korea': 'Corea del Norte',
  'Northern Ireland': 'Irlanda del Norte', 'Peru': 'Perú', 'Poland': 'Polonia', 'Romania': 'Rumanía',
  'Russia': 'Rusia', 'Serbia': 'Serbia', 'Slovakia': 'Eslovaquia', 'Slovenia': 'Eslovenia',
  'Syria': 'Siria', 'Thailand': 'Tailandia', 'Ukraine': 'Ucrania',
  'United Arab Emirates': 'Emiratos Árabes Unidos', 'UAE': 'Emiratos Árabes Unidos',
  'Venezuela': 'Venezuela', 'Vietnam': 'Vietnam', 'Wales': 'Gales',
};

function translateTeamName(name) {
  return TEAM_NAME_ES[name] || name;
}

function detectActiveWindow(pendingMatches) {
  const now = Date.now();
  for (const match of pendingMatches) {
    if (!match.match_date) continue;
    const matchTime = new Date(match.match_date).getTime();
    const hoursSinceStart = (now - matchTime) / (60 * 60 * 1000);
    if (hoursSinceStart >= -2 && hoursSinceStart <= ACTIVE_WINDOW_HOURS) {
      return true;
    }
  }
  return false;
}

function adjustPollingInterval(pendingMatches) {
  if (currentPollingInterval) {
    clearInterval(currentPollingInterval);
    currentPollingInterval = null;
  }

  const isActive = detectActiveWindow(pendingMatches);
  hasActiveMatchWindow = isActive;

  let interval, mode;
  if (isActive) {
    interval = POLL_INTERVAL_ACTIVE;
    mode = 'ACTIVO (2 min)';
  } else if (pendingMatches.length > 0) {
    interval = POLL_INTERVAL_NORMAL;
    mode = 'NORMAL (5 min)';
  } else {
    interval = POLL_INTERVAL_IDLE;
    mode = 'IDLE (15 min)';
  }

  console.log(`🔄 Polling: ${mode} | ${pendingMatches.length} partidos pendientes`);

  currentPollingInterval = setInterval(async () => {
    try {
      const result = await checkAndUpdateResults(currentDbModule);
      if (result.updated > 0) {
        const newPending = currentDbModule.db.prepare(`
          SELECT m.*, h.name as home_team, a.name as away_team
          FROM matches m JOIN teams h ON m.home_team_id = h.id JOIN teams a ON m.away_team_id = a.id
          WHERE m.played = 0 AND m.match_date IS NOT NULL
            AND (m.status IS NULL OR m.status NOT IN ('suspended', 'postponed', 'delayed'))
        `).all();
        adjustPollingInterval(newPending);
      }
    } catch (e) {
      console.error('Result check error:', e.message);
    }
  }, interval);
}

async function checkAndUpdateResults(dbModule, options = {}) {
  const force = options.force || false;
  const now = Date.now();

  if (!force && now - lastCheck < 30 * 1000) {
    return { checked: 0, updated: 0, skipped: 'too soon' };
  }

  lastCheck = now;
  const rawDb = dbModule.db || dbModule;

  const pendingMatches = rawDb.prepare(`
    SELECT m.*, h.name as home_team, a.name as away_team
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE m.played = 0 AND m.match_date IS NOT NULL
      AND (m.status IS NULL OR m.status NOT IN ('suspended', 'postponed', 'delayed'))
    ORDER BY m.match_date
  `).all();

  if (pendingMatches.length === 0) {
    checkStats = { ...checkStats, checked: 0, updated: 0, lastRun: now };
    return { checked: 0, updated: 0 };
  }

  const { results: finalResults, source } = await fetchAllResults();
  if (!finalResults) {
    checkStats = { ...checkStats, checked: pendingMatches.length, updated: 0, lastRun: now, source: 'none' };
    return { checked: pendingMatches.length, updated: 0, error: 'all sources failed' };
  }

  let updated = 0;
  const updatedMatches = [];

  for (const match of pendingMatches) {
    if (!force && match.match_date) {
      const matchTime = new Date(match.match_date).getTime();
      const ageMs = now - matchTime;
      if (ageMs < MIN_MATCH_AGE) continue;
    }

    let result = null;
    let keys;
    if (match.stage === 'group') {
      keys = [
        `${match.home_team}|${match.away_team}|${match.group_letter}`,
        `${match.away_team}|${match.home_team}|${match.group_letter}`,
        `${match.home_team}|${match.away_team}`,
        `${match.away_team}|${match.home_team}`,
      ];
    } else {
      keys = [
        `${match.home_team}|${match.away_team}|${match.stage}`,
        `${match.away_team}|${match.home_team}|${match.stage}`,
        `${match.home_team}|${match.away_team}`,
        `${match.away_team}|${match.home_team}`,
      ];
    }
    for (const k of keys) {
      if (finalResults[k]) { result = finalResults[k]; break; }
    }
    if (!result) continue;

    const finalHome = result.homeScore;
    const finalAway = result.awayScore;
    if (!Number.isFinite(finalHome) || !Number.isFinite(finalAway) || finalHome < 0 || finalAway < 0) {
      console.warn(`⚠️  Resultado inválido ignorado para ${match.home_team} vs ${match.away_team}: ${finalHome}-${finalAway}`);
      continue;
    }
    if (match.match_date) {
      const matchTime = new Date(match.match_date).getTime();
      if (matchTime - now > 5 * 60 * 1000) {
        console.warn(`⚠️  Partido aún no jugado, ignorando: ${match.home_team} vs ${match.away_team} (${match.match_date})`);
        continue;
      }
    }
    if (match.home_score === finalHome && match.away_score === finalAway) continue;

    rawDb.prepare(`
      UPDATE matches
      SET home_score = ?, away_score = ?, played = 1
      WHERE id = ?
    `).run(finalHome, finalAway, match.id);

    if (dbModule.autoSaveNextPhaseBets) dbModule.autoSaveNextPhaseBets(match.id);

    updated++;
    updatedMatches.push({
      matchId: match.id,
      homeTeam: match.home_team,
      awayTeam: match.away_team,
      homeScore: finalHome,
      awayScore: finalAway,
    });
  }

  if (updated > 0) {
    console.log(`✅ ${updated} resultado(s) actualizado(s) desde ${source}`);
    if (dbModule.advanceWinners) {
      dbModule.advanceWinners();
    }
    if (dbModule.autoFillPhaseResults) {
      dbModule.autoFillPhaseResults();
    }
    if (dbModule.recalculateAllPoints) {
      dbModule.recalculateAllPoints();
    }
    for (const m of updatedMatches) {
      emitResultUpdate({ type: 'match_finished', source, ...m });
    }
  }

  checkStats = {
    checked: pendingMatches.length,
    updated,
    lastRun: now,
    source,
  };
  return { checked: pendingMatches.length, updated, source };
}

function startResultChecker(dbModule) {
  if (currentPollingInterval) return;
  currentDbModule = dbModule;

  console.log('🔄 Iniciando verificación automática de resultados');
  console.log(`   Fuente principal: openfootball`);
  console.log(`   Fuente secundaria: ${FOOTBALL_DATA_TOKEN ? 'football-data.org ✓' : 'football-data.org (sin token)'}`);
  console.log(`   Fuente terciaria: TheSportsDB`);

  adjustPollingInterval([]);

  setTimeout(async () => {
    try {
      const pending = currentDbModule.db.prepare(`
        SELECT m.*, h.name as home_team, a.name as away_team
        FROM matches m JOIN teams h ON m.home_team_id = h.id JOIN teams a ON m.away_team_id = a.id
        WHERE m.played = 0 AND m.match_date IS NOT NULL
          AND (m.status IS NULL OR m.status NOT IN ('suspended', 'postponed', 'delayed'))
      `).all();
      adjustPollingInterval(pending);
      const result = await checkAndUpdateResults(dbModule, { force: true });
      console.log(`📊 Primera verificación: ${result.checked} partidos, ${result.updated} actualizados (fuente: ${result.source || 'ninguna'})`);
    } catch (e) {
      console.error('Initial result check error:', e.message);
    }
  }, 5000);
}

function stopResultChecker() {
  if (currentPollingInterval) {
    clearInterval(currentPollingInterval);
    currentPollingInterval = null;
    console.log('Verificación de resultados detenida');
  }
}

function getCheckStats() {
  return { ...checkStats, activeWindow: hasActiveMatchWindow };
}

module.exports = {
  checkAndUpdateResults,
  startResultChecker,
  stopResultChecker,
  onResultUpdate,
  getCheckStats,
};
