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
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
// @ts-ignore — JSON import resolved by Bun bundler; string fallback for dev mode
import _pkg from "../../package.json" with { type: "json" };
const _pkgVersion: string = (typeof _pkg === "object" && _pkg !== null && "version" in _pkg)
  ? String((_pkg as { version: string }).version)
  : "0.0.0";
import { initDatabase } from "../store/database.js";
import { installForDetectedTools } from "../mcp/installer.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";
import { addManualEntry } from "../capture/manual.js";
import { GystError } from "../utils/errors.js";
import {
  createTeam,
  createInviteKey,
  joinTeam,
  initTeamSchema,
  AuthError,
} from "../server/auth.js";
import { initActivitySchema } from "../server/activity.js";
import { getTeamMembers, removeMember } from "../server/team.js";

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

const setupAction = async () => {
  try {
    const config = loadConfig();
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

const searchAction = async (query: string, options: { type: string; max: string }) => {
  try {
    const config = loadConfig();
    const db = initDatabase(config.dbPath);
    const maxResults = parseInt(options.max, 10);
    const { searchByBM25, reciprocalRankFusion } = await import("../store/search.js");
    const typeFilter = options.type === "all" ? undefined : options.type;
    const bm25Results = searchByBM25(db, query, typeFilter);
    const fused = reciprocalRankFusion([bm25Results]);
    const topResults = fused.slice(0, maxResults);
    db.close();
    if (topResults.length === 0) {
      process.stdout.write(`No results found for: "${query}"\n`);
      return;
    }
    process.stdout.write(`Found ${topResults.length} result(s) for: "${query}"\n\n`);
    for (const [index, result] of topResults.entries()) {
      process.stdout.write(`--- ${index + 1}. [${result.source}] (score: ${result.score.toFixed(3)}) ---\n`);
      process.stdout.write(`ID: ${result.id}\n\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
    process.exit(1);
  }
};

const addAction = async (
  posTitle: string | undefined,
  posContent: string | undefined,
  options: { type: string; title?: string; content?: string; files?: string[]; tags?: string[] }
) => {
  try {
    const finalTitle = (options.title ?? posTitle ?? "").trim();
    const finalContent = (options.content ?? posContent ?? finalTitle).trim();
    if (!VALID_ENTRY_TYPES.includes(options.type as EntryType)) {
      process.stdout.write(`Error: --type must be one of: ${VALID_ENTRY_TYPES.join(", ")}\n`);
      process.exit(1);
    }
    if (finalTitle === "") {
      process.stdout.write("Error: title is required\n");
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
    });
    db.close();
    process.stdout.write(`Entry added successfully (ID: ${entryId})\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${message}\n`);
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
    if (await Bun.password.verify(rawKey, row.key_hash)) return row.team_id;
  }
  process.stdout.write("Error: GYST_API_KEY is invalid.\n");
  process.exit(1);
}

const createTeamAction = (name: string) => {
  try {
    const db = openTeamDb();
    const { teamId, adminKey } = createTeam(db, name.trim());
    db.close();
    process.stdout.write(`Team created! ID: ${teamId}\nAdmin Key: ${adminKey}\n`);
    process.stdout.write(`export GYST_API_KEY="${adminKey}"\n`);
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
    db.close();
    process.stdout.write(`Invite key: ${inviteKey}\ngyst join ${inviteKey} "Name"\n`);
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

const program = new Command();
program.name("gyst").description("Team knowledge compiler").version(_pkgVersion);

program.command("setup").description("Initialize Gyst").action(setupAction);

program.command("recall <query>").description("Search memory").option("-t, --type <type>", "Filter", "all").option("-n, --max <max>", "Limit", "5").action(searchAction);
program.command("search <query>").description("Alias for recall").option("-t, --type <type>", "Filter", "all").option("-n, --max <max>", "Limit", "5").action(searchAction);

program.command("add [title] [content]").description("Add knowledge").option("-t, --type <type>", "Type", "learning").option("-f, --files <files...>", "Files").option("--tags <tags...>", "Tags").action(addAction);

const team = program.command("team").description("Team management");
team.command("create <name>").description("Create team").action(createTeamAction);
team.command("invite").description("Invite member").action(inviteTeamAction);
team.command("members").description("List members").action(membersTeamAction);

program.command("create <name>").description("Alias for team create").action(createTeamAction);
program.command("invite").description("Alias for team invite").action(inviteTeamAction);
program.command("members").description("Alias for team members").action(membersTeamAction);

program.command("join <inviteKey> <displayName>").description("Join team").action(async (key, name) => {
  try {
    const db = openTeamDb();
    const { developerId, memberKey } = await joinTeam(db, key.trim(), name.trim());
    db.close();
    process.stdout.write(`Joined! Member Key: ${memberKey}\n`);
  } catch (err) {
    process.stdout.write(`Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
});

program.command("ghost-init").description("Interactive onboarding").action(async () => {
  const { runGhostInit } = await import("./ghost-init.js");
  await runGhostInit();
});

program.command("consolidate").description("Run maintenance pipeline").action(async () => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { consolidate } = await import("../compiler/consolidate.js");
  const report = await consolidate(db);
  db.close();
  process.stdout.write(`Consolidation complete (Merged: ${report.duplicatesMerged})\n`);
});

program.command("harvest-session").description("Harvest from Claude Code").action(async () => {
  const { runHarvestSession } = await import("./harvest.js");
  await runHarvestSession();
});

program.command("detect-conventions [dir]").description("Auto-detect conventions").option("--dry-run").action(detectConventionsAction);
program.command("detect [dir]").description("Alias for detect-conventions").option("--dry-run").action(detectConventionsAction);

program.command("check-conventions [file]").description("Show path conventions").action(checkConventionsAction);
program.command("check [file]").description("Alias for check-conventions").action(checkConventionsAction);

program.command("dashboard").description("Start UI").option("-p, --port <port>", "Port", "37778").option("--no-open").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { startDashboardServer } = await import("../dashboard/server.js");
  const { url } = await startDashboardServer({ db, port: Number(opts.port), openBrowser: opts.open });
  process.stdout.write(`Dashboard: ${url}\n`);
});
program.command("ui").description("Alias for dashboard").option("-p, --port <port>", "Port", "37778").option("--no-open").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { startDashboardServer } = await import("../dashboard/server.js");
  const { url } = await startDashboardServer({ db, port: Number(opts.port), openBrowser: opts.open });
  process.stdout.write(`Dashboard: ${url}\n`);
});

program.command("rebuild").description("Rebuild index").action(async () => {
  const config = loadConfig();
  const { rebuildFromMarkdown } = await import("../store/rebuild.js");
  const stats = await rebuildFromMarkdown(config);
  process.stdout.write(`Rebuild complete (Total: ${stats.total})\n`);
});
program.command("sync").description("Alias for rebuild").action(async () => {
  const config = loadConfig();
  const { rebuildFromMarkdown } = await import("../store/rebuild.js");
  const stats = await rebuildFromMarkdown(config);
  process.stdout.write(`Rebuild complete (Total: ${stats.total})\n`);
});

program.command("inject-context").description("Inject session context").option("--always-on").option("--graph-traverse").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { generateSessionContext } = await import("../capture/session-inject.js");
  let text = generateSessionContext({ db, projectDir: process.cwd() });
  if (opts.alwaysOn) text += "\nTrust Gyst memory.";
  db.close();
  process.stdout.write(text + "\n");
});
program.command("inject").description("Alias for inject-context").option("--always-on").option("--graph-traverse").action(async (opts) => {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  const { generateSessionContext } = await import("../capture/session-inject.js");
  let text = generateSessionContext({ db, projectDir: process.cwd() });
  if (opts.alwaysOn) text += "\nTrust Gyst memory.";
  db.close();
  process.stdout.write(text + "\n");
});

program.command("serve").description("Start MCP server").action(async () => { await import("../mcp/server.js"); });
program.command("start").description("Alias for serve").action(async () => { await import("../mcp/server.js"); });

program.parse();
