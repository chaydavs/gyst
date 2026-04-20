/**
 * `gyst privacy` — switch knowledge-base privacy modes after install.
 *
 * Modes mirror the install-time scope-selection prompt (ARCHITECTURE.md §3):
 *   - local         — wiki dir inside the project.
 *   - private-repo  — wiki dir points at a sibling private repo.
 *   - http-server   — agents talk to a shared HTTP server; no local wiki writes.
 *
 * Switching modes does NOT migrate existing data — that's the job of a future
 * `gyst privacy migrate`. This command only rewrites config + MCP plumbing so
 * new writes land in the right place.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../utils/config.js";
import {
  detectTools,
  ensureGitignore,
  writeProjectConfig,
  writeHttpMcpConfig,
  mergeGystMcpEntry,
  mergeGystVSCodeEntry,
} from "./install.js";
import { readFileSync, writeFileSync } from "node:fs";
import { logger } from "../utils/logger.js";

export type PrivacyMode = "local" | "private-repo" | "http-server";

/** Prints the currently configured privacy mode + the paths that back it. */
export async function showPrivacyMode(): Promise<void> {
  const cfg = loadConfig();
  const mode = cfg.privacyMode ?? "local";
  process.stdout.write(`\n  Privacy mode: ${mode}\n`);
  process.stdout.write(`  Wiki dir:     ${cfg.wikiDir}\n`);
  process.stdout.write(`  Database:     ${cfg.dbPath}\n`);
  if (mode === "http-server") {
    process.stdout.write(`  Server URL:   ${cfg.serverUrl ?? "(unset)"}\n`);
  }
  process.stdout.write(`\n  Switch mode:\n`);
  process.stdout.write(`    gyst privacy local\n`);
  process.stdout.write(`    gyst privacy wiki <path>\n`);
  process.stdout.write(`    gyst privacy server <url> <memberKey>\n\n`);
}

/**
 * Switch to Path 1 — local only.
 *
 * Rewrites every detected tool's MCP config back to the stdio entry, restores
 * `wikiDir` to the default `gyst-wiki/`, and re-runs the .gitignore ensurer.
 */
export async function switchToLocal(): Promise<void> {
  const cfg = loadConfig();
  const projectRoot = cfg.dbPath.replace(/[\\/]\.gyst[\\/].*$/, "");

  // Reset MCP config on every detected tool to the stdio entry.
  for (const tool of detectTools().filter((t) => t.detected)) {
    if (!existsSync(tool.configPath)) continue;
    try {
      const raw = readFileSync(tool.configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const next =
        tool.name === "VS Code" ? mergeGystVSCodeEntry(parsed) : mergeGystMcpEntry(parsed);
      writeFileSync(tool.configPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
    } catch (err) {
      logger.warn("privacy: could not rewrite MCP config", { tool: tool.name, err });
    }
  }

  writeProjectConfig(projectRoot, { privacyMode: "local", wikiDir: "gyst-wiki" });
  mkdirSync(join(projectRoot, "gyst-wiki"), { recursive: true });
  const added = ensureGitignore(projectRoot);
  process.stdout.write(`\n  ✓ Switched to local-only mode.\n`);
  if (added.length > 0) {
    process.stdout.write(`    Added to .gitignore: ${added.join(", ")}\n`);
  }
  process.stdout.write(`    Restart your AI tool to pick up the new MCP config.\n\n`);
}

/**
 * Switch to Path 2 — wiki dir lives in a sibling private repo.
 *
 * Creates the target dir if it does not exist. Does not move existing markdown
 * — new writes simply land at the new location.
 */
export async function switchToPrivateRepo(wikiPath: string): Promise<void> {
  const cfg = loadConfig();
  const projectRoot = cfg.dbPath.replace(/[\\/]\.gyst[\\/].*$/, "");

  const resolved =
    wikiPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(wikiPath)
      ? wikiPath
      : join(projectRoot, wikiPath);

  mkdirSync(resolved, { recursive: true });
  writeProjectConfig(projectRoot, { privacyMode: "private-repo", wikiDir: resolved });

  process.stdout.write(`\n  ✓ Switched to private-repo mode.\n`);
  process.stdout.write(`    Wiki dir → ${resolved}\n`);
  process.stdout.write(`    Initialise the target as a git repo if you haven't already:\n`);
  process.stdout.write(`      cd "${resolved}" && git init && git remote add origin <your-private-repo>\n\n`);
}

/**
 * Switch to Path 3 — point every detected tool's MCP client at a shared HTTP
 * server and stop writing wiki markdown locally.
 */
export async function switchToHttpServer(
  serverUrl: string,
  memberKey: string,
): Promise<void> {
  const cfg = loadConfig();
  const projectRoot = cfg.dbPath.replace(/[\\/]\.gyst[\\/].*$/, "");

  const configured = writeHttpMcpConfig(serverUrl, memberKey);
  writeProjectConfig(projectRoot, {
    privacyMode: "http-server",
    serverUrl: serverUrl.replace(/\/$/, ""),
  });

  process.stdout.write(`\n  ✓ Switched to HTTP-server mode.\n`);
  if (configured.length > 0) {
    process.stdout.write(`    Reconfigured MCP: ${configured.join(", ")}\n`);
  }
  process.stdout.write(`    Add to your shell: export GYST_API_KEY="${memberKey}"\n`);
  process.stdout.write(`    Restart your AI tool to activate.\n\n`);
}
