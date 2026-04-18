export type EntryType = 'error_pattern' | 'convention' | 'decision' | 'learning' | 'ghost_knowledge';
export type EntryScope = 'team' | 'personal' | 'project';

export interface Entry {
  id: string;
  type: EntryType;
  title: string;
  content: string;
  scope: EntryScope;
  confidence: number;
  createdAt: string;
  lastConfirmed: string;
  sourceCount: number;
  sourceTool: string | null;
  developerId: string | null;
}

export interface EntryDetail extends Entry {
  tags: string[];
  files: string[];
  relationships: Relationship[];
  sources: Source[];
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  strength: number;
  relatedId: string;
  relatedTitle: string;
  relatedType: string | null;
}

export interface Source {
  id: string;
  entryId: string;
  tool: string;
  developerId: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface TeamMember {
  teamId: string;
  developerId: string;
  displayName: string;
  role: string;
  joinedAt: string;
  entryCount: number;
  lastActive: string | null;
}

export interface TeamActivity {
  id: string;
  action: string;
  developerId: string;
  displayName: string;
  entryId: string | null;
  timestamp: string;
}

export interface TeamInfo {
  id: string;
  name: string;
  createdAt: string;
  memberCount: number;
}

export interface ReviewItem {
  id: string;
  title: string;
  type: EntryType;
  content: string;
  confidence: number;
  reason: string;
  createdAt: string;
}

export interface Stats {
  entries: number;
  relationships: number;
  coRetrievals: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
}

export interface SearchResult {
  id: string;
  title: string;
  type: EntryType;
  scope: EntryScope;
  confidence: number;
  snippet: string;
}

export interface PendingInvite {
  keyHash: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface Analytics {
  totalRecalls: number;
  totalLearns: number;
  totalTokensDelivered: number;
  totalTokensInvested: number;
  leverageRatio: number;
  zeroResultRate: number;
  avgResultsPerRecall: number;
  intentBreakdown: Record<string, number>;
  recallsToday: number;
  learnsToday: number;
}

export type Mode = 'team' | 'personal';
export type View = 'feed' | 'search' | 'queue' | 'graph' | 'team';
