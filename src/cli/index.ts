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
 *
 * Commands:
 *   gyst setup              — First-time project initialization
 *   gyst recall             — Search the team knowledge base
 *   gyst add                — Manually add a knowledge entry
 *   gyst team create <name> — Create a team and print the admin API key
 *   gyst team invite        — Create an invite key (requires GYST_API_KEY)
 *   gyst team members       — List team members (requires GYST_API_KEY)
 *   gyst team revoke <id>   — Revoke a member's keys (requires GYST_API_KEY)
 *   gyst join <key> <name>  — Exchange an invite key for a member key
 */

import { Command } from "commander";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
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

// Matches the entry type enum in src/compiler/extract.ts + src/store/database.ts.
// writeEntry() writes to `{wikiDir}/{entry.type}/{slug}.md`, so these directory
// names MUST match the type literals exactly.
const WIKI_SUBDIRS = [
  "error_pattern",
  "convention",
  "decision",
  "learning",
  "ghost_knowledge",
] as const;

const program = new Command();

program
  .name("gyst")
  .description("Team knowledge compiler for AI coding agents")
  .version(_pkgVersion);

// ---------------------------------------------------------------------------
// gyst setup — first-time initialization
// ---------------------------------------------------------------------------

program
  .command("setup")
  .description("Initialize Gyst in this project")
  .action(async () => {
    try {
      const config = loadConfig();

      // 1. Create gyst-wiki/ directory structure
      process.stdout.write("Setting up gyst-wiki directory structure...\n");
      if (!existsSync(config.wikiDir)) {
        mkdirSync(config.wikiDir, { recursive: true });
      }
      for (const sub of WIKI_SUBDIRS) {
        const dir = join(config.wikiDir, sub);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
          logger.debug("Created wiki subdirectory", { dir });
        }
      }
      process.stdout.write(`  wiki dir : ${config.wikiDir}\n`);

      // 2. Initialize SQLite database
      process.stdout.write("Initializing SQLite database...\n");
      const db = initDatabase(config.dbPath);
      db.close();
      process.stdout.write(`  database : ${config.dbPath}\n`);

      // 3. Auto-detect and configure AI tools
      process.stdout.write("Detecting AI tools...\n");
      const installed = installForDetectedTools(process.cwd());
      if (installed.length === 0) {
        process.stdout.write("  No AI tools detected — skipping MCP configuration\n");
      } else {
        for (const tool of installed) {
          process.stdout.write(`  configured: ${tool}\n`);
        }
      }

      // 4. Install git hooks (inline — no external scripts needed)
      process.stdout.write("Installing git hooks...\n");
      const { installGitHooks } = await import("./install.js");
      const gitResult = installGitHooks(process.cwd());
      if (gitResult.noGit) {
        process.stdout.write("  No .git/ found — skipping git hooks.\n");
      } else {
        const done = [...gitResult.installed, ...gitResult.skipped.map((f) => `${f} (already set)`)];
        process.stdout.write(`  hooks: ${done.join(", ") || "none"}\n`);
      }

      // Detect conventions and print count (silent, non-blocking).
      try {
        const { detectConventions } = await import("../compiler/detect-conventions.js");
        const conventions = await detectConventions(process.cwd());
        process.stdout.write(`\nGyst setup complete. Detected ${conventions.length} convention(s).\n`);
      } catch {
        process.stdout.write("\nGyst setup complete.\n");
      }
      logger.info("Gyst setup completed successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Setup failed", { error: message });
      process.stdout.write(`\nSetup failed: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst recall <query> — search from terminal
// ---------------------------------------------------------------------------

program
  .command("recall")
  .description("Search team knowledge base")
  .argument("<query>", "Search query")
  .option(
    "-t, --type <type>",
    "Filter by type (error_pattern|convention|decision|learning|all)",
    "all",
  )
  .option("-n, --max <number>", "Max results", "5")
  .action(async (query: string, options: { type: string; max: string }) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const maxResults = parseInt(options.max, 10);

      if (isNaN(maxResults) || maxResults < 1) {
        process.stdout.write("Error: --max must be a positive integer\n");
        db.close();
        process.exit(1);
        return;
      }

      const { searchByBM25, reciprocalRankFusion } =
        await import("../store/search.js");

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
        process.stdout.write(
          `--- ${index + 1}. [${result.source}] (score: ${result.score.toFixed(3)}) ---\n`,
        );
        process.stdout.write(`ID: ${result.id}\n`);
        process.stdout.write("\n");
      }

      logger.debug("Recall completed", { query, resultCount: topResults.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("Recall failed", { query, error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst add — manual entry
// ---------------------------------------------------------------------------

const VALID_ENTRY_TYPES = [
  "error_pattern",
  "convention",
  "decision",
  "learning",
] as const;

type EntryType = typeof VALID_ENTRY_TYPES[number];

program
  .command("add")
  .description("Manually add knowledge entry")
  .option(
    "-t, --type <type>",
    "Entry type (error_pattern|convention|decision|learning)",
    "learning",
  )
  .option("--title <title>", "Entry title")
  .option("--content <content>", "Entry content")
  .option("-f, --files <files...>", "Affected files")
  .option("--tags <tags...>", "Tags")
  .action(
    async (options: {
      type: string;
      title?: string;
      content?: string;
      files?: string[];
      tags?: string[];
    }) => {
      try {
        // 1. Validate input
        if (!VALID_ENTRY_TYPES.includes(options.type as EntryType)) {
          process.stdout.write(
            `Error: --type must be one of: ${VALID_ENTRY_TYPES.join(", ")}\n`,
          );
          process.exit(1);
          return;
        }
        if (!options.title || options.title.trim() === "") {
          process.stdout.write("Error: --title is required\n");
          process.exit(1);
          return;
        }
        if (!options.content || options.content.trim() === "") {
          process.stdout.write("Error: --content is required\n");
          process.exit(1);
          return;
        }

        // 2. Initialize database
        const config = loadConfig();
        const db = initDatabase(config.dbPath);

        // 3. Create entry (strip, extract, write, index)
        const entryId = await addManualEntry(db, {
          type: options.type as EntryType,
          title: options.title.trim(),
          content: options.content.trim(),
          files: options.files,
          tags: options.tags,
        });

        db.close();

        // 4. Print confirmation
        process.stdout.write("Entry added successfully.\n");
        process.stdout.write(`  ID   : ${entryId}\n`);
        process.stdout.write(`  Type : ${options.type}\n`);
        process.stdout.write(`  Title: ${options.title.trim()}\n`);

        logger.info("Manual entry added", { entryId, type: options.type });
      } catch (err) {
        const message =
          err instanceof GystError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        logger.error("Add entry failed", { error: message });
        process.stdout.write(`Error: ${message}\n`);
        process.exit(1);
      }
    },
  );

// ---------------------------------------------------------------------------
// Helper: resolve team DB and apply team/activity schema
// ---------------------------------------------------------------------------

function openTeamDb() {
  const config = loadConfig();
  const db = initDatabase(config.dbPath);
  initTeamSchema(db);
  initActivitySchema(db);
  return db;
}

/**
 * Reads the GYST_API_KEY environment variable and extracts the teamId from
 * the api_keys table by verifying the key against all non-revoked hashes.
 *
 * Returns the teamId, or exits with a helpful message when the key is missing
 * or invalid.
 */
async function resolveTeamFromEnv(
  db: ReturnType<typeof openTeamDb>,
): Promise<string> {
  const rawKey = process.env["GYST_API_KEY"];
  if (!rawKey) {
    process.stdout.write(
      "Error: GYST_API_KEY is not set.\n\n" +
        "  If you haven't created a team yet:\n" +
        "    gyst team create \"My Team\"\n\n" +
        "  If you already have a key, export it first:\n" +
        "    export GYST_API_KEY=\"gyst_admin_...\"\n",
    );
    process.exit(1);
  }

  // Dynamically verify against stored hashes to find teamId
  interface KeyRow {
    key_hash: string;
    team_id: string;
    developer_id: string | null;
    type: string;
    revoked: number;
  }

  const rows = db
    .query<KeyRow, []>(
      `SELECT key_hash, team_id, developer_id, type, revoked
       FROM   api_keys
       WHERE  revoked = 0`,
    )
    .all();

  for (const row of rows) {
    const ok = await Bun.password.verify(rawKey, row.key_hash);
    if (ok) {
      return row.team_id;
    }
  }

  process.stdout.write(
    "Error: GYST_API_KEY is invalid or has been revoked.\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// gyst team <subcommand>
// ---------------------------------------------------------------------------

const teamCommand = program
  .command("team")
  .description("Manage team collaboration");

/**
 * gyst team create "<Team Name>"
 *
 * Creates a new team and prints the admin API key. The key is only shown
 * once — store it securely.
 */
teamCommand
  .command("create <name>")
  .description("Create a new team and print the admin API key")
  .action((name: string) => {
    try {
      const db = openTeamDb();
      const { teamId, adminKey } = createTeam(db, name.trim());
      db.close();

      process.stdout.write(`Team created successfully.\n`);
      process.stdout.write(`  Team ID  : ${teamId}\n`);
      process.stdout.write(`  Name     : ${name.trim()}\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`  Admin API Key (save this — it will not be shown again):\n`);
      process.stdout.write(`  ${adminKey}\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`  Set it in your shell:\n`);
      process.stdout.write(`    export GYST_API_KEY="${adminKey}"\n`);

      logger.info("Team created via CLI", { teamId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("team create failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

/**
 * gyst team invite
 *
 * Creates a 24-hour invite key that a new developer can exchange for a
 * permanent member key using `gyst join`.
 *
 * Requires GYST_API_KEY (admin key).
 */
teamCommand
  .command("invite")
  .description("Create an invite key for a new team member (requires GYST_API_KEY)")
  .action(async () => {
    try {
      const db = openTeamDb();
      const teamId = await resolveTeamFromEnv(db);
      const inviteKey = createInviteKey(db, teamId);
      db.close();

      process.stdout.write(`Invite key created (valid for 24 hours).\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`  Share this with the new member:\n`);
      process.stdout.write(`    gyst join ${inviteKey} "Their Name"\n`);

      logger.info("Invite key created via CLI", { teamId });
    } catch (err) {
      if (err instanceof AuthError) {
        process.stdout.write(`Error: ${err.message}\n`);
        process.exit(1);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error("team invite failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

/**
 * gyst team members
 *
 * Lists all current members of the team.
 *
 * Requires GYST_API_KEY.
 */
teamCommand
  .command("members")
  .description("List team members (requires GYST_API_KEY)")
  .action(async () => {
    try {
      const db = openTeamDb();
      const teamId = await resolveTeamFromEnv(db);
      const members = getTeamMembers(db, teamId);
      db.close();

      if (members.length === 0) {
        process.stdout.write("No members found.\n");
        return;
      }

      process.stdout.write(`Team members (${members.length}):\n\n`);
      for (const member of members) {
        process.stdout.write(
          `  ${member.displayName.padEnd(24)} ${member.role.padEnd(10)}  ${member.developerId}  (joined ${member.joinedAt.slice(0, 10)})\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("team members failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

/**
 * gyst team revoke <developer-id>
 *
 * Revokes all API keys for a developer and removes them from the team.
 *
 * Requires GYST_API_KEY (admin key).
 */
teamCommand
  .command("revoke <developerId>")
  .description("Revoke a member's API keys and remove them from the team (requires GYST_API_KEY)")
  .action(async (developerId: string) => {
    try {
      const db = openTeamDb();
      const teamId = await resolveTeamFromEnv(db);
      removeMember(db, teamId, developerId.trim());
      db.close();

      process.stdout.write(`Member revoked successfully.\n`);
      process.stdout.write(`  Developer ID : ${developerId.trim()}\n`);
      process.stdout.write(`  All API keys for this developer have been revoked.\n`);

      logger.info("Member revoked via CLI", { teamId, developerId: developerId.trim() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("team revoke failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst join <invite-key> <display-name>
// ---------------------------------------------------------------------------

/**
 * gyst join <invite-key> "Display Name"
 *
 * Exchanges a valid invite key for a permanent member API key.
 * The member key is printed once — the developer must store it.
 */
program
  .command("join <inviteKey> <displayName>")
  .description("Exchange an invite key for a permanent member API key")
  .action(async (inviteKey: string, displayName: string) => {
    try {
      if (displayName.trim().length === 0) {
        process.stdout.write("Error: display name must not be empty\n");
        process.exit(1);
        return;
      }

      const db = openTeamDb();
      const { developerId, memberKey } = await joinTeam(
        db,
        inviteKey.trim(),
        displayName.trim(),
      );
      db.close();

      process.stdout.write(`Welcome to the team!\n`);
      process.stdout.write(`  Developer ID : ${developerId}\n`);
      process.stdout.write(`  Display Name : ${displayName.trim()}\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`  Member API Key (save this — it will not be shown again):\n`);
      process.stdout.write(`  ${memberKey}\n`);
      process.stdout.write(`\n`);
      process.stdout.write(`  Set it in your shell:\n`);
      process.stdout.write(`    export GYST_API_KEY="${memberKey}"\n`);

      logger.info("Developer joined team via CLI", { developerId });
    } catch (err) {
      if (err instanceof AuthError) {
        process.stdout.write(`Error: ${err.message}\n`);
        process.exit(1);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error("join failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst ghost-init — interactive tribal knowledge onboarding
// ---------------------------------------------------------------------------

program
  .command("ghost-init")
  .description("Interactive onboarding to capture tribal team knowledge")
  .action(async () => {
    try {
      const { runGhostInit } = await import("./ghost-init.js");
      const count = await runGhostInit();
      logger.info("ghost-init complete", { count });
    } catch (err) {
      const message = err instanceof GystError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      logger.error("ghost-init failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst consolidate — run the 5-stage consolidation pipeline
// ---------------------------------------------------------------------------

program
  .command("consolidate")
  .description(
    "Run the 5-stage consolidation pipeline (decay, dedupe, merge clusters, archive, reindex)",
  )
  .action(async () => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { consolidate } = await import("../compiler/consolidate.js");
      const report = await consolidate(db);
      db.close();

      process.stdout.write("Consolidation complete.\n");
      process.stdout.write(`  Entries decayed (>0.05): ${report.entriesDecayed}\n`);
      process.stdout.write(`  Duplicates merged      : ${report.duplicatesMerged}\n`);
      process.stdout.write(`  Clusters consolidated  : ${report.clustersConsolidated}\n`);
      process.stdout.write(`  Entries archived       : ${report.entriesArchived}\n`);
      process.stdout.write(`  Active entries after   : ${report.indexEntries}\n`);
      process.stdout.write(`  Links strengthened     : ${report.linksStrengthened}\n`);
      process.stdout.write(`  Duration               : ${report.durationMs.toFixed(0)}ms\n`);

      logger.info("consolidate complete", { ...report });
    } catch (err) {
      const message = err instanceof GystError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      logger.error("consolidate failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst harvest-session — extract knowledge from the most recent Claude Code session
// ---------------------------------------------------------------------------

program
  .command("harvest-session")
  .description(
    "Read the most recent Claude Code session transcript and harvest knowledge entries",
  )
  .action(async () => {
    try {
      const { runHarvestSession } = await import("./harvest.js");
      await runHarvestSession();
    } catch (err) {
      // Hooks must NEVER fail the parent operation (PreCompact must not block).
      const message = err instanceof Error ? err.message : String(err);
      logger.error("harvest-session failed", { error: message });
      process.exit(0);
    }
  });

// ---------------------------------------------------------------------------
// gyst detect-conventions [dir] — scan a directory and store conventions
// ---------------------------------------------------------------------------

program
  .command("detect-conventions [dir]")
  .description("Scan a directory for coding conventions and store them in the knowledge base")
  .option("--dry-run", "Show what would be saved without writing to the database")
  .action(async (dir: string | undefined, options: { dryRun?: boolean }) => {
    try {
      const targetDir = dir ?? process.cwd();
      const isDryRun = options.dryRun === true;

      const { detectConventions } = await import("../compiler/detect-conventions.js");

      process.stdout.write(`Scanning for conventions in: ${targetDir}\n`);
      if (isDryRun) {
        process.stdout.write("(dry-run mode — nothing will be saved)\n");
      }
      process.stdout.write("\n");

      const conventions = await detectConventions(targetDir);

      if (conventions.length === 0) {
        process.stdout.write("No conventions detected.\n");
        logger.info("detect-conventions: no conventions found", { targetDir });
        return;
      }

      process.stdout.write(`Found ${conventions.length} convention(s):\n`);
      for (const c of conventions) {
        process.stdout.write(
          `  ${c.category.padEnd(14)} ${c.directory.padEnd(24)} ${c.pattern.padEnd(36)} (${(c.confidence * 100).toFixed(0)}%)\n`,
        );
      }
      process.stdout.write("\n");

      if (isDryRun) {
        process.stdout.write(
          `Dry-run: ${conventions.length} convention(s) would be saved (pending confidence filter and deduplication).\n`,
        );
        logger.info("detect-conventions dry-run complete", {
          targetDir,
          found: conventions.length,
        });
        return;
      }

      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { storeDetectedConventions } = await import("../compiler/store-conventions.js");

      const stored = await storeDetectedConventions(db, conventions);
      db.close();

      const skipped = conventions.length - stored;
      process.stdout.write(`Stored ${stored} convention(s) to knowledge base.\n`);
      if (skipped > 0) {
        process.stdout.write(`(${skipped} skipped — below 60% confidence or already exists)\n`);
      }

      logger.info("detect-conventions complete", { targetDir, found: conventions.length, stored });
    } catch (err) {
      const message = err instanceof GystError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      logger.error("detect-conventions failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst check-conventions [file] — show conventions that apply to a file or directory
// ---------------------------------------------------------------------------

program
  .command("check-conventions [file]")
  .description("Show coding conventions that apply to a file or directory")
  .action(async (file: string | undefined) => {
    try {
      const targetPath = file ?? process.cwd();

      const config = loadConfig();
      const db = initDatabase(config.dbPath);

      interface ConventionRow {
        id: string;
        title: string;
        content: string;
        confidence: number;
      }

      const rows = db
        .query<ConventionRow, [string]>(
          `SELECT DISTINCT e.id, e.title, e.content, e.confidence
           FROM   entries e
           JOIN   entry_files ef ON ef.entry_id = e.id
           WHERE  e.type   = 'convention'
             AND  e.status = 'active'
             AND  ? LIKE ef.file_path || '%'
           ORDER  BY e.confidence DESC
           LIMIT  10`,
        )
        .all(targetPath);

      db.close();

      process.stdout.write(`Conventions for ${targetPath}:\n\n`);

      if (rows.length === 0) {
        process.stdout.write("No conventions found for this path.\n");
        logger.info("check: no conventions found", { targetPath });
        return;
      }

      for (const row of rows) {
        process.stdout.write(
          `  ${row.title.padEnd(48)} (${(row.confidence * 100).toFixed(0)}%)\n`,
        );
      }

      logger.info("check complete", { targetPath, count: rows.length });
    } catch (err) {
      const message = err instanceof GystError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      logger.error("check failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst check <file> — run enforcement: check file against active conventions
// ---------------------------------------------------------------------------

program
  .command("check <file>")
  .description("Check a file against active team conventions and report violations")
  .action(async (file: string) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { checkFileViolations } = await import("../compiler/check-violations.js");
      const violations = checkFileViolations(db, file);
      db.close();

      if (violations.length === 0) {
        process.stdout.write(`✅ No violations found in ${file}\n`);
        logger.info("check: no violations", { file });
        return;
      }

      process.stdout.write(`Checking ${file} against conventions...\n\n`);
      for (const v of violations) {
        const icon = v.severity === "error" ? "❌" : v.severity === "warning" ? "⚠️" : "ℹ️";
        process.stdout.write(`${icon} Line ${v.line} [${v.severity}] ${v.rule}\n   ${v.message}\n`);
        if (v.suggestion !== undefined) {
          process.stdout.write(`   → ${v.suggestion}\n`);
        }
      }
      process.stdout.write(`\n${violations.length} violation(s) found.\n`);
      logger.info("check: violations found", { file, count: violations.length });
      process.exit(1);
    } catch (err) {
      const message = err instanceof GystError ? err.message : err instanceof Error ? err.message : String(err);
      logger.error("check failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------

program
  .command("dashboard")
  .description("Start the local Gyst knowledge graph dashboard")
  .option("-p, --port <number>", "Port to listen on", "37778")
  .option("--no-open", "Do not auto-open the browser")
  .action(async (opts: { port: string; open: boolean }) => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const port = Number(opts.port);
      if (isNaN(port) || port < 1 || port > 65535) {
        process.stdout.write("Error: --port must be a number between 1 and 65535\n");
        process.exit(1);
      }

      const { startDashboardServer } = await import("../dashboard/server.js");
      const { url, stop } = await startDashboardServer({
        db,
        port,
        openBrowser: opts.open,
      });

      process.stdout.write(`Gyst dashboard running at ${url}\n`);
      process.stdout.write("  Press Ctrl-C to stop.\n");
      logger.info("dashboard started", { url, port });

      const shutdown = async (): Promise<void> => {
        process.stdout.write("\nStopping dashboard…\n");
        stop();
        db.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep the process alive (Bun.serve already does this, but belt-and-suspenders)
      await new Promise<never>(() => { /* intentionally never resolves */ });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      logger.error("dashboard failed", { error: message });
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst inject-context — print compact session-start context block
// ---------------------------------------------------------------------------

program
  .command("inject-context")
  .description("Print a compact session-start context block for the current project")
  .option("--write", "Also write to .gyst-context.md for tools that read project files")
  .option("--dir <path>", "Project directory", process.cwd())
  .action(async (opts: { write: boolean; dir: string }) => {
    const { resolve } = await import("node:path");
    const config = loadConfig(opts.dir);
    // Resolve dbPath relative to opts.dir so --dir truly isolates the project.
    const db = initDatabase(resolve(opts.dir, config.dbPath));
    const { generateSessionContext } = await import("../capture/session-inject.js");
    const text = generateSessionContext({ db, projectDir: opts.dir });
    db.close();
    process.stdout.write(text + "\n");
    if (opts.write) {
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(opts.dir, ".gyst-context.md"), text);
    }
  });

// ---------------------------------------------------------------------------
// gyst score — print uniformity score
// ---------------------------------------------------------------------------

program
  .command("score")
  .description("Print the team knowledge uniformity score (0–100) with subscores")
  .action(async () => {
    try {
      const config = loadConfig();
      const db = initDatabase(config.dbPath);
      const { computeUniformityScore } = await import("../store/uniformity.js");
      const report = computeUniformityScore(db);
      db.close();

      process.stdout.write(`Uniformity score: ${report.score}/100\n`);
      process.stdout.write(`  Coverage:    ${report.subscores.coverage.toFixed(2)}   (${report.details.directoriesCovered} of ${report.details.directoriesTotal} directories)\n`);
      process.stdout.write(`  Ghost rules: ${report.subscores.ghost.toFixed(2)}   (${report.details.ghostCount} active rules)\n`);
      process.stdout.write(`  Freshness:   ${report.subscores.freshness.toFixed(2)}   (avg ${Math.round(report.details.avgFreshnessDays)} days since confirmation)\n`);
      process.stdout.write(`  Style:       ${report.subscores.style.toFixed(2)}   (${Math.round(report.details.highConfidenceRatio * 100)}% of conventions high-confidence)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst onboard — generate onboarding markdown
// ---------------------------------------------------------------------------

program
  .command("onboard")
  .description("Generate onboarding markdown from team knowledge")
  .option("--write", "Write to .gyst-onboarding.md")
  .option("--force", "Overwrite existing .gyst-onboarding.md")
  .option("--dir <path>", "Project directory", process.cwd())
  .action(async (opts: { write?: boolean; force?: boolean; dir: string }) => {
    try {
      const config = loadConfig(opts.dir);
      const db = initDatabase(config.dbPath);
      const { generateOnboarding } = await import("../cli/onboard.js");
      const text = generateOnboarding(db, { dir: opts.dir });
      db.close();

      process.stdout.write(text + "\n");

      if (opts.write === true) {
        const { existsSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const outPath = join(opts.dir, ".gyst-onboarding.md");
        if (existsSync(outPath) && opts.force !== true) {
          process.stdout.write(`\n.gyst-onboarding.md already exists. Use --force to overwrite.\n`);
          process.exit(1);
        }
        writeFileSync(outPath, text);
        process.stdout.write(`\nWrote .gyst-onboarding.md\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${message}\n`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// gyst install — first-time setup: detect tools, register MCP, init project
// ---------------------------------------------------------------------------

program
  .command("install")
  .description("First-time setup: detect AI tools, register MCP server, initialize project")
  .action(async () => {
    const { runInstall } = await import("./install.js");
    await runInstall();
  });

// ---------------------------------------------------------------------------
// gyst rebuild — rebuild SQLite index from gyst-wiki/ markdown files
// ---------------------------------------------------------------------------

program
  .command("rebuild")
  .description("Rebuild the SQLite knowledge index from gyst-wiki/ markdown files")
  .action(async () => {
    const { rebuildFromMarkdown } = await import("../store/rebuild.js");
    const { loadConfig } = await import("../utils/config.js");
    const config = loadConfig();
    process.stdout.write("Rebuilding knowledge index from markdown files...\n");
    const stats = await rebuildFromMarkdown(config);
    process.stdout.write(
      `Rebuild complete — Total: ${stats.total}, Created: ${stats.created}, Updated: ${stats.updated}, Errors: ${stats.errors}\n`,
    );
  });

// ---------------------------------------------------------------------------
// gyst serve — start the stdio MCP server (used by MCP tool configs)
// ---------------------------------------------------------------------------

program
  .command("serve")
  .description("Start Gyst MCP server (stdio transport) — used by AI coding tool MCP configs")
  .action(async () => {
    await import("../mcp/server.js");
  });

program.parse();
