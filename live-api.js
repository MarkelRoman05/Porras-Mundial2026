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
    const url = `${THESPORTSDB_API}/eventsday.php?d=${date}&s=Soccer&l=${WORLD_CUP_LEAGUE_ID}&_t=${Date.now()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const data = await response.json();
    return data.events || [];
  } catch (err) {
    return [];
  }
}

async function fetchLiveMatches(dbModule = null) {
  const dates = getDateRange();
  const results = await Promise.all(dates.map(d => fetchDateEvents(d)));
  const allEvents = results.flat();
  const matches = [];
  const seenDbIds = new Set();

  for (const e of allEvents) {
    if (e.strLeague !== 'FIFA World Cup') continue;
    const status = e.strStatus || '';
    if (!status) continue;
    const { isLive, isFinished, isSuspended, isPostponed, isDelayed, dbStatus } = classifyStatus(status);
    if (!isLive && !isFinished && !isSuspended && !isPostponed && !isDelayed) continue;
    if (e.intHomeScore === null || e.intAwayScore === null) continue;
    const homeScore = parseInt(e.intHomeScore);
    const awayScore = parseInt(e.intAwayScore);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    if (homeScore < 0 || awayScore < 0) continue;

    const matchInfo = {
      idEvent: e.idEvent,
      homeTeam: e.strHomeTeam,
      awayTeam: e.strAwayTeam,
      homeScore,
      awayScore,
      status: status,
      dbStatus: dbStatus,
      minute: estimateMinute(status),
      group: e.strGroup || null,
      timestamp: Date.now(),
      isLive,
      isFinished,
      isSuspended,
      isPostponed,
      isDelayed,
    };
    matches.push(matchInfo);
    if (dbModule) {
      const dbMatch = findDbMatchForLive(dbModule, e.strHomeTeam, e.strAwayTeam, e.strGroup);
      if (dbMatch) {
        matchInfo.matchDbId = dbMatch.id;
        seenDbIds.add(dbMatch.id);
      }
    }
  }

  if (dbModule) {
    const windowMatches = await fetchWindowMatches(dbModule);
    for (const wm of windowMatches) {
      if (seenDbIds.has(wm.matchDbId)) continue;
      matches.push(wm);
      console.log(`📡 Partido en vivo detectado por búsqueda directa: ${wm.homeTeam} ${wm.homeScore}-${wm.awayScore} ${wm.awayTeam} (${wm.status})`);
    }
  }

  liveMatchesCache.clear();
  matches.forEach(m => liveMatchesCache.set(m.idEvent, m));
  lastFetch = Date.now();
  return matches;
}

function findDbMatchForLive(dbModule, homeEn, awayEn, groupStr) {
  if (!dbModule.db) return null;
  const reverseTranslate = buildReverseTranslate();
  const allTeams = dbModule.db.prepare('SELECT id, name FROM teams').all();
  const teamByEn = new Map();
  for (const t of allTeams) {
    for (const [en, es] of Object.entries(TEAM_NAME_ES)) {
      if (es === t.name) teamByEn.set(en, t.id);
    }
    if (!teamByEn.has(t.name)) teamByEn.set(t.name, t.id);
  }
  const homeId = teamByEn.get(homeEn);
  const awayId = teamByEn.get(awayEn);
  if (!homeId || !awayId) return null;
  const letter = groupStr ? groupStr.replace('Group ', '') : null;
  if (letter) {
    return dbModule.db.prepare(`
      SELECT id FROM matches
      WHERE home_team_id = ? AND away_team_id = ? AND group_letter = ? AND stage = 'group'
    `).get(homeId, awayId, letter);
  }
  return dbModule.db.prepare(`
    SELECT id FROM matches
    WHERE home_team_id = ? AND away_team_id = ? AND stage != 'group'
  `).get(homeId, awayId);
}

function estimateMinute(status) {
  switch (status) {
    case 'HT': return 'Descanso';
    case 'ET': return 'Prórroga';
    case 'P':  return 'Penaltis';
    case 'FT': case 'AET': case 'PEN': return 'Finalizado';
    case 'SUSP': case 'Suspended': return 'Suspendido';
    case 'PST': case 'Postponed': return 'Aplazado';
    case 'TBD': case 'Delayed': return 'Retrasado';
    default: return null;
  }
}

function classifyStatus(status) {
  if (!status) return { isLive: false, isFinished: false, isSuspended: false, isPostponed: false, isDelayed: false, dbStatus: null };

  const liveStatuses = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'];
  const finishedStatuses = ['FT', 'AET', 'PEN'];
  const suspendedStatuses = ['SUSP', 'Suspended', 'ABD', 'Abandoned'];
  const postponedStatuses = ['PST', 'Postponed'];
  const delayedStatuses = ['TBD', 'Delayed', 'WO'];

  const isLive = liveStatuses.includes(status);
  const isFinished = finishedStatuses.includes(status);
  const isSuspended = suspendedStatuses.includes(status);
  const isPostponed = postponedStatuses.includes(status);
  const isDelayed = delayedStatuses.includes(status);

  let dbStatus = null;
  if (isLive) {
    if (status === 'ET') dbStatus = 'extra_time';
    else if (status === 'P') dbStatus = 'penalties';
    else dbStatus = 'in_progress';
  } else if (isFinished) {
    if (status === 'AET') dbStatus = 'finished_aet';
    else if (status === 'PEN') dbStatus = 'finished_pen';
    else dbStatus = 'finished';
  } else if (isSuspended) dbStatus = 'suspended';
  else if (isPostponed) dbStatus = 'postponed';
  else if (isDelayed) dbStatus = 'delayed';

  return { isLive, isFinished, isSuspended, isPostponed, isDelayed, dbStatus };
}

function getCachedMatches() {
  return Array.from(liveMatchesCache.values());
}

async function getLiveMatches(forceRefresh = false) {
  if (!forceRefresh && Date.now() - lastFetch < 10 * 1000) {
    return getCachedMatches();
  }
  return await fetchLiveMatches(currentDbModule);
}

async function fetchMatchByTeams(homeName, awayName) {
  const homeVariants = getNameVariants(homeName);
  const awayVariants = getNameVariants(awayName);
  for (const h of homeVariants.slice(0, 2)) {
    for (const a of awayVariants.slice(0, 2)) {
      const ev = await searchEvent(h, a);
      if (ev) return ev;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return null;
}

function getNameVariants(name) {
  const variants = [name];
  const priorityOrder = [
    'Bosnia-Herzegovina', 'Bosnia and Herzegovina', 'Bosnia & Herzegovina',
    'Ivory Coast', "Côte d'Ivoire", 'Cote dIvoire',
    'South Korea', 'Korea Republic', 'Czech Republic', 'Czechia',
    'USA', 'United States', 'Cape Verde', 'Cabo Verde',
    'New Zealand', 'Saudi Arabia', 'Türkiye', 'Turkiye', 'Turkey',
    'Netherlands', 'Holland', 'The Netherlands',
    'Curacao', 'Curaçao', 'IR Iran', 'Iran',
  ];
  for (const en of priorityOrder) {
    const es = TEAM_NAME_ES[en];
    if (es === name && !variants.includes(en)) {
      variants.push(en);
    }
  }
  for (const [en, es] of Object.entries(TEAM_NAME_ES)) {
    if (es === name && !variants.includes(en)) {
      variants.push(en);
    }
  }
  return variants;
}

async function searchEvent(homeName, awayName) {
  try {
    const search = `${homeName}_vs_${awayName}`;
    const url = `${THESPORTSDB_API}/searchevents.php?e=${encodeURIComponent(search)}&s=${WORLD_CUP_SEASON}&_t=${Date.now()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    const events = data.event || [];
    if (events.length === 0) return null;
    const wcEvent = events.find(e => e.idLeague === WORLD_CUP_LEAGUE_ID && e.strSeason === WORLD_CUP_SEASON);
    if (wcEvent) return wcEvent;
    const otherWorldCup = events.find(e => e.strLeague?.includes('World Cup'));
    if (otherWorldCup) return null;
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchWindowMatches(dbModule) {
  if (!dbModule || !dbModule.getMatchesInWindow) return [];
  const windowMatches = dbModule.getMatchesInWindow();
  const results = [];
  const teamById = new Map();
  const allTeams = dbModule.db.prepare('SELECT id, name FROM teams').all();
  for (const t of allTeams) teamById.set(t.id, t.name);

  const reverseTranslate = buildReverseTranslate();

  for (const m of windowMatches) {
    const homeEn = reverseTranslate[m.home_team] || m.home_team;
    const awayEn = reverseTranslate[m.away_team] || m.away_team;
    const ev = await fetchMatchByTeams(homeEn, awayEn);
    if (!ev) continue;
    if (!ev.strLeague?.includes('World Cup')) continue;
    if (ev.idLeague && ev.idLeague !== WORLD_CUP_LEAGUE_ID) continue;
    if (ev.strSeason && ev.strSeason !== WORLD_CUP_SEASON) continue;

    if (m.match_date && ev.dateEvent) {
      const dbDate = new Date(m.match_date);
      const evDate = new Date(ev.dateEvent);
      const diffDays = Math.abs((dbDate - evDate) / (1000 * 60 * 60 * 24));
      if (diffDays > 1) {
        console.warn(`⚠️  Fecha no coincide (BD: ${m.match_date}, TSDB: ${ev.dateEvent}), ignorando: ${m.home_team} vs ${m.away_team}`);
        continue;
      }
    }

    const status = ev.strStatus || '';
    if (!status) continue;
    const { isLive, isFinished, isSuspended, isPostponed, isDelayed, dbStatus } = classifyStatus(status);
    if (!isLive && !isFinished && !isSuspended && !isPostponed && !isDelayed) continue;
    const homeScore = parseInt(ev.intHomeScore);
    const awayScore = parseInt(ev.intAwayScore);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

    results.push({
      idEvent: ev.idEvent,
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      homeScore,
      awayScore,
      status,
      dbStatus,
      minute: estimateMinute(status),
      group: m.group_letter ? `Group ${m.group_letter}` : null,
      timestamp: Date.now(),
      isLive,
      isFinished,
      isSuspended,
      isPostponed,
      isDelayed,
      matchDbId: m.id,
    });
  }
  return results;
}

function buildReverseTranslate() {
  const map = {};
  const priorityOrder = [
    'Bosnia-Herzegovina',
    'Bosnia and Herzegovina',
    'Bosnia & Herzegovina',
    'Ivory Coast',
    "Côte d'Ivoire",
    'Cote dIvoire',
    'South Korea',
    'Korea Republic',
    'Czech Republic',
    'Czechia',
    'USA',
    'United States',
    'Cape Verde',
    'Cabo Verde',
    'New Zealand',
    'Saudi Arabia',
  ];
  const prioritySet = new Set(priorityOrder);
  for (const en of priorityOrder) {
    const es = TEAM_NAME_ES[en];
    if (es && !map[es]) map[es] = en;
  }
  for (const [en, es] of Object.entries(TEAM_NAME_ES)) {
    if (prioritySet.has(en)) continue;
    if (!map[es]) map[es] = en;
  }
  return map;
}

function hasLiveMatchesNow() {
  for (const m of liveMatchesCache.values()) {
    if (m.isLive || m.isSuspended || m.isDelayed) return true;
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

async function syncLiveResultsWithDb(dbModule) {
  if (!dbModule) return { updated: 0, liveCount: 0 };
  const liveMatches = await fetchLiveMatches(currentDbModule);
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
        SELECT id, home_score, away_score, played, status, match_date FROM matches
        WHERE home_team_id = ? AND away_team_id = ? AND group_letter = ? AND stage = 'group'
      `).get(home.id, away.id, letter);
    } else {
      existing = rawDb.prepare(`
        SELECT id, home_score, away_score, played, status, match_date FROM matches
        WHERE home_team_id = ? AND away_team_id = ? AND stage != 'group'
      `).get(home.id, away.id);
    }
    if (!existing) continue;

    if (existing.played === 1) continue;

    if (!Number.isFinite(live.homeScore) || !Number.isFinite(live.awayScore) || live.homeScore < 0 || live.awayScore < 0) {
      console.warn(`⚠️  Score inválido ignorado de live-api: ${homeName} ${live.homeScore}-${live.awayScore} ${awayName}`);
      continue;
    }

    const matchRow = rawDb.prepare('SELECT match_date FROM matches WHERE id = ?').get(existing.id);
    if (matchRow && matchRow.match_date) {
      const matchTime = new Date(matchRow.match_date).getTime();
      if (matchTime - Date.now() > 5 * 60 * 1000) {
        console.warn(`⚠️  Partido aún no jugado, ignorando update: ${homeName} vs ${awayName} (${matchRow.match_date})`);
        continue;
      }
    }

    const prevStatus = existing.status || 'scheduled';
    const scoreChanged = existing.home_score !== live.homeScore || existing.away_score !== live.awayScore;
    const finishedNow = live.isFinished && !existing.played;
    const statusChanged = prevStatus !== live.dbStatus;

    console.log(`🔍 Sync check: ${homeName} vs ${awayName} | BD: ${existing.home_score}-${existing.away_score} (played=${existing.played}, status=${prevStatus}) | Live: ${live.homeScore}-${live.awayScore} (${live.status}/${live.dbStatus}) | changed=${scoreChanged} | finished=${finishedNow} | statusChanged=${statusChanged}`);

    // Handle suspended: update status so UI shows it, but don't set scores if they were already set
    if (live.isSuspended) {
      if (statusChanged) {
        rawDb.prepare('UPDATE matches SET status = ? WHERE id = ?').run('suspended', existing.id);
        console.log(`⏸️  Partido suspendido: ${homeName} vs ${awayName}`);
        emitLiveUpdate({
          type: 'match_suspended',
          matchId: existing.id,
          homeTeam: homeName,
          awayTeam: awayName,
          homeScore: live.homeScore,
          awayScore: live.awayScore,
          status: live.status,
          minute: live.minute,
          timestamp: Date.now(),
        });
        updated++;
      }
      continue;
    }

    // Handle postponed: update status
    if (live.isPostponed) {
      if (statusChanged || prevStatus !== 'postponed') {
        rawDb.prepare('UPDATE matches SET status = ? WHERE id = ?').run('postponed', existing.id);
        console.log(`📅 Partido aplazado: ${homeName} vs ${awayName}`);
        emitLiveUpdate({
          type: 'match_postponed',
          matchId: existing.id,
          homeTeam: homeName,
          awayTeam: awayName,
          status: live.status,
          timestamp: Date.now(),
        });
        updated++;
      }
      continue;
    }

    // Handle delayed: update status
    if (live.isDelayed) {
      if (statusChanged || prevStatus !== 'delayed') {
        rawDb.prepare('UPDATE matches SET status = ? WHERE id = ?').run('delayed', existing.id);
        console.log(`⏳ Partido retrasado: ${homeName} vs ${awayName}`);
        emitLiveUpdate({
          type: 'match_delayed',
          matchId: existing.id,
          homeTeam: homeName,
          awayTeam: awayName,
          status: live.status,
          timestamp: Date.now(),
        });
        updated++;
      }
      continue;
    }

    // If match was suspended/delayed/postponed and is now live again, log the resumption
    if (prevStatus === 'suspended' || prevStatus === 'delayed' || prevStatus === 'postponed') {
      if (live.isLive) {
        console.log(`▶️  Partido reanudado: ${homeName} vs ${awayName} (era ${prevStatus})`);
        emitLiveUpdate({
          type: 'match_resumed',
          matchId: existing.id,
          homeTeam: homeName,
          awayTeam: awayName,
          homeScore: live.homeScore,
          awayScore: live.awayScore,
          status: live.status,
          minute: live.minute,
          previousStatus: prevStatus,
          timestamp: Date.now(),
        });
      }
    }

    if (scoreChanged || finishedNow || statusChanged) {
      const newPlayed = finishedNow ? 1 : 0;
      rawDb.prepare(`
        UPDATE matches
        SET home_score = ?, away_score = ?, played = ?, status = ?
        WHERE id = ?
      `).run(live.homeScore, live.awayScore, newPlayed, live.dbStatus, existing.id);

      console.log(`✅ Updated match ${existing.id}: ${live.homeScore}-${live.awayScore} (played=${newPlayed}, status=${live.dbStatus})`);

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
        dbStatus: live.dbStatus,
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
