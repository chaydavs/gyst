# Knowledge Graph

## Overview

The knowledge graph connects entries by explicit relationships, implicit co-retrieval patterns, and structural (AST-derived) edges. The graph is used for graph-traversal search (Strategy 3), the `graph` MCP tool, and the dashboard's interactive visualization.

All graph queries are in `src/store/graph.ts`. The underlying data lives in three tables: `relationships`, `co_retrievals`, and the structural layer (`structural_nodes` + `structural_edges`).

---

## Data Model

### `relationships` Table

The primary curated-layer edge table. All edges between knowledge entries.

```sql
CREATE TABLE relationships (
  source_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN (
               'related_to', 'supersedes', 'contradicts',
               'depends_on', 'caused_by', 'imports_from', 'calls'
             )),
  strength   REAL NOT NULL DEFAULT 1.0,
  UNIQUE (source_id, target_id, type)
);
```

Edge types:
- `related_to` — generic association (most common)
- `supersedes` — this entry replaces another (used when a decision changes)
- `contradicts` — this entry conflicts with another (triggers `conflicted` status)
- `depends_on` — this entry's validity depends on another
- `caused_by` — this error was caused by the issue in another entry
- `imports_from` — structural: this file imports from that file
- `calls` — structural: this function calls that function

The `UNIQUE` constraint makes `createRelationship` idempotent — calling it multiple times with the same pair and type is safe via `INSERT OR IGNORE`.

### `co_retrievals` Table

Records how often two entries are returned together in a single search result:

```sql
CREATE TABLE co_retrievals (
  entry_a   TEXT NOT NULL,
  entry_b   TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (entry_a, entry_b),
  CHECK (entry_a < entry_b),
  FOREIGN KEY (entry_a) REFERENCES entries(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_b) REFERENCES entries(id) ON DELETE CASCADE
);
```

The `CHECK (entry_a < entry_b)` constraint enforces canonical ordering to prevent the same pair from appearing twice with reversed positions.

### `structural_nodes` Table

AST-derived nodes populated by the `gyst graphify` command. Distinct from the `entries` table — structural nodes are code symbols, not knowledge entries.

```sql
CREATE TABLE structural_nodes (
  id               TEXT NOT NULL PRIMARY KEY,
  label            TEXT NOT NULL,    -- e.g. "searchByBM25", "SearchStore"
  file_path        TEXT NOT NULL,
  file_type        TEXT,             -- e.g. "function", "class", "interface"
  source_location  TEXT,             -- e.g. "line:42"
  norm_label       TEXT,
  created_at       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  metadata         TEXT
);
```

### `structural_edges` Table

Edges between structural nodes — call graph, import graph:

```sql
CREATE TABLE structural_edges (
  source_id  TEXT NOT NULL REFERENCES structural_nodes(id) ON DELETE CASCADE,
  target_id  TEXT NOT NULL REFERENCES structural_nodes(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, relation)
);
```

---

## How Edges Are Built

### 1. Auto-linking on `learn` (Entity-Based)

When the `learn` tool stores a new entry, it immediately links it to existing entries sharing code entity tags. Entity tags are created by extracting code symbols from the entry's title and content during the learn pipeline (e.g., `entity:searchByBM25`).

For each extracted entity, a query finds other entries sharing that tag, and a `related_to` edge is created. Up to 20 links are created per new entry. This is the primary automatic linking mechanism for curated entries.

### 2. Phase 3 Bulk Linking (Self-Document)

`runSelfDocumentPhase3Link(db)` builds edges in bulk using SQL JOINs. Three strategies:

- **Structural ↔ MD doc** (strength 0.6): source file entries linked to documentation files sharing path components
- **MD doc ↔ MD doc** (strength 0.4): sibling documents in the same directory
- **Shared tags** (strength 0.4): curated entries sharing a tag, where the tag is used by fewer than 8 entries (prevents fan-out from overly common tags)

All inserts are `INSERT OR IGNORE`, making Phase 3 safe to re-run.

### 3. Co-Retrieval Promotion

Every `recall` and `search` call that returns 2+ results calls `recordCoRetrieval(db, entryIds)`. This upserts rows in `co_retrievals`. When `strengthenCoRetrievedLinks(db, threshold=3)` runs during consolidation, pairs with `count >= 3` are promoted to explicit `related_to` edges in `relationships`.

This creates a feedback loop: entries that are consistently retrieved together gradually become explicit graph neighbors.

### 4. Manual via `createRelationship`

`createRelationship(db, sourceId, targetId, type)` in `src/compiler/linker.ts` is the low-level edge creation function. It uses `INSERT OR IGNORE` and is idempotent. All other edge-building mechanisms call through this function.

---

## Graph Query API (`src/store/graph.ts`)

### `getNeighbors(db, entryId, limit=50): Subgraph`

Returns all entries one hop away from `entryId`. Traverses edges in both directions (as source or target). Returns a `Subgraph` with `nodes` and `edges` arrays. Only entries with `status = 'active'` are included.

### `getFileSubgraph(db, filePaths): Subgraph`

Seeds from entries associated with the given file paths, then includes their immediate relationship neighbors and all edges between the combined set. Used by the dashboard to show knowledge context around a specific file.

### `getClusters(db, minSize=2): readonly Subgraph[]`

Loads the full adjacency list and runs BFS to find connected components. Returns the top 20 components with at least `minSize` nodes, sorted by size descending.

### `findPath(db, fromId, toId, maxDepth=6): readonly string[]`

BFS shortest path between two entries. Traverses edges in both directions at each hop. Returns an ordered array of entry IDs, or an empty array if no path exists within `maxDepth`.

### `getHubs(db, limit=20): readonly (GraphNode & { degree: number })[]`

Ranks active entries by degree — the count of all relationship edges plus co-retrieval appearances. Both tables are unioned to produce a combined degree score per entry.

### `getFullGraph(db, maxNodes=500): Subgraph`

Returns a complete graph suitable for dashboard visualization. Curated entries are fetched first (up to `maxNodes`, ordered by confidence descending). Structural nodes fill any remaining budget. The `layer` field distinguishes `"curated"` from `"structural"`.

---

## GraphNode and GraphEdge Types

```typescript
interface GraphNode {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  layer?: "curated" | "structural";
  filePath?: string | null;    // structural nodes only
  metadata?: string | null;    // JSON blob with classifier trail
}

interface GraphEdge {
  source: string;
  target: string;
  type: string;         // relationship type
  strength: number;
  layer?: "curated" | "structural";
}
```

---

## Dashboard Visualization

The React dashboard fetches `getFullGraph()` via the `/api/graph` endpoint and renders it using a force-directed layout. Nodes are colored by `layer` and sized by `confidence`. The `metadata` field on `GraphNode` carries a `classifier` sub-object used to render the "Why?" trail — explaining how an entry was created and why it matters.
