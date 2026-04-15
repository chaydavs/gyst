#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
try {
  const input = readFileSync(0, "utf8");
  const result = execFileSync("bunx", ["gyst-mcp", "hook", "session_end"], {
    input, timeout: 4000, stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.length > 0) process.stdout.write(result);
} catch {
  process.exit(0); // never block the agent
}
