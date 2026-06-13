const THESPORTSDB_API = 'https://www.thesportsdb.com/api/v1/json/3';
const WORLD_CUP_LEAGUE_ID = '4429';
const WORLD_CUP_SEASON = '2026';

let liveMatchesCache = new Map();
let lastFetch = 0;
let eventListeners = [];
let currentPollingInterval = null;
let currentDbModule = null;

const POLL_INTERVAL_LIVE = 60 * 1000;
const POLL_INTERVAL_IDLE = 5 * 60 * 1000;

function onLiveUpdate(callback) {
  eventListeners.push(callback);
  return () => {
    eventListeners = eventListeners.filter(cb => cb !== callback);
  };
}

function emitLiveUpdate(data) {
  eventListeners.forEach(cb => {
    try { cb(data); } catch (e) { console.error('Live update callback error:', e); }
  });
}

function getDateRange() {
  const dates = [];
  const now = new Date();
  for (let i = 0; i <= 1; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function fetchDateEvents(date) {
  try {
    const url = `${THESPORTSDB_API}/eventsday.php?d=${date}&s=Soccer&l=${WORLD_CUP_LEAGUE_ID}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const data = await response.json();
    return data.events || [];
  } catch (err) {
    return [];
  }
}

async function fetchLiveMatches() {
  const dates = getDateRange();
  const results = await Promise.all(dates.map(d => fetchDateEvents(d)));
  const allEvents = results.flat();
  const matches = [];

  for (const e of allEvents) {
    if (e.strLeague !== 'FIFA World Cup') continue;
    const status = e.strStatus || '';
    if (!status) continue;
    const isLive = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(status);
    const isFinished = status === 'FT' || status === 'AET' || status === 'PEN';
    if (!isLive && !isFinished) continue;
    if (e.intHomeScore === null || e.intAwayScore === null) continue;

    matches.push({
      idEvent: e.idEvent,
      homeTeam: e.strHomeTeam,
      awayTeam: e.strAwayTeam,
      homeScore: parseInt(e.intHomeScore),
      awayScore: parseInt(e.intAwayScore),
      status: status,
      minute: estimateMinute(status),
      group: e.strGroup || null,
      timestamp: Date.now(),
      isLive,
      isFinished,
    });
  }

  liveMatchesCache.clear();
  matches.forEach(m => liveMatchesCache.set(m.idEvent, m));
  lastFetch = Date.now();
  return matches;
}

function estimateMinute(status) {
  switch (status) {
    case 'HT': return 'Descanso';
    case 'ET': return 'Prórroga';
    case 'P':  return 'Penaltis';
    case 'FT': case 'AET': case 'PEN': return 'Finalizado';
    default: return null;
  }
}

function getCachedMatches() {
  return Array.from(liveMatchesCache.values());
}

async function getLiveMatches(forceRefresh = false) {
  if (!forceRefresh && Date.now() - lastFetch < 60 * 1000) {
    return getCachedMatches();
  }
  return await fetchLiveMatches();
}

function hasLiveMatchesNow() {
  for (const m of liveMatchesCache.values()) {
    if (m.isLive) return true;
  }
  return false;
}

function adjustPollingInterval() {
  if (currentPollingInterval) {
    clearInterval(currentPollingInterval);
    currentPollingInterval = null;
  }

  const isLive = hasLiveMatchesNow();
  const interval = isLive ? POLL_INTERVAL_LIVE : POLL_INTERVAL_IDLE;
  const mode = isLive ? '🔴 EN VIVO (1 min)' : '⚪ IDLE (5 min)';

  console.log(`📡 Polling live-api: ${mode}`);

  currentPollingInterval = setInterval(async () => {
    try {
      await syncLiveResultsWithDb(currentDbModule);
      const stillLive = hasLiveMatchesNow();
      if (stillLive !== isLive) {
        adjustPollingInterval();
      }
    } catch (e) {
      console.error('Live polling error:', e.message);
    }
  }, interval);
}

const TEAM_NAME_ES = {
  'Mexico': 'México', 'South Africa': 'Sudáfrica', 'South Korea': 'Corea del Sur',
  'Korea Republic': 'Corea del Sur', 'Czech Republic': 'República Checa', 'Czechia': 'República Checa',
  'Canada': 'Canadá', 'Bosnia & Herzegovina': 'Bosnia y Herzegovina', 'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Bosnia-Herzegovina': 'Bosnia y Herzegovina',
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

async function syncLiveResultsWithDb(dbModule) {
  if (!dbModule) return { updated: 0, liveCount: 0 };
  const liveMatches = await fetchLiveMatches();
  if (!liveMatches.length) return { updated: 0, liveCount: 0 };

  let updated = 0;
  const rawDb = dbModule.db || dbModule;
  const getTeamByName = rawDb.prepare('SELECT id FROM teams WHERE name = ?');

  for (const live of liveMatches) {
    const homeName = translateTeamName(live.homeTeam);
    const awayName = translateTeamName(live.awayTeam);

    const home = getTeamByName.get(homeName);
    const away = getTeamByName.get(awayName);
    if (!home || !away) continue;

    let existing;
    if (live.group) {
      const letter = live.group.replace('Group ', '');
      existing = rawDb.prepare(`
        SELECT id, home_score, away_score, played FROM matches
        WHERE home_team_id = ? AND away_team_id = ? AND group_letter = ? AND stage = 'group'
      `).get(home.id, away.id, letter);
    } else {
      existing = rawDb.prepare(`
        SELECT id, home_score, away_score, played FROM matches
        WHERE home_team_id = ? AND away_team_id = ? AND stage != 'group'
      `).get(home.id, away.id);
    }
    if (!existing) continue;

    const scoreChanged = existing.home_score !== live.homeScore || existing.away_score !== live.awayScore;
    const finishedNow = live.isFinished && !existing.played;

    if (scoreChanged || finishedNow) {
      rawDb.prepare(`
        UPDATE matches
        SET home_score = ?, away_score = ?, played = ?
        WHERE id = ?
      `).run(live.homeScore, live.awayScore, live.isFinished ? 1 : 0, existing.id);

      if (finishedNow && dbModule.recalculateAllPoints) {
        dbModule.recalculateAllPoints();
        console.log(`🏁 Partido finalizado: ${homeName} ${live.homeScore}-${live.awayScore} ${awayName}`);
      }

      updated++;

      emitLiveUpdate({
        type: live.isLive ? 'live_update' : 'match_finished',
        matchId: existing.id,
        homeTeam: homeName,
        awayTeam: awayName,
        homeScore: live.homeScore,
        awayScore: live.awayScore,
        status: live.status,
        minute: live.minute,
        finished: live.isFinished,
        timestamp: Date.now(),
      });
    }
  }

  return { updated, liveCount: liveMatches.filter(m => m.isLive).length };
}

function startLivePolling(dbModule) {
  if (currentPollingInterval) return;
  currentDbModule = dbModule;

  console.log('📡 Iniciando live polling (TheSportsDB)');

  currentPollingInterval = setInterval(async () => {
    try {
      const result = await syncLiveResultsWithDb(dbModule);
      if (result.liveCount > 0) {
        const stillLive = hasLiveMatchesNow();
        if (stillLive) {
          console.log(`🔴 ${result.liveCount} partido(s) en vivo`);
        }
      }
    } catch (e) {
      console.error('Live polling error:', e.message);
    }
  }, POLL_INTERVAL_IDLE);

  setTimeout(async () => {
    try {
      const result = await syncLiveResultsWithDb(dbModule);
      console.log(`📡 Live: ${result.liveCount} en vivo, ${result.updated} actualizados`);
      adjustPollingInterval();
    } catch (e) {
      console.error('Initial live sync error:', e.message);
    }
  }, 8000);
}

function stopLivePolling() {
  if (currentPollingInterval) {
    clearInterval(currentPollingInterval);
    currentPollingInterval = null;
    console.log('Live polling detenido');
  }
}

module.exports = {
  fetchLiveMatches,
  getLiveMatches,
  getCachedMatches,
  syncLiveResultsWithDb,
  startLivePolling,
  stopLivePolling,
  onLiveUpdate,
  hasLiveMatchesNow,
  translateTeamName,
};
