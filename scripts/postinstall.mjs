#!/usr/bin/env node
/**
 * npm postinstall hook for gyst-mcp.
 *
 * Auto-runs `gyst install` in quiet mode when the user globally installs the
 * package so their MCP client (Claude Code / Cursor / Codex / etc.) picks up
 * the server without an extra manual step.
 *
 * Safe-by-default: any failure is swallowed and the npm install is never
 * broken. Skipped in CI, during local dev installs of this repo, and when
 * the user explicitly opts out with GYST_SKIP_POSTINSTALL=1.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function shouldSkip() {
  if (process.env.GYST_SKIP_POSTINSTALL === "1") return "GYST_SKIP_POSTINSTALL set";
  if (process.env.CI === "true" || process.env.CI === "1") return "CI detected";
  if (process.env.npm_config_global !== "true") return "not a global install";
  // Local dev install: running inside the source repo. Detect by checking for
  // the canonical tsconfig + src/cli alongside package.json.
  const pkgDir = process.env.INIT_CWD ?? process.cwd();
  if (existsSync(join(pkgDir, "src", "cli", "index.ts"))) {
    return "source repo detected";
  }
  return null;
}

const skipReason = shouldSkip();
if (skipReason) {
  // Quiet — avoid polluting every npm i output.
  process.exit(0);
}

// The compiled CLI lives alongside this script in dist/ when published.
const cliPath = resolve(import.meta.dirname ?? ".", "..", "dist", "cli.js");
if (!existsSync(cliPath)) {
  // Build artefact missing (tarball extraction failure or prepublish skipped).
  // Do not fail the install — the user can still invoke `gyst install` manually.
  process.exit(0);
}

// `gyst install --minimal` is the non-interactive path — idempotent, safe to
// re-run, and already short-circuits when a tool's config already references
// Gyst. `bun` is required to execute the shebang; the absence of bun is a
// valid reason to bail silently (the user can install bun + re-run later).
const bun = process.env.npm_node_execpath?.includes("bun")
  ? process.execPath
  : "bun";
const result = spawnSync(bun, [cliPath, "install", "--minimal"], {
  stdio: "inherit",
});
void result;

// Never surface a non-zero exit — npm will abort the user's install otherwise.
process.exit(0);
