/**
 * Graphify Transformer.
 *
 * Imports AST-derived structural knowledge from Graphify's `graph.json` into
 * the ADJACENT structural_nodes / structural_edges index. Deliberately kept
 * out of the curated `entries` table so deterministic AST data never pollutes
 * retrieval, FTS, or the dashboard's curated-knowledge views.
 *
 * The structural index is rebuildable — this transformer is an upsert path,
 * and dropping it loses nothing that re-running graphify cannot restore.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

interface GraphifyNode {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  norm_label?: string;
}

interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  weight?: number;
  confidence_score?: number;
}

interface GraphifyData {
  nodes: GraphifyNode[];
  links: GraphifyLink[];
}

export interface TransformReport {
  nodesImported: number;
  linksImported: number;
}

/**
 * Reads Graphify's output and upserts it into the adjacent structural index.
 */
export function transformGraphify(
  db: Database,
  outputDir: string = "graphify-out",
): TransformReport {
  const jsonPath = join(outputDir, "graph.json");

  if (!existsSync(jsonPath)) {
    logger.warn("graphify-transformer: graph.json not found", { jsonPath });
    return { nodesImported: 0, linksImported: 0 };
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8")) as GraphifyData;
  const now = new Date().toISOString();

  let nodesImported = 0;
  let linksImported = 0;

  db.transaction(() => {
    for (const node of data.nodes) {
      db.run(
        `INSERT INTO structural_nodes
           (id, label, file_path, file_type, source_location, norm_label,
            created_at, last_seen, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           file_path = excluded.file_path,
           file_type = excluded.file_type,
           source_location = excluded.source_location,
           norm_label = excluded.norm_label,
           last_seen = excluded.last_seen`,
        [
          node.id,
          node.label,
          node.source_file,
          node.file_type,
          node.source_location ?? null,
          node.norm_label ?? null,
          now,
          now,
        ],
      );
      nodesImported += 1;
    }

    for (const link of data.links) {
      try {
        db.run(
          `INSERT INTO structural_edges (source_id, target_id, relation, weight)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_id, target_id, relation) DO UPDATE SET
             weight = excluded.weight`,
          [
            link.source,
            link.target,
            link.relation,
            link.weight ?? link.confidence_score ?? 1.0,
          ],
        );
        linksImported += 1;
      } catch (err) {
        // Skip edges whose endpoints are missing (referential integrity).
        logger.debug("graphify-transformer: skipping link", {
          source: link.source,
          target: link.target,
          error: String(err),
        });
      }
    }
  })();

  return { nodesImported, linksImported };
}
