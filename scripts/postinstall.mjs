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
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
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

// Mirror of the Windows probe list in src/store/database.ts. Kept in sync so
// postinstall can warn early if no system sqlite3 is found.
function windowsSqliteProbePaths() {
  const home = homedir();
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  const windir = process.env.WINDIR ?? "C:\\Windows";
  return [
    join(programFiles, "SQLite", "sqlite3.dll"),
    join(programFilesX86, "SQLite", "sqlite3.dll"),
    "C:\\sqlite\\sqlite3.dll",
    join(windir, "System32", "sqlite3.dll"),
    join(home, "scoop", "apps", "sqlite", "current", "sqlite3.dll"),
    join(programData, "chocolatey", "lib", "SQLite", "tools", "sqlite3.dll"),
    "C:\\msys64\\mingw64\\bin\\sqlite3.dll",
    "C:\\Program Files\\Git\\mingw64\\bin\\sqlite3.dll",
  ];
}

// Emit a single-screen diagnostics block on Windows when the bundled vec0.dll
// is not loadable without a system SQLite. Stays silent on success.
function diagnoseWindows(pkgRoot) {
  if (osPlatform() !== "win32") return;
  if (process.env.GYST_SKIP_POSTINSTALL === "1") return;

  const vecPkg = `sqlite-vec-windows-${osArch() === "arm64" ? "arm64" : "x64"}`;
  const vecDll = join(pkgRoot, "node_modules", vecPkg, "vec0.dll");
  const vecDllFallback = resolve(
    pkgRoot,
    "..",
    vecPkg,
    "vec0.dll",
  );
  const vecDllPath = existsSync(vecDll)
    ? vecDll
    : existsSync(vecDllFallback)
      ? vecDllFallback
      : null;

  const hasOverride = typeof process.env.GYST_SQLITE_PATH === "string"
    && existsSync(process.env.GYST_SQLITE_PATH);
  const systemSqlite = hasOverride
    ? process.env.GYST_SQLITE_PATH
    : windowsSqliteProbePaths().find((p) => existsSync(p));

  if (vecDllPath && systemSqlite) return; // fully configured — stay quiet.

  process.stdout.write("\n");
  process.stdout.write("  gyst — Windows setup notice\n");
  process.stdout.write("  ─────────────────────────────────────\n");
  if (!vecDllPath) {
    process.stdout.write(
      `  ! sqlite-vec DLL not found (expected ${vecPkg}/vec0.dll).\n` +
        "    Semantic search will be disabled.\n",
    );
  } else {
    process.stdout.write(`  ✓ sqlite-vec DLL: ${vecDllPath}\n`);
  }
  if (!systemSqlite) {
    process.stdout.write(
      "  ! No system sqlite3.dll with extension support found.\n" +
        "    Bun's bundled SQLite cannot load extensions on Windows.\n" +
        "    Install one of:\n" +
        "      scoop install sqlite           (recommended)\n" +
        "      choco install sqlite\n" +
        "    or set GYST_SQLITE_PATH to a sqlite3.dll built with\n" +
        "    SQLITE_ENABLE_LOAD_EXTENSION=1.\n",
    );
  } else {
    process.stdout.write(`  ✓ system sqlite3: ${systemSqlite}\n`);
  }
  process.stdout.write("  Run `gyst doctor` any time for a full diagnosis.\n\n");
}

const skipReason = shouldSkip();
if (skipReason) {
  // Quiet — avoid polluting every npm i output.
  process.exit(0);
}

// The compiled CLI lives alongside this script in dist/ when published.
const pkgRoot = resolve(import.meta.dirname ?? ".", "..");
const cliPath = join(pkgRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  // Build artefact missing (tarball extraction failure or prepublish skipped).
  // Do not fail the install — the user can still invoke `gyst install` manually.
  diagnoseWindows(pkgRoot);
  process.exit(0);
}

diagnoseWindows(pkgRoot);

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
