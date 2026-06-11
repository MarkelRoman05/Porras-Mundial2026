const OPENFOOTBALL_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

let currentPollingInterval = null;
let currentDbModule = null;
let eventListeners = [];
let lastCheck = 0;
let checkStats = { checked: 0, updated: 0, lastRun: null };

const POLL_INTERVAL = 5 * 60 * 1000;
const MIN_MATCH_AGE = 90 * 60 * 1000;

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

async function fetchFinalResults() {
  try {
    const response = await fetch(OPENFOOTBALL_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const matches = data.matches || [];
    const groupMatches = matches.filter(m => m.group && m.group.startsWith('Group'));
    
    const results = {};
    for (const m of groupMatches) {
      const score = m.score || [null, null];
      if (score[0] === null || score[1] === null) continue;
      
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
      };
    }
    
    return results;
  } catch (error) {
    console.error('Error fetching final results:', error.message);
    return null;
  }
}

const TEAM_NAME_ES = {
  'Mexico': 'México', 'South Africa': 'Sudáfrica', 'South Korea': 'Corea del Sur',
  'Korea Republic': 'Corea del Sur', 'Czech Republic': 'República Checa', 'Czechia': 'República Checa',
  'Canada': 'Canadá', 'Bosnia & Herzegovina': 'Bosnia y Herzegovina', 'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Qatar': 'Catar', 'Switzerland': 'Suiza', 'Brazil': 'Brasil', 'Morocco': 'Marruecos',
  'Haiti': 'Haití', 'Scotland': 'Escocia', 'USA': 'EE.UU.', 'United States': 'EE.UU.',
  'Paraguay': 'Paraguay', 'Australia': 'Australia', 'Turkey': 'Turquía', 'Türkiye': 'Turquía',
  'Germany': 'Alemania', 'Curaçao': 'Curazao', 'Curacao': 'Curazao', 'Ivory Coast': 'Costa de Marfil',
  "Côte d'Ivoire": 'Costa de Marfil', 'Ecuador': 'Ecuador', 'Netherlands': 'Países Bajos',
  'Japan': 'Japón', 'Sweden': 'Suecia', 'Tunisia': 'Túnez', 'Belgium': 'Bélgica',
  'Egypt': 'Egipto', 'IR Iran': 'Irán', 'Iran': 'Irán', 'New Zealand': 'Nueva Zelanda',
  'Spain': 'España', 'Cape Verde': 'Cabo Verde', 'Cabo Verde': 'Cabo Verde',
  'Saudi Arabia': 'Arabia Saudí', 'Uruguay': 'Uruguay', 'France': 'Francia', 'Senegal': 'Senegal',
  'Iraq': 'Irak', 'Norway': 'Noruega', 'Argentina': 'Argentina', 'Algeria': 'Argelia',
  'Austria': 'Austria', 'Jordan': 'Jordania', 'Portugal': 'Portugal', 'DR Congo': 'RD del Congo',
  'Congo DR': 'RD del Congo', 'Uzbekistan': 'Uzbekistán', 'Colombia': 'Colombia',
  'England': 'Inglaterra', 'Croatia': 'Croacia', 'Ghana': 'Ghana', 'Panama': 'Panamá',
};

function translateTeamName(name) {
  return TEAM_NAME_ES[name] || name;
}

async function checkAndUpdateResults(dbModule, options = {}) {
  const force = options.force || false;
  const now = Date.now();
  
  if (!force && now - lastCheck < 60 * 1000) {
    return { checked: 0, updated: 0, skipped: 'too soon' };
  }
  
  lastCheck = now;
  const rawDb = dbModule.db || dbModule;
  
  const pendingMatches = rawDb.prepare(`
    SELECT m.*, h.name as home_team, a.name as away_team
    FROM matches m
    JOIN teams h ON m.home_team_id = h.id
    JOIN teams a ON m.away_team_id = a.id
    WHERE m.played = 0 AND m.stage = 'group' AND m.match_date IS NOT NULL
  `).all();
  
  if (pendingMatches.length === 0) {
    checkStats = { checked: 0, updated: 0, lastRun: now };
    return { checked: 0, updated: 0 };
  }
  
  const finalResults = await fetchFinalResults();
  if (!finalResults) {
    return { checked: pendingMatches.length, updated: 0, error: 'fetch failed' };
  }
  
  let updated = 0;
  const updatedMatches = [];
  
  for (const match of pendingMatches) {
    if (!force && match.match_date) {
      const matchTime = new Date(match.match_date).getTime();
      const ageMs = now - matchTime;
      if (ageMs < MIN_MATCH_AGE) continue;
    }
    
    const key1 = `${match.home_team}|${match.away_team}|${match.group_letter}`;
    const key2 = `${match.away_team}|${match.home_team}|${match.group_letter}`;
    const result = finalResults[key1] || finalResults[key2];
    
    if (!result) continue;
    
    const finalHome = result.homeScore;
    const finalAway = result.awayScore;
    
    if (match.home_score === finalHome && match.away_score === finalAway) continue;
    
    rawDb.prepare(`
      UPDATE matches
      SET home_score = ?, away_score = ?, played = 1
      WHERE id = ?
    `).run(finalHome, finalAway, match.id);
    
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
    console.log(`✅ ${updated} resultados actualizados automáticamente`);
    if (dbModule.recalculateAllPoints) {
      dbModule.recalculateAllPoints();
    }
    
    for (const m of updatedMatches) {
      emitResultUpdate({
        type: 'match_finished',
        ...m,
      });
    }
  }
  
  checkStats = { checked: pendingMatches.length, updated, lastRun: now };
  return { checked: pendingMatches.length, updated };
}

function startResultChecker(dbModule, intervalMs) {
  if (currentPollingInterval) return;
  currentDbModule = dbModule;
  
  const interval = intervalMs || POLL_INTERVAL;
  console.log(`🔄 Iniciando verificación automática de resultados (cada ${interval / 1000}s)`);
  
  currentPollingInterval = setInterval(async () => {
    try {
      await checkAndUpdateResults(dbModule);
    } catch (e) {
      console.error('Result check error:', e.message);
    }
  }, interval);
  
  setTimeout(async () => {
    try {
      const result = await checkAndUpdateResults(dbModule, { force: true });
      console.log(`📊 Primera verificación: ${result.checked} partidos, ${result.updated} actualizados`);
    } catch (e) {
      console.error('Initial result check error:', e.message);
    }
  }, 10000);
}

function stopResultChecker() {
  if (currentPollingInterval) {
    clearInterval(currentPollingInterval);
    currentPollingInterval = null;
    console.log('Verificación de resultados detenida');
  }
}

function getCheckStats() {
  return { ...checkStats };
}

module.exports = {
  checkAndUpdateResults,
  startResultChecker,
  stopResultChecker,
  onResultUpdate,
  getCheckStats,
};
