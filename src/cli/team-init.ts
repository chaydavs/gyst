/**
 * `gyst team init` — flips teamMode on in .gyst-wiki.json.
 *
 * teamMode gates whether future entries (from hooks, detect-conventions,
 * `learn` tool calls with mode="team") can land in the shared team scope.
 * Personal by default so solo projects don't accidentally populate a team
 * layer nobody will read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

const CONFIG_FILE_NAME = ".gyst-wiki.json";

/**
 * Writes `teamMode: true` into the project's `.gyst-wiki.json`. Preserves any
 * existing config keys; creates the file if it does not exist.
 *
 * Returns 0 on success, 1 on any filesystem / JSON error so the CLI wrapper
 * can propagate the exit code without needing to know the internal shape.
 */
export async function initTeamModeAction(): Promise<number> {
  const configPath = join(process.cwd(), CONFIG_FILE_NAME);

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const text = readFileSync(configPath, "utf-8");
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: failed to parse ${configPath}: ${msg}\n`);
      return 1;
    }
  }

  if (config.teamMode === true) {
    process.stdout.write(
      "Team mode already active — future entries can land in the team layer.\n",
    );
    return 0;
  }

  const next = { ...config, teamMode: true };

  try {
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: failed to write ${configPath}: ${msg}\n`);
    return 1;
  }

  logger.info("team-init: teamMode enabled", { configPath });
  process.stdout.write(
    [
      "Team mode enabled.",
      "",
      "What this means:",
      "  - Auto-detected conventions (gyst detect-conventions) land in scope=team",
      "  - `learn` tool calls from MCP agents default to team scope",
      "  - Event-queue promotions can use scope hints from the classifier",
      "",
      "Personal mode is still the default for `ghost_knowledge`-adjacent work.",
      "To opt out, remove `teamMode` from .gyst-wiki.json or set it to false.",
      "",
    ].join("\n"),
  );
  return 0;
}
