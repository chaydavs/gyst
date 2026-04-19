import type { Database } from "bun:sqlite";

/**
 * A knowledge entry ranked by its degree centrality in the relationship graph.
 */
export interface CentralNode {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly type: string;
  readonly degree: number;
}

/**
 * Computes degree centrality for all active non-ghost entries.
 *
 * Degree is the sum of:
 *   - outgoing relationship edges (source_id)
 *   - incoming relationship edges (target_id)
 *   - co-retrieval links (entry_a or entry_b, summed counts)
 *
 * Returns a Map<entryId, degree> for all qualifying entries.
 * Entries with zero connections are included with degree 0 so callers
 * can reason about isolated nodes too.
 */
export function computeDegreeCentrality(db: Database): Map<string, number> {
  const rows = db
    .query<{ id: string; degree: number }, []>(
      `SELECT e.id,
              COALESCE(out_c.c, 0) + COALESCE(in_c.c, 0) + COALESCE(co.c, 0) AS degree
       FROM entries e
       LEFT JOIN (
         SELECT source_id AS id, COUNT(*) AS c
         FROM relationships
         GROUP BY source_id
       ) out_c ON out_c.id = e.id
       LEFT JOIN (
         SELECT target_id AS id, COUNT(*) AS c
         FROM relationships
         GROUP BY target_id
       ) in_c ON in_c.id = e.id
       LEFT JOIN (
         SELECT id, SUM(c) AS c FROM (
           SELECT entry_a AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_a
           UNION ALL
           SELECT entry_b AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_b
         ) GROUP BY id
       ) co ON co.id = e.id
       WHERE e.type NOT IN ('ghost_knowledge') AND e.status = 'active'`,
    )
    .all();

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.id, row.degree);
  }
  return result;
}

/**
 * Returns the top N entries by degree centrality, excluding ghost_knowledge
 * and md_doc types, and skipping entries that already have a ghost knowledge
 * entry referencing them (detected via metadata LIKE '%<id>%').
 *
 * Useful for identifying hub-like nodes that are candidates for auto-generated
 * ghost knowledge entries in the self-documenting KB pipeline.
 */
export function getTopCentralNodes(db: Database, n: number): CentralNode[] {
  return db
    .query<CentralNode, [number]>(
      `SELECT e.id, e.title, e.content, e.type,
              COALESCE(out_c.c, 0) + COALESCE(in_c.c, 0) + COALESCE(co.c, 0) AS degree
       FROM entries e
       LEFT JOIN (
         SELECT source_id AS id, COUNT(*) AS c
         FROM relationships
         GROUP BY source_id
       ) out_c ON out_c.id = e.id
       LEFT JOIN (
         SELECT target_id AS id, COUNT(*) AS c
         FROM relationships
         GROUP BY target_id
       ) in_c ON in_c.id = e.id
       LEFT JOIN (
         SELECT id, SUM(c) AS c FROM (
           SELECT entry_a AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_a
           UNION ALL
           SELECT entry_b AS id, SUM(count) AS c FROM co_retrievals GROUP BY entry_b
         ) GROUP BY id
       ) co ON co.id = e.id
       WHERE e.type NOT IN ('ghost_knowledge', 'md_doc')
         AND e.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM entries g
           WHERE g.type = 'ghost_knowledge'
             AND g.metadata LIKE '%' || e.id || '%'
         )
       ORDER BY degree DESC
       LIMIT ?`,
    )
    .all(n);
}
