const API = {
  async request(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-cache',
    };
    if (body) opts.body = JSON.stringify(body);
    const controller = new AbortController();
    opts.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, opts);
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error del servidor');
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('La solicitud tardó demasiado');
      throw e;
    }
  },

  // Auth
  login: (username, password) =>
    API.request('POST', '/api/auth/login', { username, password }),

  register: (username, password, groupName, inviteCode) =>
    API.request('POST', '/api/auth/register', { username, password, groupName, inviteCode }),

  logout: () => API.request('POST', '/api/auth/logout'),

  me: () => API.request('GET', '/api/auth/me'),

  updateProfile: (data) => API.request('PUT', '/api/auth/profile', data),

  // Teams
  getTeams: () => API.request('GET', '/api/teams'),

  // Matches
  getMatches: (stage, group) => {
    let url = '/api/matches';
    const params = [];
    if (stage) params.push(`stage=${stage}`);
    if (group) params.push(`group=${group}`);
    if (params.length) url += '?' + params.join('&');
    return API.request('GET', url);
  },

  // Bets
  getBets: () => API.request('GET', '/api/bets'),

  getBetsByUser: (userId) => API.request('GET', `/api/bets/user/${userId}`),

  saveBet: (matchId, homeScore, awayScore, penaltyWinnerId) =>
    API.request('POST', '/api/bets', { matchId, homeScore, awayScore, penaltyWinnerId }),

  saveBetsBatch: (bets) =>
    API.request('POST', '/api/bets/batch', { bets }),

  getBet: (matchId) =>
    API.request('GET', `/api/bets/match/${matchId}`),

  getMatchBetsByGroup: (matchId) =>
    API.request('GET', `/api/bets/match/${matchId}/group`),

  // Phase bets
  getPhaseBets: () => API.request('GET', '/api/bets/phase'),

  savePhaseBets: (teamIds, stage) =>
    API.request('POST', '/api/bets/phase', { teamIds, stage }),

  // Special bets
  getSpecialBets: () => API.request('GET', '/api/bets/special'),

  saveSpecialBet: (betType, teamId, playerName) =>
    API.request('POST', '/api/bets/special', { betType, teamId, playerName }),

  // Standings
  getStandings: () => API.request('GET', '/api/standings'),

  // Group Stats (visible para todos los miembros)
  getGroupStats: () => API.request('GET', '/api/stats'),

  // Group
  getGroup: () => API.request('GET', '/api/group'),

  updateGroupName: (name) =>
    API.request('PATCH', '/api/group', { name }),

  // Admin
  setMatchResult: (matchId, homeScore, awayScore) =>
    API.request('POST', '/api/admin/set-match-result', { matchId, homeScore, awayScore }),

  createMatch: (homeTeamId, awayTeamId, stage, groupLetter, matchDate) =>
    API.request('POST', '/api/admin/matches', { homeTeamId, awayTeamId, stage, groupLetter, matchDate }),

  updateMatch: (matchId, data) =>
    API.request('PUT', `/api/admin/matches/${matchId}`, data),

  deleteMatch: (matchId) =>
    API.request('DELETE', `/api/admin/matches/${matchId}`),

  setPhaseResults: (stage, teamIds) =>
    API.request('POST', '/api/admin/phase-results', { stage, teamIds }),

  getPhaseResults: (stage) =>
    API.request('GET', `/api/admin/phase-results${stage ? '?stage='+stage : ''}`),

  setSpecialResult: (betType, teamId, playerName) =>
    API.request('POST', '/api/admin/special-results', { betType, teamId, playerName }),

  getSpecialResults: () => API.request('GET', '/api/admin/special-results'),

  recalculate: () => API.request('POST', '/api/admin/recalculate'),

  getUsers: () => API.request('GET', '/api/admin/users'),

  toggleUserAdmin: (userId) => API.request('POST', `/api/admin/users/${userId}/toggle-admin`),

  deleteUser: (userId) => API.request('DELETE', `/api/admin/users/${userId}`),

  syncFixtures: () => API.request('POST', '/api/admin/sync-fixtures'),

  updateResults: () => API.request('POST', '/api/admin/update-results'),

  getGroupBets: () => API.request('GET', '/api/admin/group-bets'),

  getStats: () => API.request('GET', '/api/admin/stats'),

  // Players
  getPlayers: (teamId) => API.request('GET', `/api/players${teamId ? '?team_id='+teamId : ''}`),

  searchPlayers: (query) => API.request('GET', `/api/players?q=${encodeURIComponent(query)}`),

  syncPlayers: () => API.request('POST', '/api/admin/sync-players'),

  checkResults: () => API.request('POST', '/api/admin/check-results'),

  getCheckStats: () => API.request('GET', '/api/admin/check-stats'),

  getLiveMatches: (force) => API.request('GET', `/api/live/matches${force ? '?force=1' : ''}`),

  getLiveStatus: () => API.request('GET', '/api/live/status'),

  getDefaultView: () => API.request('GET', '/api/config/default-view'),

  setDefaultView: (view) =>
    API.request('PUT', '/api/admin/config/default-view', { view }),

  getDefaultViewStage: () => API.request('GET', '/api/config/default-view-stage'),

  setDefaultViewStage: (stage) =>
    API.request('PUT', '/api/admin/config/default-view-stage', { stage }),

  getPhaseDeadlines: () => API.request('GET', '/api/phase-deadlines'),

  setPhaseDeadline: (stage, hours, minutes, seconds) =>
    API.request('PUT', `/api/admin/phase-deadlines/${stage}`, { hours, minutes, seconds }),

  togglePhaseDeadline: (stage) =>
    API.request('POST', `/api/admin/phase-deadlines/${stage}/toggle`),

  connectLiveEvents: (onMessage) => {
    if (typeof EventSource === 'undefined') return null;
    const evtSource = new EventSource('/api/live/events');
    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch (e) { console.error('SSE parse error:', e); }
    };
    evtSource.onerror = () => {
      setTimeout(() => {
        if (evtSource.readyState === EventSource.CLOSED) {
          API.connectLiveEvents(onMessage);
        }
      }, 5000);
    };
    return evtSource;
  },
};
