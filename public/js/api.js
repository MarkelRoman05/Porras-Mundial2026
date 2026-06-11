const API = {
  async request(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error del servidor');
    return data;
  },

  // Auth
  login: (username, password) =>
    API.request('POST', '/api/auth/login', { username, password }),

  register: (username, password, groupName, inviteCode) =>
    API.request('POST', '/api/auth/register', { username, password, groupName, inviteCode }),

  logout: () => API.request('POST', '/api/auth/logout'),

  me: () => API.request('GET', '/api/auth/me'),

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

  saveBet: (matchId, homeScore, awayScore) =>
    API.request('POST', '/api/bets', { matchId, homeScore, awayScore }),

  saveBetsBatch: (bets) =>
    API.request('POST', '/api/bets/batch', { bets }),

  getBet: (matchId) =>
    API.request('GET', `/api/bets/match/${matchId}`),

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

  // Group
  getGroup: () => API.request('GET', '/api/group'),

  updateGroupName: (name) =>
    API.request('PATCH', '/api/group', { name }),

  // Admin
  setMatchResult: (matchId, homeScore, awayScore) =>
    API.request('POST', '/api/admin/set-match-result', { matchId, homeScore, awayScore }),

  createMatch: (homeTeamId, awayTeamId, stage, groupLetter, matchDate) =>
    API.request('POST', '/api/admin/matches', { homeTeamId, awayTeamId, stage, groupLetter, matchDate }),

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

  // Players
  getPlayers: (teamId) => API.request('GET', `/api/players${teamId ? '?team_id='+teamId : ''}`),

  searchPlayers: (query) => API.request('GET', `/api/players?q=${encodeURIComponent(query)}`),

  syncPlayers: () => API.request('POST', '/api/admin/sync-players'),
};
