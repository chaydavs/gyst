#!/usr/bin/env bun

// Fail fast when run under Node.js (e.g. npx without Bun on PATH).
if (!(process.versions as Record<string, string>)["bun"]) {
  process.stderr.write(
    "Gyst requires the Bun runtime — it uses bun:sqlite and Bun APIs.\n" +
      "Install Bun: curl -fsSL https://bun.sh/install | bash\n",
  );
  process.exit(1);
}

/**
 * Gyst CLI entry point.
 */

import { Command } from "commander";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { delimiter as PATH_DELIM } from "node:path";
// @ts-ignore — JSON import resolved by Bun bundler; string fallback for dev mode
import _pkg from "../../package.json" with { type: "json" };
const _pkgVersion: string = (typeof _pkg === "object" && _pkg !== null && "version" in _pkg)
  ? String((_pkg as { version: string }).version)
  : "0.0.0";
import { initDatabase } from "../store/database.js";
import { installForDetectedTools } from "../mcp/installer.js";
import { logger } from "../utils/logger.js";
import { findAllProjects, findProjectRoot, loadConfig } from "../utils/config.js";
import { NoProjectError } from "../utils/errors.js";

// Print NoProjectError's friendly message on any unhandled path instead of
// letting Bun emit a full stack trace. Action handlers that already wrap
// loadConfig() in try/catch will surface the same message through their
// own error branch — this is the backstop for actions that don't.
function handleCliError(err: unknown): never {
  if (err instanceof NoProjectError) {
    process.stderr.write(`\nError: ${err.message}\n\n`);
    process.exit(1);
  }
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`\nUnexpected error: ${msg}\n`);
  process.exit(1);
}
process.on("uncaughtException", handleCliError);
process.on("unhandledRejection", handleCliError);
import { addManualEntry } from "../capture/manual.js";
import {
  createTeam,
  createInviteKey,
  joinTeam,
  initTeamSchema,
} from "../server/auth.js";
import { initActivitySchema } from "../server/activity.js";
import { getTeamMembers } from "../server/team.js";
import { EventType, emitEvent, normaliseHookPayload } from "../store/events.js";

const WIKI_SUBDIRS = [
  "error_pattern",
  "convention",
  "decision",
  "learning",
  "ghost_knowledge",
] as const;

const VALID_ENTRY_TYPES = [
  "error_pattern",
  "convention",
  "decision",
  "learning",
] as const;

type EntryType = typeof VALID_ENTRY_TYPES[number];

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

const detectConventionsAction = async (dir: string | undefined, options: { dryRun?: boolean }) => {
  try {
    const targetDir = dir ?? process.cwd();
    const isDryRun = options.dryRun === true;
    const { detectConventions } = await import("../compiler/detect-conventions.js");
    process.stdout.write(`Scanning for conventions in: ${targetDir}\n`);
    if (isDryRun) process.stdout.write("(dry-run mode — nothing will be saved)\n");
    process.stdout.write("\n");
    const conventions = await detectConventions(targetDir);
    if (conventions.length === 0) {
      process.stdout.write("No conventions detected.\n");
      return;
    }
    process.stdout.write(`Found ${conventions.length} convention(s):\n`);
    for (const c of conventions) {
      process.stdout.write(`  ${c.category.padEnd(14)} ${c.directory.padEnd(24)} ${c.pattern.padEnd(36)} (${(c.confidence * 100).toFixed(0)}%)\n`);
    }
    process.stdout.write("\n");
    if (isDryRun) return;
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const { storeDetectedConventions } = await import("../compiler/store-conventions.js");
    const stored = await storeDetectedConventions(db, conventions);
    db.close();
    process.stdout.write(`Stored ${stored} convention(s) to knowledge base.\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
};

const checkConventionsAction = async (file: string | undefined) => {
  try {
    const targetPath = file ?? process.cwd();
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const rows = db.query<{ id: string; title: string; confidence: number }, [string]>(
      `SELECT DISTINCT e.id, e.title, e.confidence FROM entries e JOIN entry_files ef ON ef.entry_id = e.id WHERE e.type = 'convention' AND e.status = 'active' AND ? LIKE ef.file_path || '%' ORDER BY e.confidence DESC LIMIT 10`,
    ).all(targetPath);
    db.close();
    process.stdout.write(`Conventions for ${targetPath}:\n\n`);
    if (rows.length === 0) {
      process.stdout.write("No conventions found for this path.\n");
      return;
    }
    for (const row of rows) {
      process.stdout.write(`  ${row.title.padEnd(48)} (${(row.confidence * 100).toFixed(0)}%)\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
};

const searchAction = async (query: string, options: { type: string; max: string }) => {
  try {
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const maxResults = parseInt(options.max, 10);
    const { searchByBM25, reciprocalRankFusion } = await import("../store/search.js");
    const { fetchEntriesByIds } = await import("../store/entries.js");
    const typeFilter = options.type === "all" ? undefined : options.type;
    const bm25Results = searchByBM25(db, query, typeFilter);
    const fused = reciprocalRankFusion([bm25Results]);
    const topResults = fused.slice(0, maxResults);

    if (topResults.length === 0) {
      db.close();
      process.stdout.write(`No results found for: "${query}"\n`);
      return;
    }

    const entries = fetchEntriesByIds(db, topResults.map((r) => r.id));
    const byId = new Map(entries.map((e) => [e.id, e]));
    db.close();

    process.stdout.write(`Found ${topResults.length} result(s) for: "${query}"\n\n`);
    for (const [index, result] of topResults.entries()) {
      const entry = byId.get(result.id);
      const rank = (index + 1).toString().padStart(2);
      if (!entry) {
        process.stdout.write(`${rank}. (entry ${result.id} not visible)\n\n`);
        continue;
      }
      const score = result.score.toFixed(3);
      const conf = (entry.confidence * 100).toFixed(0);
      process.stdout.write(
        `${rank}. ${entry.title}\n` +
          `    ${entry.type}  score ${score}  confidence ${conf}%  [${result.source}]\n`,
      );
      const snippet = entry.content.replace(/\s+/g, " ").trim().slice(0, 160);
      if (snippet.length > 0) {
        process.stdout.write(
          `    ${snippet}${entry.content.length > 160 ? "…" : ""}\n`,
        );
      }
      process.stdout.write(`    id: ${entry.id}\n\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
};

const serveAction = async () => {
  await import("../mcp/server.js");
};

/**
 * Reads a JSON payload from stdin when stdin is piped.
 * Returns an empty object if stdin is a TTY or empty — preserves backward
 * compatibility with callers that still pass payload as a positional arg.
 */
function readStdinPayloadSync(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  try {
    // fd 0 is stdin; readFileSync blocks until EOF so it's safe in a short-lived CLI.
    const raw = require("node:fs").readFileSync(0, "utf8") as string;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const emitAction = async (type: string, payload: string | undefined) => {
  try {
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    let parsedPayload: Record<string, unknown> = {};
    if (payload) {
      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        parsedPayload = { raw: payload };
      }
    } else {
      // No positional payload — try stdin (hook scripts pipe Claude Code JSON here).
      parsedPayload = readStdinPayloadSync();
    }
    const normalised = normaliseHookPayload(type, parsedPayload);
    emitEvent(db, type as EventType, normalised);
    db.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
};

const setupAction = async () => {
  try {
    const cwd = process.cwd();
    // Refuse to silently create a nested knowledge base when an ancestor
    // project already exists. --minimal is non-interactive by design, so
    // the safe default is to refuse and point the user at the existing one.
    // Users who genuinely want a nested project can set GYST_FORCE_NESTED=1
    // or re-run without --minimal to get the interactive prompt.
    const cwdHasGyst = existsSync(join(cwd, ".gyst"));
    if (!cwdHasGyst) {
      const ancestorRoot = findProjectRoot(cwd);
      if (ancestorRoot && ancestorRoot !== cwd && !process.env["GYST_FORCE_NESTED"]) {
        process.stdout.write(
          `\n  ⚠  A Gyst project already exists at: ${ancestorRoot}\n` +
            `     Refusing to create a nested project from --minimal (non-interactive).\n` +
            `     - To use the existing one: run 'gyst' commands from any subfolder (no install needed).\n` +
            `     - To force a nested project: re-run without --minimal, or set GYST_FORCE_NESTED=1.\n\n`,
        );
        return;
      }
    }
    // Create .gyst/ before loading config so loadConfig() can resolve the
    // project root to cwd on a fresh install.
    const { initProject } = await import("./install.js");
    initProject(cwd);
    const config = loadConfig(cwd);
    process.stdout.write("Setting up gyst-wiki directory structure...\n");
    if (!existsSync(config.wikiDir)) {
      mkdirSync(config.wikiDir, { recursive: true });
    }
    for (const sub of WIKI_SUBDIRS) {
      const dir = join(config.wikiDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    process.stdout.write(`  wiki dir : ${config.wikiDir}\n`);
    const db = initDatabase(config.dbPath);
    db.close();
    process.stdout.write(`  database : ${config.dbPath}\n`);
    const installed = installForDetectedTools(process.cwd());
    for (const tool of installed) process.stdout.write(`  configured: ${tool}\n`);
    const { installGitHooks } = await import("./install.js");
    const gitResult = installGitHooks(process.cwd());
    if (!gitResult.noGit) {
      const done = [...gitResult.installed, ...gitResult.skipped.map((f) => `${f} (already set)`)];
      process.stdout.write(`  hooks: ${done.join(", ")}\n`);
    }
    logger.info("Gyst setup completed successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`\nSetup failed: ${message}\n`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// Team Helpers
// ---------------------------------------------------------------------------

function openTeamDb() {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  initTeamSchema(db);
  initActivitySchema(db);
  return db;
}

async function resolveTeamFromEnv(db: any): Promise<string> {
  const rawKey = process.env["GYST_API_KEY"];
  if (!rawKey) {
    process.stdout.write("Error: GYST_API_KEY is not set.\n");
    process.exit(1);
  }
  const rows = db.query("SELECT key_hash, team_id FROM api_keys WHERE revoked = 0").all();
  for (const row of rows) {
    try {
      if (await Bun.password.verify(rawKey, row.key_hash)) return row.team_id;
    } catch {
      // legacy row with non-bcrypt hash — skip it
    }
  }
  process.stdout.write("Error: GYST_API_KEY is invalid.\n");
  process.exit(1);
}

const createTeamAction = (name: string) => {
  try {
    const db = openTeamDb();
    const { teamId, adminKey } = createTeam(db, name.trim());
    db.close();
    const bar = "─".repeat(56);
    process.stdout.write(`\n  ${bar}\n`);
    process.stdout.write(`  ✓ Team "${name.trim()}" created\n\n`);
    process.stdout.write(`  Team ID:   ${teamId}\n`);
    process.stdout.write(`  Admin key: ${adminKey}\n\n`);
    process.stdout.write(`  Add to your shell:\n`);
    process.stdout.write(`    export GYST_API_KEY="${adminKey}"\n\n`);
    process.stdout.write(`  Next — start the shared server and invite teammates:\n`);
    process.stdout.write(`    gyst serve --http --port 3456\n`);
    process.stdout.write(`    GYST_API_KEY="${adminKey}" gyst team invite\n`);
    process.stdout.write(`  ${bar}\n\n`);
  } catch (err) {
    process.stdout.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
};

const inviteTeamAction = async () => {
  try {
    const db = openTeamDb();
    const teamId = await resolveTeamFromEnv(db);
    const inviteKey = createInviteKey(db, teamId);

    // Look up the team name for display purposes.
    const teamRow = db
      .query<{ name: string }, [string]>("SELECT name FROM teams WHERE id = ?")
      .get(teamId);
    const teamName = teamRow?.name ?? teamId;
    db.close();

    // Server URL hint — use GYST_SERVER env var if set, otherwise show placeholder.
    const serverUrl = process.env["GYST_SERVER"] ?? "http://<your-host>:3456";
    const bar = "─".repeat(56);

    process.stdout.write(`\n  ${bar}\n`);
    process.stdout.write(`  Team:   ${teamName}\n`);
    process.stdout.write(`  Server: ${serverUrl}\n`);
    process.stdout.write(`  ${bar}\n\n`);
    process.stdout.write(`  Share these steps with each teammate:\n\n`);
    process.stdout.write(`  Step 1 — Install gyst:\n`);
    process.stdout.write(`    npm install -g gyst-mcp\n\n`);
    process.stdout.write(`  Step 2 — Join and auto-configure all AI tools:\n`);
    process.stdout.write(`    gyst join ${inviteKey} "Their Name" --server ${serverUrl}\n\n`);
    process.stdout.write(`  That's it. gyst join configures Claude Code, Cursor, Codex,\n`);
    process.stdout.write(`  Gemini, Windsurf, and VS Code automatically.\n`);
    process.stdout.write(`  ${bar}\n\n`);
    process.stdout.write(`  Keep safe (don't share):\n`);
    process.stdout.write(`    Admin key: ${process.env["GYST_API_KEY"] ?? "<your admin key>"}\n\n`);
    process.stdout.write(`  Note: invite key expires in 24 hours. Run this to generate a new one:\n`);
    process.stdout.write(`    GYST_API_KEY="<admin key>" gyst team invite\n\n`);
  } catch (err) {
    process.stdout.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
};

const membersTeamAction = async () => {
  try {
    const db = openTeamDb();
    const teamId = await resolveTeamFromEnv(db);
    const members = getTeamMembers(db, teamId);
    db.close();
    process.stdout.write(`Members (${members.length}):\n`);
    for (const m of members) process.stdout.write(`  ${m.displayName} (${m.role})\n`);
  } catch (err) {
    process.stdout.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
};

// ---------------------------------------------------------------------------
// Program Definition
// ---------------------------------------------------------------------------

/**
 * Warn once per invocation if the `gyst` executable is not resolvable on
 * the user's PATH. Help text and docs all tell the user to type `gyst ...`,
 * so when they've launched us through `npx gyst-mcp` or `bunx gyst-mcp`
 * those instructions silently break. One line to stderr is enough — the
 * command we're already running still works.
 */
function emitPathBannerIfMissing(): void {
  if (process.env["GYST_SUPPRESS_PATH_BANNER"] === "1") return;
  const rawPath = process.env["PATH"] ?? "";
  if (rawPath.length === 0) return;
  const isWin = process.platform === "win32";
  const exts = isWin ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = rawPath.split(PATH_DELIM).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, `gyst${ext}`))) return;
      } catch {
        // Unreadable directory — skip, keep scanning.
      }
    }
  }
  const invocation = process.argv[1] ?? "gyst";
  process.stderr.write(
    `\n  ⚠  \`gyst\` is not on your PATH. Documentation assumes a bare \`gyst <cmd>\`.\n` +
      `     Invocation used: ${invocation}\n` +
      `     Until you add gyst to PATH, prefix commands with the path above\n` +
      `     (or: \`npx gyst-mcp <cmd>\` / \`bunx gyst-mcp <cmd>\`).\n` +
      `     Silence this banner: GYST_SUPPRESS_PATH_BANNER=1\n\n`,
  );
}
emitPathBannerIfMissing();

const program = new Command();
program.name("gyst").description("Team knowledge compiler").version(_pkgVersion);

program
  .command("show [resource]", { hidden: true })
  .description("Visualize Gyst resources (memory|members)")
  .action(async (resource: string | undefined) => {
    if (resource?.toLowerCase() === "memory") {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { startDashboardServer } = await import("../dashboard/server.js");
      const { url } = await startDashboardServer({ db, port: 37778, openBrowser: true });
      process.stdout.write(`Memory visualization live at: ${url}\n`);
      return;
    }
    if (resource?.toLowerCase() === "members") {
      await membersTeamAction();
      return;
    }
    process.stdout.write("Usage: gyst show memory | gyst show members\n");
  });

program
  .command("probe [dir]", { hidden: true })
  .description("Technically scan for patterns/conventions")
  .option("--dry-run")
  .action(detectConventionsAction);

program
  .command("audit <file>", { hidden: true })
  .description("Audit a file against the knowledge graph")
  .action(async (file: string) => {
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const { checkFileViolations } = await import("../compiler/check-violations.js");
    const violations = checkFileViolations(db, file);
    db.close();
    if (violations.length === 0) {
      process.stdout.write(`✅ Audit passed: ${file}\n`);
      return;
    }
    process.stdout.write(`❌ Audit failed: ${file} (${violations.length} violations)\n`);
    for (const v of violations) process.stdout.write(`  - [${v.rule}] ${v.message}\n`);
    process.exit(1);
  });

program
  .command("emit <type> [payload]", { hidden: true })
  .description("Emit a universal hook event")
  .action(emitAction);

program
  .command("heartbeat", { hidden: true })
  .description("Start Gyst MCP server (Alias for serve)")
  .action(serveAction);

program
  .command("install")
  .alias("setup")
  .description("First-time setup (detects tools, registers MCP + 6 hooks, scans conventions)")
  .option("--minimal", "Use the minimal, non-interactive setup path")
  .option("--team <name>", "Create or join a team during setup (pass a team name or an invite key)")
  .action(async (opts: { minimal?: boolean; team?: string }) => {
    if (opts.minimal) {
      await setupAction();
    } else {
      try {
        const { runInstall } = await import("./install.js");
        await runInstall();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\nInstall failed: ${msg}\n`);
        process.exit(1);
      }
    }
    // If --team was passed, handle team creation/joining after install
    if (opts.team) {
      const teamArg = opts.team.trim();
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      initTeamSchema(db);
      initActivitySchema(db);
      // Invite keys are 40+ character hex strings; team names are shorter human strings
      const looksLikeInviteKey = /^[0-9a-f]{32,}$/i.test(teamArg);
      try {
        if (looksLikeInviteKey) {
          const defaultName = process.env["USER"] ?? "Developer";
          const { joinTeam } = await import("../server/auth.js");
          const { memberKey } = await joinTeam(db, teamArg, defaultName);
          db.close();
          process.stdout.write(`\n  ✓ Joined team. Member key: ${memberKey}\n`);
          process.stdout.write(`  Add to your shell: export GYST_API_KEY="${memberKey}"\n\n`);
        } else {
          const { createTeam } = await import("../server/auth.js");
          const { teamId, adminKey } = createTeam(db, teamArg);
          db.close();
          process.stdout.write(`\n  ✓ Team "${teamArg}" created (ID: ${teamId})\n`);
          process.stdout.write(`  Admin key: ${adminKey}\n`);
          process.stdout.write(`  Add to your shell: export GYST_API_KEY="${adminKey}"\n\n`);
        }
      } catch (err) {
        db.close();
        process.stdout.write(`\n  Team setup failed: ${(err as Error).message}\n`);
      }
    }
  });

program
  .command("projects [root]")
  .description("List every Gyst project (.gyst/ folder) under a directory")
  .option("--max-depth <n>", "Maximum directory depth to scan", "8")
  .action((rootArg: string | undefined, opts: { maxDepth: string }) => {
    const searchRoot = rootArg ?? process.cwd();
    const activeRoot = findProjectRoot(process.cwd());
    const depth = parseInt(opts.maxDepth, 10);
    const found = findAllProjects(searchRoot, Number.isFinite(depth) ? depth : 8);
    if (found.length === 0) {
      process.stdout.write(`No Gyst projects found under ${searchRoot}.\n`);
      return;
    }
    process.stdout.write(`Found ${found.length} Gyst project(s) under ${searchRoot}:\n`);
    for (const p of found) {
      const marker = activeRoot && p === activeRoot ? " (current)" : "";
      process.stdout.write(`  ${p}${marker}\n`);
    }
  });

program.command("recall <query>").description("Search memory").option("-t, --type <type>", "Filter", "all").option("-n, --max <max>", "Limit", "5").action(searchAction);
program.command("search <query>", { hidden: true }).description("Alias for recall").option("-t, --type <type>", "Filter", "all").option("-n, --max <max>", "Limit", "5").action(searchAction);

program
  .command("add [title] [content...]")
  .description("Add knowledge (content can be unquoted; remaining args are joined)")
  .option("-t, --type <type>", "Type", "learning")
  .option("-f, --files <files...>", "Files")
  .option("--tags <tags...>", "Tags")
  .option(
    "-s, --scope <scope>",
    "Visibility scope: team (default), personal, or project",
    "team",
  )
  .action(async (posTitle, posContentParts, options) => {
    try {
      const finalTitle = (options.title ?? posTitle ?? "").trim();
      const joinedContent = Array.isArray(posContentParts) ? posContentParts.join(" ") : (posContentParts ?? "");
      const finalContent = (options.content ?? joinedContent ?? finalTitle).toString().trim() || finalTitle;
      if (finalTitle === "") {
        process.stdout.write("Error: title is required\n");
        process.exit(1);
      }
      const allowedScopes = ["personal", "team", "project"] as const;
      const scope = String(options.scope ?? "team").toLowerCase();
      if (!allowedScopes.includes(scope as (typeof allowedScopes)[number])) {
        process.stdout.write(
          `Error: --scope must be one of ${allowedScopes.join(", ")} (got "${options.scope}")\n`,
        );
        process.exit(1);
      }
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const entryId = await addManualEntry(db, {
        type: options.type as EntryType,
        title: finalTitle,
        content: finalContent,
        files: options.files,
        tags: options.tags,
        scope: scope as "personal" | "team" | "project",
      });
      db.close();
      process.stdout.write(`Entry added successfully (ID: ${entryId}, scope: ${scope})\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("Browse knowledge entries (filter by type, tag, scope)")
  .option("-t, --type <type>", "Filter by entry type (error_pattern, convention, decision, learning, ghost_knowledge)")
  .option("--tag <tag>", "Filter by tag")
  .option("-s, --scope <scope>", "Filter by scope (personal | team | project | all)", "all")
  .option("-n, --limit <limit>", "Max rows to show", "20")
  .action((options: { type?: string; tag?: string; scope?: string; limit?: string }) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const limit = Math.max(1, Math.min(500, parseInt(options.limit ?? "20", 10) || 20));
      const clauses: string[] = ["e.status = 'active'"];
      const params: (string | number)[] = [];
      if (options.type) {
        clauses.push("e.type = ?");
        params.push(options.type);
      }
      if (options.scope && options.scope !== "all") {
        clauses.push("e.scope = ?");
        params.push(options.scope);
      }
      let joinSql = "";
      if (options.tag) {
        joinSql = "JOIN entry_tags et ON et.entry_id = e.id";
        clauses.push("et.tag = ?");
        params.push(options.tag);
      }
      const sql = `SELECT DISTINCT e.id, e.type, e.title, e.confidence, e.scope, e.last_confirmed
                   FROM entries e
                   ${joinSql}
                   WHERE ${clauses.join(" AND ")}
                   ORDER BY e.last_confirmed DESC
                   LIMIT ?`;
      params.push(limit);
      const rows = db.query<{
        id: string;
        type: string;
        title: string;
        confidence: number;
        scope: string;
        last_confirmed: string;
      }, (string | number)[]>(sql).all(...params);
      db.close();

      if (rows.length === 0) {
        process.stdout.write("No entries match those filters.\n");
        return;
      }
      process.stdout.write(`Showing ${rows.length} entr${rows.length === 1 ? "y" : "ies"}:\n\n`);
      for (const row of rows) {
        const conf = `${(row.confidence * 100).toFixed(0)}%`.padStart(4);
        const type = row.type.padEnd(16);
        const scope = row.scope.padEnd(8);
        const title = row.title.length > 60 ? row.title.slice(0, 57) + "..." : row.title;
        process.stdout.write(`  ${conf}  ${type}  ${scope}  ${title}\n`);
        process.stdout.write(`         ${row.id}\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

const team = program.command("team").description("Team management");
team.command("create <name>").description("Create team").action(createTeamAction);
team.command("invite").description("Invite member").action(inviteTeamAction);
team.command("members").description("List members").action(membersTeamAction);
team
  .command("init")
  .description("Opt into team mode — future entries can land in the team layer")
  .action(async () => {
    const { initTeamModeAction } = await import("./team-init.js");
    await initTeamModeAction();
  });

program
  .command("create [keyword] [nameParts...]", { hidden: true })
  .description("Create a new team (e.g. `gyst create team Acme` or `gyst create Acme`)")
  .action((keyword: string | undefined, nameParts: string[] | undefined) => {
    const rest = (nameParts ?? []).join(" ").trim();
    let teamName = "";
    if (keyword?.toLowerCase() === "team") {
      teamName = rest;
    } else {
      teamName = [keyword ?? "", rest].filter(Boolean).join(" ").trim();
    }
    if (!teamName) {
      process.stdout.write(
        "Error: team name is required.\n" +
        "  Usage:  gyst create team <name>\n" +
        "  Or:     gyst create-team <name>\n",
      );
      process.exit(1);
    }
    createTeamAction(teamName);
  });

program
  .command("create-team <nameParts...>", { hidden: true })
  .description("Alias for `gyst create team <name>`")
  .action((nameParts: string[]) => {
    const teamName = nameParts.join(" ").trim();
    if (!teamName) {
      process.stdout.write("Error: team name is required. Usage: gyst create-team <name>\n");
      process.exit(1);
    }
    createTeamAction(teamName);
  });

program.command("invite", { hidden: true }).description("Alias for team invite").action(inviteTeamAction);
program.command("members", { hidden: true }).description("Alias for team members").action(membersTeamAction);

program
  .command("join <inviteKey> <displayName>")
  .description("Join a team using an invite key")
  .option("--server <url>", "Remote Gyst HTTP server URL (e.g. http://team.example.com:3456)")
  .action(async (key: string, name: string, opts: { server?: string }) => {
    try {
      if (opts.server) {
        // Remote join: hit the HTTP server's /team/join endpoint
        const url = opts.server.replace(/\/$/, "") + "/team/join";
        // The HTTP server reads the invite key from the Authorization header,
        // and the display name from the JSON body.
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key.trim()}`,
          },
          body: JSON.stringify({ displayName: name.trim() }),
        });
        if (!res.ok) {
          const body = await res.text();
          process.stdout.write(`Error: ${res.status} ${body}\n`);
          process.exit(1);
        }
        const data = (await res.json()) as { memberKey?: string };
        if (!data.memberKey) {
          process.stdout.write("Error: server did not return a member key\n");
          process.exit(1);
        }
        process.stdout.write(`Joined! Member Key: ${data.memberKey}\n`);
        process.stdout.write(`Add to your shell:  export GYST_API_KEY="${data.memberKey}"\n\n`);

        // Auto-configure every detected AI tool to point at the shared HTTP server.
        const { writeHttpMcpConfig } = await import("./install.js");
        const configured = writeHttpMcpConfig(opts.server, data.memberKey);
        if (configured.length > 0) {
          process.stdout.write(`Configured MCP clients: ${configured.join(", ")}\n`);
          process.stdout.write(`All your agents now point at the shared team server.\n`);
          process.stdout.write(`Restart your AI tools to activate.\n`);
        } else {
          process.stdout.write(`No AI tools detected — configure manually:\n`);
          process.stdout.write(`  URL:  ${opts.server.replace(/\/$/, "")}/mcp\n`);
          process.stdout.write(`  Auth: Bearer ${data.memberKey}\n`);
        }
      } else {
        // Local join: use the local DB
        const db = openTeamDb();
        const { memberKey } = await joinTeam(db, key.trim(), name.trim());
        db.close();
        process.stdout.write(`Joined! Member Key: ${memberKey}\n`);
        process.stdout.write(`Add to your shell:  export GYST_API_KEY="${memberKey}"\n`);
      }
    } catch (err) {
      process.stdout.write(`Error: ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

program.command("ghost-init", { hidden: true }).description("Interactive onboarding").action(async () => {
  const { runGhostInit } = await import("./ghost-init.js");
  await runGhostInit();
});

program.command("consolidate", { hidden: true }).description("Run maintenance pipeline").action(async () => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { consolidate } = await import("../compiler/consolidate.js");
  const report = await consolidate(db);
  db.close();
  process.stdout.write(`Consolidation complete (Merged: ${report.duplicatesMerged})\n`);
});

program.command("process-events", { hidden: true }).description("Promote high-signal events to knowledge entries").option("-l, --limit <limit>", "Max events to process", "50").option("-t, --threshold <threshold>", "Signal threshold (0..1)", "0.5").action(async (opts) => {
  try {
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const { processEvents } = await import("../compiler/process-events.js");
    const report = await processEvents(db, {
      limit: parseInt(opts.limit, 10),
      signalThreshold: parseFloat(opts.threshold),
    });
    db.close();
    process.stdout.write(`Processed ${report.processed} event(s):\n`);
    process.stdout.write(`  Entries created: ${report.entriesCreated}\n`);
    process.stdout.write(`  Skipped:         ${report.skipped}\n`);
    process.stdout.write(`  Failed:          ${report.failed}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
});

program
  .command("distill", { hidden: true })
  .description("Deactivate Stage 2 distillation over completed events using an LLM")
  .option("-l, --limit <limit>", "Max events to process", "100")
  .option("-s, --session <id>", "Only distill specific session")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { distillEvents } = await import("../compiler/distill.js");
      const report = await distillEvents(db, {
        limit: parseInt(opts.limit, 10),
        sessionId: opts.session,
      });
      db.close();
      process.stdout.write(`Distillation complete:\n`);
      process.stdout.write(`  Sessions: ${report.sessionsProcessed}\n`);
      process.stdout.write(`  Events:   ${report.eventsProcessed}\n`);
      process.stdout.write(`  Entries:  ${report.entriesCreated}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

program
  .command("sync-graph", { hidden: true })
  .description("Update the structural code graph using Graphify and sync it to Gyst")
  .action(async () => {
    try {
      const { spawnSync } = await import("node:child_process");
      process.stdout.write("Running Graphify update...\n");

      const result = spawnSync("graphify", ["update", "."], { stdio: "inherit" });
      if (result.status !== 0) {
        throw new Error(`Graphify failed with exit code ${result.status}`);
      }

      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { transformGraphify } = await import("../compiler/graphify-transformer.js");

      process.stdout.write("Transforming Graphify data into Gyst...\n");
      const report = transformGraphify(db);
      db.close();

      process.stdout.write(`Sync complete:\n`);
      process.stdout.write(`  Structural nodes: ${report.nodesImported}\n`);
      process.stdout.write(`  Relationships:    ${report.linksImported}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

program.command("harvest-session", { hidden: true }).description("Harvest from Claude Code").action(async () => {
  const { runHarvestSession } = await import("./harvest.js");
  await runHarvestSession();
});

program
  .command("backfill")
  .description("Replay existing git history into the knowledge base")
  .option("--since <ref>", "Git ref, SHA, or date (passed to git log --since=)")
  .option("--author <pattern>", "Filter commits by author name/email")
  .option("--paths <paths...>", "Only commits that touched these paths")
  .option("--max <n>", "Maximum commits to scan", "500")
  .option("--dry-run", "Report what would be captured without writing")
  .action(async (opts: {
    since?: string;
    author?: string;
    paths?: string[];
    max: string;
    dryRun?: boolean;
  }) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { backfillCommits } = await import("../capture/backfill.js");
      const report = await backfillCommits(db, {
        since: opts.since,
        author: opts.author,
        paths: opts.paths,
        max: parseInt(opts.max, 10),
        dryRun: opts.dryRun === true,
      });
      db.close();
      process.stdout.write(
        `Backfill complete — scanned ${report.scanned}, captured ${report.captured}, skipped ${report.skipped}, failed ${report.failed}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${msg}\n`);
      process.exit(1);
    }
  });

program
  .command("import")
  .description("Import transcripts from another AI coding tool")
  .requiredOption("--from <source>", "Source: claude-code | cursor")
  .option("--path <path>", "Override the source's default path")
  .option("--all-projects", "Import from every project (claude-code only)")
  .option("--max <n>", "Maximum sessions to import", "100")
  .action(async (opts: {
    from: string;
    path?: string;
    allProjects?: boolean;
    max: string;
  }) => {
    try {
      const source = opts.from.toLowerCase();
      if (source !== "claude-code" && source !== "cursor") {
        process.stdout.write(
          `Error: unknown --from value "${opts.from}". Use claude-code or cursor.\n`,
        );
        process.exit(1);
      }
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { importSessions } = await import("../capture/import-sessions.js");
      const report = await importSessions(db, source as "claude-code" | "cursor", {
        path: opts.path,
        allProjects: opts.allProjects === true,
        max: parseInt(opts.max, 10),
      });
      db.close();
      process.stdout.write(
        `Import complete (${report.source}) — found ${report.sessionsFound}, imported ${report.sessionsImported}, ` +
          `created ${report.entriesCreated}, merged ${report.entriesMerged}, skipped ${report.entriesSkipped}, failed ${report.failures}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${msg}\n`);
      process.exit(1);
    }
  });

program.command("detect-conventions [dir]", { hidden: true }).description("Auto-detect conventions").option("--dry-run").action(detectConventionsAction);
program.command("detect [dir]").description("Scan for coding conventions").option("--dry-run").action(detectConventionsAction);

program.command("check-conventions [file]", { hidden: true }).description("Show path conventions").action(checkConventionsAction);
program.command("check [file]").description("Check a file against the knowledge graph").action(checkConventionsAction);

program.command("dashboard").description("Start UI").option("-p, --port <port>", "Port", "3579").option("--no-open").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { startDashboardServer } = await import("../dashboard/server.js");
  const { url } = await startDashboardServer({ db, port: Number(opts.port), openBrowser: opts.open });
  process.stdout.write(`\nGyst dashboard: ${url}\nPress Ctrl+C to stop.\n`);
});
program.command("ui", { hidden: true }).description("Alias for dashboard").option("-p, --port <port>", "Port", "3579").option("--no-open").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { startDashboardServer } = await import("../dashboard/server.js");
  const { url } = await startDashboardServer({ db, port: Number(opts.port), openBrowser: opts.open });
  process.stdout.write(`\nGyst dashboard: ${url}\nPress Ctrl+C to stop.\n`);
});

program.command("rebuild", { hidden: true }).description("Rebuild index").action(async () => {
  const config = loadConfig();
  const { rebuildFromMarkdown } = await import("../store/rebuild.js");
  const stats = await rebuildFromMarkdown(config);
  process.stdout.write(`Rebuild complete (Total: ${stats.total})\n`);
});
program.command("sync", { hidden: true }).description("Alias for rebuild").action(async () => {
  const config = loadConfig();
  const { rebuildFromMarkdown } = await import("../store/rebuild.js");
  const stats = await rebuildFromMarkdown(config);
  process.stdout.write(`Rebuild complete (Total: ${stats.total})\n`);
});

program
  .command("recap")
  .description("Summarize recent session activity")
  .option("-s, --since <minutes>", "Look back window in minutes", "60")
  .action(async (options: { since: string }) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { renderRecap } = await import("./recap.js");
      const recap = renderRecap(db, { sinceMinutes: parseInt(options.since, 10) });
      db.close();
      process.stdout.write(recap + "\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

program.command("inject-context", { hidden: true }).description("Inject session context").option("--always-on").option("--graph-traverse").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  
  // Try to open global DB if it exists
  let globalDb: any = undefined;
  if (config.globalDbPath && existsSync(config.globalDbPath)) {
    globalDb = initDatabase(config.globalDbPath);
  }

  const { generateSessionContext } = await import("../capture/session-inject.js");
  const result = generateSessionContext({ 
    db, 
    projectDir: process.cwd(),
    globalDb 
  });

  if (result.userSummary) {
    process.stderr.write(`\n${result.userSummary}\n\n`);
  }

  let text = result.agentContext;
  if (opts.alwaysOn && text) text += "\nTrust Gyst memory.";
  
  db.close();
  if (globalDb) globalDb.close();
  
  if (text) {
    process.stdout.write(text + "\n");
  }
});

program.command("inject", { hidden: true }).description("Alias for inject-context").option("--always-on").option("--graph-traverse").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  
  // Try to open global DB if it exists
  let globalDb: any = undefined;
  if (config.globalDbPath && existsSync(config.globalDbPath)) {
    globalDb = initDatabase(config.globalDbPath);
  }

  const { generateSessionContext } = await import("../capture/session-inject.js");
  const result = generateSessionContext({ 
    db, 
    projectDir: process.cwd(),
    globalDb 
  });

  if (result.userSummary) {
    process.stderr.write(`\n${result.userSummary}\n\n`);
  }

  let text = result.agentContext;
  if (opts.alwaysOn && text) text += "\nTrust Gyst memory.";
  
  db.close();
  if (globalDb) globalDb.close();
  
  if (text) {
    process.stdout.write(text + "\n");
  }
});

program
  .command("serve")
  .description("Start Gyst MCP server (stdio) or shared HTTP team server")
  .option("--http", "Start in HTTP mode so remote teammates can connect")
  .option("--port <port>", "HTTP port (default: 3456, overridden by GYST_PORT env var)", "3456")
  .action(async (opts: { http?: boolean; port?: string }) => {
    if (opts.http) {
      const { startHttpServer } = await import("../server/http.js");
      const config = loadConfig();
      const port = parseInt(process.env["GYST_PORT"] ?? opts.port ?? "3456", 10);
      startHttpServer({ port, dbPath: config.dbPath });
      process.stdout.write(`Gyst HTTP server running on port ${port}\n`);
      process.stdout.write(`Teammates can join via: POST http://<your-host>:${port}/team/join\n`);
      process.stdout.write(`MCP endpoint: http://<your-host>:${port}/mcp  (Bearer <memberKey>)\n`);
    } else {
      await serveAction();
    }
  });
program.command("start", { hidden: true }).description("Alias for serve").action(serveAction);

const privacy = program
  .command("privacy")
  .description("Switch where this knowledge base lives (local | private repo | HTTP server)");
privacy
  .command("show", { isDefault: true })
  .description("Show the current privacy mode")
  .action(async () => {
    const { showPrivacyMode } = await import("./privacy.js");
    await showPrivacyMode();
  });
privacy
  .command("local")
  .description("Switch to local-only mode (Path 1)")
  .action(async () => {
    const { switchToLocal } = await import("./privacy.js");
    await switchToLocal();
  });
privacy
  .command("wiki <path>")
  .description("Switch to private wiki repo mode (Path 2); wikiDir moves to <path>")
  .action(async (path: string) => {
    const { switchToPrivateRepo } = await import("./privacy.js");
    await switchToPrivateRepo(path);
  });
privacy
  .command("server <url> <memberKey>")
  .description("Switch to HTTP-server mode (Path 3); MCP clients point at <url>")
  .action(async (url: string, memberKey: string) => {
    const { switchToHttpServer } = await import("./privacy.js");
    await switchToHttpServer(url, memberKey);
  });

program
  .command("export", { hidden: true })
  .description("Export all active knowledge entries to markdown files (derived from DB)")
  .action(async () => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { exportToMarkdown } = await import("./export.js");
      const result = await exportToMarkdown(db, config);
      process.stdout.write(
        `Exported ${result.exported} entries, skipped ${result.skipped} (already on disk).\n`,
      );
      db.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("export failed", { error: msg });
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Diagnose environment, SQLite, sqlite-vec, and installed integrations")
  .action(async () => {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor();
  });

// Improve the "unknown command" error with a did-you-mean hint.
program.on("command:*", (operands: string[]) => {
  const bad = operands.join(" ");
  const known = program.commands.map((c) => c.name());
  const suggestion = bad
    ? known.find((n) => n.startsWith(bad.split(" ")[0]!.toLowerCase()))
    : undefined;
  process.stderr.write(`\nError: unknown command "${bad}"\n`);
  if (suggestion) {
    process.stderr.write(`  Did you mean:  gyst ${suggestion}\n`);
  }
  process.stderr.write(`  Run \`gyst --help\` for the full command list.\n\n`);
  process.exit(1);
});

program.parse();
