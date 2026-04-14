/**
 * The `graph` MCP tool — read-only inspection of the knowledge graph.
 *
 * Exposes five graph traversal operations as a single action-discriminated
 * tool. Useful for understanding how knowledge entries relate to each other,
 * finding clusters of related concepts, locating central hub entries, and
 * tracing paths between distant nodes.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../register-tools.js";
import {
  getNeighbors,
  getFileSubgraph,
  getClusters,
  findPath,
  getHubs,
} from "../../store/graph.js";
import { fetchEntriesByIds } from "../../store/entries.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const GraphInput = z.object({
  action: z.enum(["neighbors", "subgraph", "clusters", "hubs", "path"]),
  // neighbors
  entry_id: z.string().optional(),
  depth: z.number().int().min(1).max(3).optional(),
  // subgraph
  file_path: z.string().optional(),
  // hubs
  limit: z.number().int().min(1).max(50).optional(),
  // path
  from: z.string().optional(),
  to: z.string().optional(),
  // team scoping (reserved for future use)
  developer_id: z.string().optional(),
});

type GraphInputType = z.infer<typeof GraphInput>;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a subgraph rooted on a specific entry as a compact plain-text block.
 * Used by the "neighbors" action.
 */
function formatNeighbors(
  centerId: string,
  centerTitle: string,
  subgraph: { nodes: readonly { id: string; title: string; type: string }[]; edges: readonly { source: string; target: string; type: string }[] },
): string {
  const lines: string[] = [];
  lines.push(`Entry: ${centerTitle} (${centerId})`);
  lines.push(`Neighbors (depth 1): ${subgraph.nodes.length} entries`);

  for (const node of subgraph.nodes) {
    // Find the edge that connects this node to the center
    const edge = subgraph.edges.find(
      (e) =>
        (e.source === centerId && e.target === node.id) ||
        (e.target === centerId && e.source === node.id),
    );
    const relType = edge?.type ?? "related_to";
    lines.push(`  • ${node.title} (${node.id}) — ${relType}`);
  }

  lines.push(`Edges: ${subgraph.edges.length}`);
  return lines.join("\n");
}

/**
 * Formats a file subgraph as a compact plain-text block.
 * Used by the "subgraph" action.
 */
function formatSubgraph(
  filePath: string,
  subgraph: { nodes: readonly { id: string; title: string; type: string }[]; edges: readonly { source: string; target: string; type: string }[] },
): string {
  const lines: string[] = [];
  lines.push(`Subgraph for: ${filePath}`);
  lines.push(`Nodes: ${subgraph.nodes.length}`);

  for (const node of subgraph.nodes) {
    lines.push(`  • ${node.title} (${node.id}) [${node.type}]`);
  }

  lines.push(`Edges: ${subgraph.edges.length}`);
  for (const edge of subgraph.edges) {
    lines.push(`  ${edge.source} → ${edge.target} [${edge.type}]`);
  }

  return lines.join("\n");
}

/**
 * Formats cluster discovery results as a compact plain-text block.
 * Returns up to 10 clusters with the top-5 node titles each.
 */
function formatClusters(
  clusters: readonly { nodes: readonly { id: string; title: string }[]; edges: readonly unknown[] }[],
): string {
  const top = clusters.slice(0, 10);
  const lines: string[] = [];
  lines.push(`Clusters found: ${top.length}`);

  for (let i = 0; i < top.length; i++) {
    const cluster = top[i]!;
    lines.push(`\nCluster ${i + 1} — ${cluster.nodes.length} nodes, ${cluster.edges.length} edges`);
    const topNodes = cluster.nodes.slice(0, 5);
    for (const node of topNodes) {
      lines.push(`  • ${node.title} (${node.id})`);
    }
    if (cluster.nodes.length > 5) {
      lines.push(`  … and ${cluster.nodes.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Formats hub entries as a ranked plain-text list.
 */
function formatHubs(
  hubs: readonly { id: string; title: string; type: string; degree: number }[],
): string {
  const lines: string[] = [];
  lines.push(`Top ${hubs.length} hub entries:`);

  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i]!;
    lines.push(`  ${i + 1}. ${hub.title} (${hub.id}) [${hub.type}] — ${hub.degree} connections`);
  }

  return lines.join("\n");
}

/**
 * Formats a path between two entries as an ordered list of titles.
 */
function formatPath(
  pathIds: readonly string[],
  idToTitle: Map<string, string>,
): string {
  if (pathIds.length === 0) {
    return "No path found between the specified entries.";
  }

  const lines: string[] = [];
  lines.push(`Path found: ${pathIds.length} hops`);

  for (let i = 0; i < pathIds.length; i++) {
    const id = pathIds[i]!;
    const title = idToTitle.get(id) ?? id;
    const arrow = i < pathIds.length - 1 ? " →" : "";
    lines.push(`  ${i + 1}. ${title} (${id})${arrow}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public registration function
// ---------------------------------------------------------------------------

/**
 * Registers the `graph` tool on the given MCP server.
 *
 * Exposes read-only graph traversal operations: neighbor expansion, file
 * subgraph, cluster discovery, hub ranking, and shortest-path finding.
 * All operations are synchronous under the hood (bun:sqlite has no async API).
 *
 * @param server - The McpServer instance to register on.
 * @param ctx    - Tool context containing db, mode, and optional team identifiers.
 */
export function registerGraphTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;

  server.tool(
    "graph",
    "Inspect the knowledge graph. Actions: neighbors (expand an entry's connections), subgraph (entries related to a file path), clusters (find connected components), hubs (most-connected entries), path (shortest path between two entries).",
    GraphInput.shape,
    async (input: GraphInputType) => {
      logger.info("graph tool called", { action: input.action });

      let result: { content: { type: "text"; text: string }[] };

      try {
        switch (input.action) {
          case "neighbors": {
            if (!input.entry_id) {
              result = {
                content: [
                  {
                    type: "text" as const,
                    text: 'Action "neighbors" requires entry_id.',
                  },
                ],
              };
              break;
            }

            // Depth maps to a row limit: depth 1 → 50 rows, 2 → 100, 3 → 150
            const rowLimit = (input.depth ?? 1) * 50;
            const subgraph = getNeighbors(db, input.entry_id, rowLimit);

            // Look up the center entry's title
            const centerEntries = fetchEntriesByIds(db, [input.entry_id]);
            const centerTitle =
              centerEntries[0]?.title ?? input.entry_id;

            logger.debug("graph neighbors result", {
              entryId: input.entry_id,
              nodes: subgraph.nodes.length,
              edges: subgraph.edges.length,
            });

            result = {
              content: [
                {
                  type: "text" as const,
                  text: formatNeighbors(input.entry_id, centerTitle, subgraph),
                },
              ],
            };
            break;
          }

          case "subgraph": {
            if (!input.file_path) {
              result = {
                content: [
                  {
                    type: "text" as const,
                    text: 'Action "subgraph" requires file_path.',
                  },
                ],
              };
              break;
            }

            const subgraph = getFileSubgraph(db, [input.file_path]);

            logger.debug("graph subgraph result", {
              filePath: input.file_path,
              nodes: subgraph.nodes.length,
              edges: subgraph.edges.length,
            });

            result = {
              content: [
                {
                  type: "text" as const,
                  text: formatSubgraph(input.file_path, subgraph),
                },
              ],
            };
            break;
          }

          case "clusters": {
            const clusters = getClusters(db);

            logger.debug("graph clusters result", {
              total: clusters.length,
            });

            result = {
              content: [
                {
                  type: "text" as const,
                  text: formatClusters(clusters),
                },
              ],
            };
            break;
          }

          case "hubs": {
            const hubs = getHubs(db, input.limit ?? 10);

            logger.debug("graph hubs result", { count: hubs.length });

            result = {
              content: [
                {
                  type: "text" as const,
                  text: formatHubs(hubs),
                },
              ],
            };
            break;
          }

          case "path": {
            if (!input.from || !input.to) {
              result = {
                content: [
                  {
                    type: "text" as const,
                    text: 'Action "path" requires both from and to entry IDs.',
                  },
                ],
              };
              break;
            }

            const pathIds = findPath(db, input.from, input.to);

            // Resolve titles for all IDs in the path
            const idToTitle = new Map<string, string>();
            if (pathIds.length > 0) {
              const entries = fetchEntriesByIds(db, [...pathIds]);
              for (const entry of entries) {
                idToTitle.set(entry.id, entry.title);
              }
            }

            logger.debug("graph path result", {
              from: input.from,
              to: input.to,
              hops: pathIds.length,
            });

            result = {
              content: [
                {
                  type: "text" as const,
                  text: formatPath(pathIds, idToTitle),
                },
              ],
            };
            break;
          }

          default: {
            // TypeScript exhaustiveness — action enum covers all cases above
            const _exhaustive: never = input.action;
            result = {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown action: ${String(_exhaustive)}`,
                },
              ],
            };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("graph tool error", { action: input.action, error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: `Graph operation failed: ${message}`,
            },
          ],
        };
      }

      if (ctx.mode === "team") {
        const { logActivity } = await import("../../server/activity.js");
        logActivity(db, ctx.teamId!, ctx.developerId!, "graph");
      }

      return result;
    },
  );
}
