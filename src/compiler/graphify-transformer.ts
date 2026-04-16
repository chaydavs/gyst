/**
 * Graphify Transformer.
 *
 * Imports structural knowledge from Graphify's `graph.json` into the Gyst 
 * knowledge base. This bridges deterministic AST-based code maps with Gyst's 
 * interaction-based knowledge.
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
 * Reads Graphify's output and upserts it into the Gyst database.
 */
export function transformGraphify(db: Database, outputDir: string = "graphify-out"): TransformReport {
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
    // 1. Import Nodes
    for (const node of data.nodes) {
      db.run(
        `INSERT INTO entries (
          id, type, title, content, file_path, confidence, 
          created_at, last_confirmed, status, scope, source_tool
        ) VALUES (?, 'structural', ?, ?, ?, ?, ?, ?, 'active', 'project', 'graphify')
        ON CONFLICT(id) DO UPDATE SET
          last_confirmed = excluded.last_confirmed,
          title = excluded.title,
          file_path = excluded.file_path`,
        [
          node.id,
          node.label,
          `Structural element in ${node.source_file}${node.source_location ? ` at ${node.source_location}` : ""}`,
          node.source_file,
          1.0, // AST extraction is 100% confident
          now,
          now,
        ]
      );

      // Associated file path
      db.run(
        "INSERT OR IGNORE INTO entry_files (entry_id, file_path) VALUES (?, ?)",
        [node.id, node.source_file]
      );

      // Norm label as tag
      if (node.norm_label) {
        db.run(
          "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)",
          [node.id, node.norm_label.replace(/[()]/g, "")]
        );
      }
      
      nodesImported++;
    }

    // 2. Import Links
    for (const link of data.links) {
      try {
        // Validate relation type against Gyst's allowed types
        // Graphify uses 'imports_from', 'calls', etc.
        const type = mapRelationType(link.relation);
        
        db.run(
          `INSERT INTO relationships (source_id, target_id, type, strength)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_id, target_id, type) DO UPDATE SET
             strength = excluded.strength`,
          [
            link.source,
            link.target,
            type,
            link.weight ?? link.confidence_score ?? 1.0
          ]
        );
        linksImported++;
      } catch (err) {
        // Skip if referential integrity or check constraint fails (e.g. missing node)
        logger.debug("graphify-transformer: skipping link", { 
          source: link.source, 
          target: link.target, 
          error: String(err) 
        });
      }
    }
  })();

  return { nodesImported, linksImported };
}

/**
 * Maps Graphify relationship types to Gyst's allowed relationship types.
 */
function mapRelationType(graphifyType: string): string {
  const allowed = ['related_to', 'supersedes', 'contradicts', 'depends_on', 'caused_by', 'imports_from', 'calls'];
  
  if (allowed.includes(graphifyType)) {
    return graphifyType;
  }
  
  // Mapping logic
  if (graphifyType === 'defined_in') return 'related_to';
  
  return 'related_to'; // Fallback
}
