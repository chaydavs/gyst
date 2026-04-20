/**
 * `gyst doctor` — one-screen diagnostics for environment + install health.
 *
 * Prints whether the SQLite extension loader is configured, where the
 * sqlite-vec extension is found, whether the project's DB is reachable,
 * and which MCP clients / git hooks are wired up. Exits 1 if anything
 * critical is broken so users can pipe it into scripts.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import { join } from "node:path";
import {
  canLoadExtensions,
  getSqliteProbePaths,
  probeCustomSqlite,
} from "../store/database.js";
import { findProjectRoot, loadConfig } from "../utils/config.js";

const OK = "✓";
const WARN = "!";
const FAIL = "✗";

interface Check {
  readonly label: string;
  readonly status: "ok" | "warn" | "fail";
  readonly detail?: string;
  readonly hint?: string;
}

function symbol(status: Check["status"]): string {
  return status === "ok" ? OK : status === "warn" ? WARN : FAIL;
}

function vecPackageName(): string {
  const plat = osPlatform();
  const arch = osArch();
  if (plat === "win32") return `sqlite-vec-windows-${arch === "arm64" ? "arm64" : "x64"}`;
  const os = plat === "darwin" ? "darwin" : "linux";
  return `sqlite-vec-${os}-${arch}`;
}

function vecExtensionSuffix(): string {
  const plat = osPlatform();
  if (plat === "win32") return "dll";
  if (plat === "darwin") return "dylib";
  return "so";
}

async function resolveVecPath(): Promise<string | null> {
  try {
    const mod = await import("sqlite-vec");
    const p: string = (mod as { getLoadablePath: () => string }).getLoadablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function checkEnvironment(): Check[] {
  const plat = osPlatform();
  const arch = osArch();
  const bunVersion = typeof Bun !== "undefined" ? Bun.version : "(not Bun)";
  return [
    {
      label: "Platform",
      status: "ok",
      detail: `${plat}-${arch} · bun ${bunVersion} · node ${process.version}`,
    },
  ];
}

function checkSqlite(): Check[] {
  const probe = probeCustomSqlite();
  const paths = getSqliteProbePaths();
  const tried = probe.tried.map(
    (t) => `    ${t.exists ? "found" : "miss "} ${t.path}${t.error ? ` — ${t.error}` : ""}`,
  );
  const results: Check[] = [];
  const override = process.env["GYST_SQLITE_PATH"];
  if (override) {
    results.push({
      label: "GYST_SQLITE_PATH",
      status: existsSync(override) ? "ok" : "fail",
      detail: override,
      hint: existsSync(override)
        ? undefined
        : "Path does not exist — unset the env var or fix the path.",
    });
  }
  if (probe.applied) {
    results.push({
      label: "Custom SQLite (extension loader)",
      status: "ok",
      detail: probe.appliedPath,
    });
  } else {
    const guidance =
      osPlatform() === "win32"
        ? "Install SQLite (scoop install sqlite / choco install sqlite) or set GYST_SQLITE_PATH to a sqlite3.dll built with SQLITE_ENABLE_LOAD_EXTENSION=1."
        : osPlatform() === "darwin"
          ? "Install SQLite via Homebrew: brew install sqlite"
          : "Install libsqlite3: apt-get install libsqlite3-0 (Debian/Ubuntu) or equivalent.";
    results.push({
      label: "Custom SQLite (extension loader)",
      status: "warn",
      detail: "falling back to Bun's bundled SQLite — semantic search disabled",
      hint: `${guidance}\n    Probed paths:\n${tried.join("\n") || `    ${paths.join("\n    ")}`}`,
    });
  }
  return results;
}

async function checkVec(): Promise<Check[]> {
  const pkg = vecPackageName();
  const vecPath = await resolveVecPath();
  if (vecPath) {
    return [
      {
        label: `sqlite-vec extension (${pkg})`,
        status: "ok",
        detail: vecPath,
      },
    ];
  }
  return [
    {
      label: `sqlite-vec extension (${pkg})`,
      status: "warn",
      detail: `vec0.${vecExtensionSuffix()} not found in node_modules/${pkg}`,
      hint:
        "Reinstall with npm install gyst-mcp (ensures optional platform dep is installed),\n" +
        "    or set GYST_SKIP_POSTINSTALL=0 and reinstall.",
    },
  ];
}

async function checkExtensionLoad(): Promise<Check[]> {
  if (!canLoadExtensions()) {
    return [
      {
        label: "Extension load test",
        status: "warn",
        detail: "skipped — no extension-capable SQLite available",
      },
    ];
  }
  const vecPath = await resolveVecPath();
  if (!vecPath) {
    return [
      {
        label: "Extension load test",
        status: "warn",
        detail: "skipped — sqlite-vec DLL not resolvable",
      },
    ];
  }
  try {
    const db = new Database(":memory:");
    db.loadExtension(vecPath);
    db.run("CREATE VIRTUAL TABLE t USING vec0(id TEXT PRIMARY KEY, v FLOAT[8])");
    db.close();
    return [
      { label: "Extension load test", status: "ok", detail: "vec0 loaded + virtual table OK" },
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        label: "Extension load test",
        status: "fail",
        detail: msg,
        hint: "The SQLite at the probed path exists but refuses to load vec0. Rebuild it with SQLITE_ENABLE_LOAD_EXTENSION=1, or point GYST_SQLITE_PATH at a compliant build.",
      },
    ];
  }
}

function checkProject(): Check[] {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    return [
      {
        label: "Project",
        status: "warn",
        detail: "no .gyst/ folder found from cwd — run `gyst install` to set one up",
      },
    ];
  }
  try {
    const config = loadConfig(root);
    const dbExists = existsSync(config.dbPath);
    const wikiExists = existsSync(config.wikiDir);
    return [
      { label: "Project root", status: "ok", detail: root },
      {
        label: "Database",
        status: dbExists ? "ok" : "warn",
        detail: `${config.dbPath}${dbExists ? "" : " (not yet created)"}`,
      },
      {
        label: "Wiki directory",
        status: wikiExists ? "ok" : "warn",
        detail: `${config.wikiDir}${wikiExists ? "" : " (missing — autoExport will fail)"}`,
      },
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{ label: "Project config", status: "fail", detail: msg }];
  }
}

function checkMcpConfigs(): Check[] {
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const candidates: readonly { name: string; path: string }[] = [
    { name: "Claude Code", path: join(root, ".mcp.json") },
    { name: "Cursor", path: join(root, ".cursor", "mcp.json") },
    { name: "Gemini CLI", path: join(home, ".gemini", "settings.json") },
    {
      name: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
  ];
  const found = candidates.filter((c) => existsSync(c.path));
  if (found.length === 0) {
    return [
      {
        label: "MCP clients",
        status: "warn",
        detail: "no configs detected — run `gyst install` after your AI tool is configured",
      },
    ];
  }
  return [
    {
      label: "MCP clients",
      status: "ok",
      detail: found.map((f) => `${f.name} (${f.path})`).join(", "),
    },
  ];
}

function checkGitHooks(): Check[] {
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  const hook = join(root, ".git", "hooks", "post-commit");
  if (!existsSync(hook)) {
    return [
      {
        label: "Git post-commit hook",
        status: "warn",
        detail: "not installed — run `gyst install` inside a git repo",
      },
    ];
  }
  return [{ label: "Git post-commit hook", status: "ok", detail: hook }];
}

function renderCheck(check: Check): string {
  const sym = symbol(check.status);
  const head = check.detail ? `  ${sym} ${check.label}: ${check.detail}` : `  ${sym} ${check.label}`;
  if (!check.hint) return head;
  return `${head}\n      ${check.hint.replace(/\n/g, "\n      ")}`;
}

export async function runDoctor(): Promise<void> {
  process.stdout.write("\ngyst doctor — environment report\n");
  process.stdout.write("─".repeat(56) + "\n");

  const sections: readonly { title: string; checks: readonly Check[] }[] = [
    { title: "Environment", checks: checkEnvironment() },
    { title: "SQLite", checks: checkSqlite() },
    { title: "sqlite-vec", checks: await checkVec() },
    { title: "Extension loader", checks: await checkExtensionLoad() },
    { title: "Project", checks: checkProject() },
    { title: "AI tooling", checks: [...checkMcpConfigs(), ...checkGitHooks()] },
  ];

  let hasFail = false;
  let hasWarn = false;
  for (const section of sections) {
    process.stdout.write(`\n${section.title}\n`);
    for (const check of section.checks) {
      if (check.status === "fail") hasFail = true;
      if (check.status === "warn") hasWarn = true;
      process.stdout.write(renderCheck(check) + "\n");
    }
  }

  process.stdout.write("\n" + "─".repeat(56) + "\n");
  if (hasFail) {
    process.stdout.write("Result: ✗ problems detected — fix items marked ✗ above.\n\n");
    process.exit(1);
  }
  if (hasWarn) {
    process.stdout.write("Result: ! usable, but some optional features are off.\n\n");
    return;
  }
  process.stdout.write("Result: ✓ everything looks healthy.\n\n");
}
