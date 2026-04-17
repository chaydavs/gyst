import type { Entry, EntryDetail, TeamMember, TeamInfo, ReviewItem, Stats, SearchResult } from './types';

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
  listEntries: (params: { scope?: string; type?: string; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params.scope) q.set('scope', params.scope);
    if (params.type) q.set('type', params.type);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
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

  // Review queue
  getReviewQueue: () => apiFetch<ReviewItem[]>('/api/review-queue'),
  confirmEntry: (id: string) => apiFetch<{ ok: boolean }>(`/api/review-queue/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: '{}' }),
  archiveEntry: (id: string) => apiFetch<{ ok: boolean }>(`/api/review-queue/${encodeURIComponent(id)}/archive`, { method: 'POST', body: '{}' }),

  // Team
  getTeamInfo: () => apiFetch<TeamInfo | null>('/api/team/info'),
  getTeamMembers: () => apiFetch<TeamMember[]>('/api/team/members'),
  createInvite: () => apiFetch<{ inviteCode: string; expiresAt: string; installCommand: string }>('/api/team/invite', { method: 'POST', body: '{}' }),

  // Misc
  getDetectedTools: () => apiFetch<Array<{ name: string; detected: boolean; configPath: string }>>('/api/tools/detected'),
  getHealth: () => apiFetch<{ status: string; version: string; entriesCount: number }>('/api/health'),
};
