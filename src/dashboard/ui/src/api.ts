import type { Entry, EntryDetail, TeamMember, TeamInfo, ReviewItem, Stats, Analytics, MemberStats, SearchResult, PendingInvite, TeamActivity, DriftReport } from './types';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Entries
  listEntries: (params: { scope?: string; type?: string; limit?: number; offset?: number; developerId?: string }) => {
    const q = new URLSearchParams();
    if (params.scope) q.set('scope', params.scope);
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    if (params.developerId) q.set('developerId', params.developerId);
    return apiFetch<Entry[]>(`/api/entries?${q}`);
  },
  getEntry: (id: string) => apiFetch<EntryDetail>(`/api/entries/${encodeURIComponent(id)}`),
  createEntry: (data: { type: string; title: string; content: string; scope: string; tags?: string[]; files?: string[] }) =>
    apiFetch<{ id: string; title: string; type: string; scope: string }>('/api/entries', { method: 'POST', body: JSON.stringify(data) }),
  updateEntry: (id: string, data: { title?: string; content?: string; scope?: string; tags?: string[] }) =>
    apiFetch<Entry>(`/api/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  feedback: (id: string, helpful: boolean, note?: string) =>
    apiFetch<{ ok: boolean }>(`/api/entries/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify({ helpful, note }) }),
  promote: (id: string) =>
    apiFetch<{ ok: boolean; id: string }>(`/api/entries/${encodeURIComponent(id)}/promote`, { method: 'POST', body: JSON.stringify({}) }),

  // Search
  search: (q: string, scope?: string) => {
    const params = new URLSearchParams({ q });
    if (scope) params.set('scope', scope);
    return apiFetch<SearchResult[]>(`/api/search?${params}`);
  },

  // Stats
  getStats: () => apiFetch<Stats>('/api/stats'),
  getAnalytics: () => apiFetch<Analytics>('/api/analytics'),

  // Review queue
  getReviewQueue: () => apiFetch<ReviewItem[]>('/api/review-queue'),
  confirmEntry: (id: string) => apiFetch<{ ok: boolean }>(`/api/review-queue/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' }),
  archiveEntry: (id: string) => apiFetch<{ ok: boolean }>(`/api/review-queue/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' }),

  // Team
  getTeamInfo: () => apiFetch<TeamInfo | null>('/api/team/info'),
  getTeamMembers: () => apiFetch<TeamMember[]>('/api/team/members'),
  createTeam: (name: string) => apiFetch<{ teamId: string; name: string }>('/api/team', { method: 'POST', body: JSON.stringify({ name }) }),
  createInvite: () => apiFetch<{ inviteCode: string; expiresAt: string; installCommand: string }>('/api/team/invite', { method: 'POST', body: '{}' }),
  listInvites: () => apiFetch<PendingInvite[]>('/api/team/invites'),
  getTeamActivity: (limit = 50) => apiFetch<TeamActivity[]>(`/api/team/activity?limit=${limit}`),
  revokeInvite: (keyHash: string) => apiFetch<{ ok: boolean }>(`/api/team/invites/${encodeURIComponent(keyHash)}`, { method: 'DELETE' }),
  getMemberStats: (developerId: string) => apiFetch<MemberStats>(`/api/team/members/${encodeURIComponent(developerId)}/stats`),
  removeMember: (developerId: string) => apiFetch<{ ok: boolean }>(`/api/team/members/${encodeURIComponent(developerId)}`, { method: 'DELETE' }),
  deleteTeam: () => apiFetch<{ ok: boolean }>('/api/team', { method: 'DELETE' }),
  shutdownServer: () => apiFetch<{ ok: boolean; message: string }>('/api/shutdown', { method: 'POST', body: '{}' }),

  // Activity
  getActivity: (params?: { limit?: number; developerId?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.developerId) q.set('developerId', params.developerId);
    return apiFetch<Array<{ id: number; event: string; developerId: string | null; createdAt: string }>>(`/api/events?${q}`);
  },

  // Drift detection
  getDrift: () => apiFetch<DriftReport>('/api/drift'),
  getAnchors: () => apiFetch<Array<{ id: number; query: string; lastOk: boolean }>>('/api/drift/anchors'),
  addAnchor: (query: string) => apiFetch<{ ok: boolean }>('/api/drift/anchors', { method: 'POST', body: JSON.stringify({ query }) }),
  removeAnchor: (id: number) => apiFetch<{ ok: boolean }>(`/api/drift/anchors/${id}`, { method: 'DELETE' }),

  // Misc
  getDetectedTools: () => apiFetch<Array<{ name: string; detected: boolean; configPath: string }>>('/api/tools/detected'),
  getHealth: () => apiFetch<{ status: string; version: string; entriesCount: number }>('/api/health'),
};
