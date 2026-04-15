/**
 * Graph query engine for the Gyst knowledge base.
 *
 * Provides functions for traversing the relationship graph between knowledge
 * entries, discovering clusters, finding paths, identifying hub nodes, and
 * recording co-retrieval patterns that strengthen implicit links over time.
 *
 * All queries are synchronous (bun:sqlite has no async API).
 */

import type { Database } from "bun:sqlite";
import { createRelationship } from "../compiler/linker.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A node in the knowledge graph, representing a single knowledge entry. */
export interface GraphNode {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
}

/** A directed edge between two knowledge entries. */
export interface GraphEdge {
  source: string;
  target: string;
  /** Relationship type from DB, or 'co_retrieved' for co-retrieval edges. */
  type: string;
  strength: number;
}

/** A subgraph consisting of a set of nodes and the edges between them. */
export interface Subgraph {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface NeighborRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  source_id: string;
  target_id: string;
  rel_type: string;
  strength: number;
}

interface EntryRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
}

interface RelRow {
  source_id: string;
  target_id: string;
  type: string;
  strength: number;
}

interface SeedRow {
  entry_id: string;
}

interface HubRow {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  scope: string;
  degree: number;
}

interface CoRow {
  entry_a: string;
  entry_b: string;
}

interface NeighborIdRow {
  neighbor: string;
}

// ---------------------------------------------------------------------------
// Helper: build an empty Subgraph
// ---------------------------------------------------------------------------

const EMPTY_SUBGRAPH: Subgraph = { nodes: [], edges: [] };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a one-hop subgraph centred on `entryId`.
 *
 * Fetches all active entries connected to `entryId` by a single relationship
 * edge (in either direction) and returns the node/edge set.
 *
 * @param db - Open database connection.
 * @param entryId - The entry to expand.
 * @param limit - Maximum number of neighbour rows to return (default 50).
 */
export function getNeighbors(
  db: Database,
  entryId: string,
  limit = 50,
): Subgraph {
  const rows = db
    .query<NeighborRow, [string, string, string, number]>(
      `SELECT
        e.id, e.type, e.title, e.content, e.confidence, e.scope,
        r.source_id, r.target_id, r.type AS rel_type, r.strength
      FROM relationships r
      JOIN entries e ON (
        CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END = e.id
      )
      WHERE (r.source_id = ? OR r.target_id = ?)
        AND r.source_id != r.target_id
        AND e.status = 'active'
      LIMIT ?`,
    )
    .all(entryId, entryId, entryId, limit);

  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const row of rows) {
    if (!nodeMap.has(row.id)) {
      nodeMap.set(row.id, {
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        confidence: row.confidence,
        scope: row.scope,
      });
    }
    edges.push({
      source: row.source_id,
      target: row.target_id,
      type: row.rel_type,
      strength: row.strength,
    });
  }

  logger.debug("getNeighbors", { entryId, nodes: nodeMap.size, edges: edges.length });

  return { nodes: Array.from(nodeMap.values()), edges };
}

/**
 * Returns a subgraph seeded by the entries associated with the given file paths.
 *
 * Finds all entries that reference any of the supplied paths, then returns
 * those entries plus their immediate relationship neighbours and the edges
 * between all of them.
 *
 * @param db - Open database connection.
 * @param filePaths - File paths to seed the subgraph from.
 */
export function getFileSubgraph(
  db: Database,
  filePaths: readonly string[],
): Subgraph {
  if (filePaths.length === 0) {
    return EMPTY_SUBGRAPH;
  }

  // Step 1: seed entry IDs
  const pathPlaceholders = filePaths.map(() => "?").join(", ");
  const seedRows = db
    .query<SeedRow, string[]>(
      `SELECT DISTINCT entry_id FROM entry_files WHERE file_path IN (${pathPlaceholders})`,
    )
    .all(...(filePaths as string[]));

  const seedIds = seedRows.map((r) => r.entry_id);
  if (seedIds.length === 0) {
    return EMPTY_SUBGRAPH;
  }

  // Step 2: relationships involving seeds
  const seedPlaceholders = seedIds.map(() => "?").join(", ");
  const relRows = db
    .query<RelRow, string[]>(
      `SELECT r.source_id, r.target_id, r.type, r.strength
       FROM relationships r
       WHERE r.source_id IN (${seedPlaceholders}) OR r.target_id IN (${seedPlaceholders})`,
    )
    .all(...seedIds, ...seedIds);

  // Step 3: collect all relevant entry IDs
  const allIdSet = new Set<string>(seedIds);
  for (const rel of relRows) {
    allIdSet.add(rel.source_id);
    allIdSet.add(rel.target_id);
  }

  const allIds = Array.from(allIdSet);
  const entryPlaceholders = allIds.map(() => "?").join(", ");
  const entryRows = db
    .query<EntryRow, string[]>(
      `SELECT id, type, title, content, confidence, scope FROM entries
       WHERE id IN (${entryPlaceholders}) AND status = 'active'`,
    )
    .all(...allIds);

  const nodes: GraphNode[] = entryRows.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    content: e.content,
    confidence: e.confidence,
    scope: e.scope,
  }));

  const edges: GraphEdge[] = relRows.map((r) => ({
    source: r.source_id,
    target: r.target_id,
    type: r.type,
    strength: r.strength,
  }));

  logger.debug("getFileSubgraph", { filePaths: filePaths.length, nodes: nodes.length, edges: edges.length });

  return { nodes, edges };
}

/**
 * Discovers connected components (clusters) in the full graph.
 *
 * Loads the entire adjacency list from the DB, runs BFS to find connected
 * components of active entries, and returns those with at least `minSize`
 * nodes, sorted by size descending, capped at 20.
 *
 * @param db - Open database connection.
 * @param minSize - Minimum component size to include (default 2).
 */
export function getClusters(
  db: Database,
  minSize = 2,
): readonly Subgraph[] {
  // Load all edges into a bidirectional adjacency map
  const allRels = db
    .query<RelRow, []>(
      "SELECT source_id, target_id, type, strength FROM relationships",
    )
    .all();

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };

  for (const rel of allRels) {
    addEdge(rel.source_id, rel.target_id);
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const startId of adjacency.keys()) {
    if (visited.has(startId)) continue;

    const component: string[] = [];
    const queue: string[] = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= minSize) {
      components.push(component);
    }
  }

  // Sort by size descending, cap at 20
  components.sort((a, b) => b.length - a.length);
  const topComponents = components.slice(0, 20);

  // Build a Subgraph for each component
  const subgraphs: Subgraph[] = [];

  for (const componentIds of topComponents) {
    const idSet = new Set(componentIds);
    const placeholders = componentIds.map(() => "?").join(", ");

    const entryRows = db
      .query<EntryRow, string[]>(
        `SELECT id, type, title, content, confidence, scope FROM entries
         WHERE id IN (${placeholders}) AND status = 'active'`,
      )
      .all(...componentIds);

    if (entryRows.length < minSize) continue;

    const activeIds = new Set(entryRows.map((e) => e.id));
    const componentEdges: GraphEdge[] = [];

    for (const rel of allRels) {
      if (
        idSet.has(rel.source_id) &&
        idSet.has(rel.target_id) &&
        activeIds.has(rel.source_id) &&
        activeIds.has(rel.target_id)
      ) {
        componentEdges.push({
          source: rel.source_id,
          target: rel.target_id,
          type: rel.type,
          strength: rel.strength,
        });
      }
    }

    const nodes: GraphNode[] = entryRows.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      content: e.content,
      confidence: e.confidence,
      scope: e.scope,
    }));

    subgraphs.push({ nodes, edges: componentEdges });
  }

  logger.debug("getClusters", { components: subgraphs.length });

  return subgraphs;
}

/**
 * Finds the shortest path between two entries using BFS.
 *
 * Traverses the relationship graph breadth-first from `fromId`, following
 * edges in either direction, up to `maxDepth` hops.
 *
 * @param db - Open database connection.
 * @param fromId - Starting entry ID.
 * @param toId - Target entry ID.
 * @param maxDepth - Maximum path length to explore (default 6).
 * @returns Ordered array of entry IDs `[fromId, ..., toId]`, or `[]` if
 *   no path is found within `maxDepth`.
 */
export function findPath(
  db: Database,
  fromId: string,
  toId: string,
  maxDepth = 6,
): readonly string[] {
  if (fromId === toId) return [fromId];

  const visited = new Set<string>([fromId]);
  const parent = new Map<string, string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: fromId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const neighborRows = db
      .query<NeighborIdRow, [string, string, string]>(
        `SELECT DISTINCT
          CASE WHEN source_id = ? THEN target_id ELSE source_id END AS neighbor
        FROM relationships
        WHERE source_id = ? OR target_id = ?`,
      )
      .all(current.id, current.id, current.id);

    for (const row of neighborRows) {
      const neighborId = row.neighbor;
      if (visited.has(neighborId)) continue;

      visited.add(neighborId);
      parent.set(neighborId, current.id);

      if (neighborId === toId) {
        // Reconstruct path
        const path: string[] = [toId];
        let node = toId;
        while (parent.has(node)) {
          node = parent.get(node)!;
          path.unshift(node);
        }
        return path;
      }

      queue.push({ id: neighborId, depth: current.depth + 1 });
    }
  }

  return [];
}

/**
 * Returns the most-connected entries in the graph (hubs).
 *
 * Counts both relationship edges and co-retrieval appearances. Useful for
 * surfacing central knowledge nodes.
 *
 * @param db - Open database connection.
 * @param limit - Maximum number of hubs to return (default 20).
 */
export function getHubs(
  db: Database,
  limit = 20,
): readonly (GraphNode & { degree: number })[] {
  const rows = db
    .query<HubRow, [number]>(
      `SELECT e.id, e.type, e.title, e.content, e.confidence, e.scope,
        COUNT(x.id) AS degree
      FROM entries e
      LEFT JOIN (
        SELECT source_id AS id FROM relationships
        UNION ALL
        SELECT target_id FROM relationships
        UNION ALL
        SELECT entry_a FROM co_retrievals
        UNION ALL
        SELECT entry_b FROM co_retrievals
      ) x ON x.id = e.id
      WHERE e.status = 'active'
      GROUP BY e.id
      ORDER BY degree DESC
      LIMIT ?`,
    )
    .all(limit);

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    content: r.content,
    confidence: r.confidence,
    scope: r.scope,
    degree: r.degree,
  }));
}

/**
 * Returns a subgraph of the highest-confidence active entries and the
 * relationships between them.
 *
 * Intended for dashboard or visualisation use where rendering every node
 * is impractical.
 *
 * @param db - Open database connection.
 * @param maxNodes - Maximum number of nodes to include (default 500).
 */
export function getFullGraph(
  db: Database,
  maxNodes = 500,
): Subgraph {
  const entryRows = db
    .query<EntryRow, [number]>(
      `SELECT id, type, title, content, confidence, scope
       FROM entries WHERE status = 'active'
       ORDER BY confidence DESC
       LIMIT ?`,
    )
    .all(maxNodes);

  if (entryRows.length === 0) {
    return EMPTY_SUBGRAPH;
  }

  const nodeIds = entryRows.map((e) => e.id);
  const idSet = new Set(nodeIds);
  const placeholders = nodeIds.map(() => "?").join(", ");

  const relRows = db
    .query<RelRow, string[]>(
      `SELECT source_id, target_id, type, strength
       FROM relationships
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    )
    .all(...nodeIds, ...nodeIds);

  const nodes: GraphNode[] = entryRows.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    content: e.content,
    confidence: e.confidence,
    scope: e.scope,
  }));

  // Only include edges where both endpoints are in our node set
  const edges: GraphEdge[] = relRows
    .filter((r) => idSet.has(r.source_id) && idSet.has(r.target_id))
    .map((r) => ({
      source: r.source_id,
      target: r.target_id,
      type: r.type,
      strength: r.strength,
    }));

  logger.debug("getFullGraph", { nodes: nodes.length, edges: edges.length });

  return { nodes, edges };
}

/**
 * Records that a set of entries were retrieved together in a single query.
 *
 * For every unique unordered pair in `entryIds`, upserts a row in the
 * co_retrievals table, incrementing the count on conflict. All upserts
 * run inside a single transaction.
 *
 * @param db - Open database connection.
 * @param entryIds - IDs of the entries returned in one recall result.
 */
export function recordCoRetrieval(
  db: Database,
  entryIds: readonly string[],
): void {
  if (entryIds.length < 2) return;

  const now = Date.now();

  db.transaction(() => {
    for (let i = 0; i < entryIds.length; i++) {
      for (let j = i + 1; j < entryIds.length; j++) {
        const a = entryIds[i]!;
        const b = entryIds[j]!;
        // Canonicalise so entry_a < entry_b (satisfies CHECK constraint)
        const [entry_a, entry_b] = a < b ? [a, b] : [b, a];

        db.run(
          `INSERT INTO co_retrievals(entry_a, entry_b, count, last_seen)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(entry_a, entry_b)
           DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`,
          [entry_a, entry_b, now],
        );
      }
    }
  })();

  logger.debug("recordCoRetrieval", { entryCount: entryIds.length });
}

/**
 * Promotes frequently co-retrieved entry pairs into explicit relationship edges.
 *
 * For every pair in co_retrievals whose count meets or exceeds `threshold`,
 * calls createRelationship to ensure a related_to edge exists in the
 * relationships table (idempotent via INSERT OR IGNORE).
 *
 * @param db - Open database connection.
 * @param threshold - Minimum co-retrieval count to create a relationship (default 3).
 * @returns The number of pairs processed.
 */
export function strengthenCoRetrievedLinks(
  db: Database,
  threshold = 3,
): number {
  const rows = db
    .query<CoRow, [number]>(
      "SELECT entry_a, entry_b FROM co_retrievals WHERE count >= ?",
    )
    .all(threshold);

  for (const row of rows) {
    createRelationship(db, row.entry_a, row.entry_b, "related_to");
  }

  logger.debug("strengthenCoRetrievedLinks", { processed: rows.length, threshold });

  return rows.length;
}
