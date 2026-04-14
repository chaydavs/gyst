/**
 * tests/e2e/http-e2e.test.ts
 *
 * Real E2E test: starts the HTTP server on a random port, drives it with
 * fetch() + the MCP client SDK, and validates the full team collaboration flow.
 *
 * Coverage:
 *   - Health check
 *   - Team bootstrap (create, invite, join)
 *   - Member listing
 *   - MCP tools over HTTP: learn, recall, harvest, activity, status, feedback
 *   - Auth rejection (invalid Bearer token)
 *   - CORS preflight
 *   - X-Request-Id header
 *   - Member removal
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/server/http.js";
import type { HttpServerHandle } from "../../src/server/http.js";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const dbPath = `/tmp/gyst-e2e-${Date.now()}.db`;
const port = 30000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://localhost:${port}`;

let serverHandle: HttpServerHandle;

let teamId: string;
let adminKey: string;
let inviteKeyA: string;
let inviteKeyB: string;
let devAId: string;
let memberKeyA: string;
let devBId: string;
let memberKeyB: string;

/** Entry ID captured from Dev A's learn call — used in the feedback test. */
let learnedEntryId: string;

/** Latency samples for MCP calls (ms). */
const mcpLatencies: number[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Polls GET /health until it returns 200 or retries are exhausted.
 * Throws if the server does not become ready in time.
 */
async function waitForServer(maxRetries = 20, intervalMs = 150): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) return;
    } catch {
      // Server not yet listening — swallow and retry.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Server at ${baseUrl} did not become ready after ${maxRetries} retries`);
}

/**
 * Creates a fresh MCP client connection, calls a single tool, closes the
 * client, and returns the response text.  Measures end-to-end latency and
 * appends it to mcpLatencies[].
 *
 * @param bearerKey - The API key to use as Bearer token.
 * @param toolName  - MCP tool name to invoke.
 * @param args      - Tool arguments object.
 * @returns The text content of the first content item in the tool response.
 */
async function mcpCall(
  bearerKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const t0 = performance.now();

  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${bearerKey}`,
        },
      },
    },
  );

  const client = new Client(
    { name: "e2e-test", version: "1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const result = await client.callTool({ name: toolName, arguments: args });

  await client.close();

  const elapsed = performance.now() - t0;
  mcpLatencies.push(elapsed);

  // Extract text from the first content item.
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }
  const first = content[0];
  if (first.type === "text") {
    return first.text;
  }
  return JSON.stringify(first);
}

/**
 * Convenience wrapper for authenticated JSON fetch calls to team routes.
 */
async function teamFetch(
  path: string,
  method: string,
  bearerKey: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Setup — start server and bootstrap the team
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Start server
  serverHandle = startHttpServer({ port, dbPath });

  // 2. Wait for it to be ready
  await waitForServer();

  // 3. Bootstrap: create team (unauthenticated first bootstrap)
  const createRes = await fetch(`${baseUrl}/team`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "E2E Team" }),
  });
  expect(createRes.status).toBe(201);
  const createData = (await createRes.json()) as { teamId: string; adminKey: string };
  teamId = createData.teamId;
  adminKey = createData.adminKey;

  // 4. Create invite key A
  const inviteResA = await teamFetch("/team/invite", "POST", adminKey);
  expect(inviteResA.status).toBe(201);
  const inviteDataA = (await inviteResA.json()) as { inviteKey: string };
  inviteKeyA = inviteDataA.inviteKey;

  // 5. Create invite key B
  const inviteResB = await teamFetch("/team/invite", "POST", adminKey);
  expect(inviteResB.status).toBe(201);
  const inviteDataB = (await inviteResB.json()) as { inviteKey: string };
  inviteKeyB = inviteDataB.inviteKey;

  // 6. Dev A joins
  const joinResA = await fetch(`${baseUrl}/team/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${inviteKeyA}`,
    },
    body: JSON.stringify({ displayName: "Dev A" }),
  });
  expect(joinResA.status).toBe(201);
  const joinDataA = (await joinResA.json()) as { developerId: string; memberKey: string };
  devAId = joinDataA.developerId;
  memberKeyA = joinDataA.memberKey;

  // 7. Dev B joins
  const joinResB = await fetch(`${baseUrl}/team/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${inviteKeyB}`,
    },
    body: JSON.stringify({ displayName: "Dev B" }),
  });
  expect(joinResB.status).toBe(201);
  const joinDataB = (await joinResB.json()) as { developerId: string; memberKey: string };
  devBId = joinDataB.developerId;
  memberKeyB = joinDataB.memberKey;
}, 60_000);

afterAll(async () => {
  // Latency report — p50 and p95
  if (mcpLatencies.length > 0) {
    const sorted = [...mcpLatencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    console.info(
      `E2E latencies (${sorted.length} MCP calls): ` +
        `p50=${p50.toFixed(0)}ms  p95=${p95.toFixed(0)}ms`,
    );
  }

  // Stop server
  serverHandle.stop();

  // Remove temp DB
  try {
    unlinkSync(dbPath);
  } catch {
    // Non-fatal if already gone.
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gyst HTTP E2E", () => {
  // -------------------------------------------------------------------------
  test("1. health check returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("gyst");
  }, 10_000);

  // -------------------------------------------------------------------------
  test("2. team setup — GET /team/members returns 2 members", async () => {
    const res = await teamFetch("/team/members", "GET", adminKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[] };
    expect(body.members.length).toBe(2);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("3. Dev A learns — response contains 'Learned:'", async () => {
    const text = await mcpCall(memberKeyA, "learn", {
      type: "convention",
      title: "Use async/await not callbacks",
      content:
        "Always use async/await. Callbacks cause callback hell and are harder to reason about.",
      files: ["src/server/http.ts"],
    });

    expect(text).toMatch(/Learned:/);

    // Capture the entry ID from "id: <uuid>" in the response text.
    const match = /id:\s*([\w-]{36})/i.exec(text);
    if (match !== null && match[1] !== undefined) {
      learnedEntryId = match[1];
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  test("4. Dev B recalls — finds what Dev A learned", async () => {
    const text = await mcpCall(memberKeyB, "recall", {
      query: "async await callbacks",
    });
    expect(text.toLowerCase()).toMatch(/async.?await/i);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("5. harvest over HTTP — response contains 'Harvest complete'", async () => {
    const transcript =
      "decided to use zod for all input validation because it gives us runtime type checking\n" +
      "always validate at system boundaries\n" +
      "learned that zod parse throws on invalid input";

    const text = await mcpCall(memberKeyA, "harvest", {
      transcript,
      session_id: "e2e-session-1",
    });

    expect(text).toMatch(/Harvest complete/i);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("6. activity visible — Dev B sees Dev A's actions", async () => {
    const text = await mcpCall(memberKeyB, "activity", { hours: 1 });
    // Activity log should mention Dev A's name or the "learn" action.
    const looksRight =
      /Dev A/i.test(text) ||
      /learn/i.test(text) ||
      /async/i.test(text);
    expect(looksRight).toBe(true);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("7. status over HTTP — contains dev ID or 'active'", async () => {
    const text = await mcpCall(memberKeyB, "status", { hours: 1 });
    const looksRight =
      text.includes(devAId) ||
      /active/i.test(text) ||
      /learn/i.test(text);
    expect(looksRight).toBe(true);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("8. feedback over HTTP — 'Feedback recorded'", async () => {
    // If we didn't capture an entry ID from the learn test, skip gracefully.
    if (learnedEntryId === undefined || learnedEntryId === "") {
      // Attempt to recall first to surface an entry ID.
      const recallText = await mcpCall(memberKeyB, "recall", {
        query: "async await callbacks",
      });
      const match = /id:\s*([\w-]{36})/i.exec(recallText);
      if (match !== null && match[1] !== undefined) {
        learnedEntryId = match[1];
      }
    }

    expect(learnedEntryId).toBeTruthy();

    const text = await mcpCall(memberKeyB, "feedback", {
      entry_id: learnedEntryId,
      helpful: true,
    });

    expect(text).toMatch(/Feedback recorded/i);
  }, 30_000);

  // -------------------------------------------------------------------------
  test("9. auth rejection — invalid Bearer key returns 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer gyst_invalid_badkey",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(401);
  }, 10_000);

  // -------------------------------------------------------------------------
  test("10. CORS preflight — OPTIONS /mcp returns 204 with CORS header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBeNull();
  }, 10_000);

  // -------------------------------------------------------------------------
  test("11. X-Request-Id header present on responses", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    // Should look like a UUID
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  }, 10_000);

  // -------------------------------------------------------------------------
  test("12. remove member — DELETE /team/members/:id then list shows 1", async () => {
    const delRes = await teamFetch(
      `/team/members/${devBId}`,
      "DELETE",
      adminKey,
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { success: boolean };
    expect(delBody.success).toBe(true);

    const listRes = await teamFetch("/team/members", "GET", adminKey);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { members: unknown[] };
    expect(listBody.members.length).toBe(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // New tests — search, ghost_knowledge recall, validation
  // -------------------------------------------------------------------------

  test("13. search returns compact index for known entries", async () => {
    // Dev A learns an error_pattern (memberKeyA is still valid after test 12
    // removes devB — devA is not removed)
    const learnText = await mcpCall(memberKeyA, "learn", {
      content: "Postgres pool exhausted: too many clients connecting simultaneously to the database server",
      type: "error_pattern",
      title: "Postgres pool exhausted",
    });
    // learn should succeed — response starts with "Learned:" or "Updated"
    expect(learnText).not.toMatch(/^Error/i);

    // Dev A searches using terms present in the title/content
    const searchText = await mcpCall(memberKeyA, "search", {
      query: "Postgres pool exhausted clients",
    });

    expect(searchText).toContain("Postgres pool exhausted");
    // The search header always contains "get_entry" usage hint
    expect(searchText).toContain("get_entry");

    // Parse an entry id from the first result line (format: "id · type · …")
    const idMatch = searchText.match(/^([a-z0-9-]{36}) ·/m);
    if (idMatch !== null && idMatch[1] !== undefined) {
      const entryId = idMatch[1];
      const detailText = await mcpCall(memberKeyA, "get_entry", { id: entryId });
      expect(detailText).toContain("Postgres");
    }
  }, 30_000);

  // -------------------------------------------------------------------------

  test("14. convention entries appear with Convention prefix in recall", async () => {
    // Dev A learns a convention entry
    await mcpCall(memberKeyA, "learn", {
      content: "Never deploy to production on Fridays — too risky to debug over the weekend",
      type: "convention",
      title: "No Friday production deploys",
    });

    // Recall using terms present in the title and content
    const recallText = await mcpCall(memberKeyA, "recall", {
      query: "No Friday production deploys",
    });
    // recall prefixes convention entries with "📏 Convention:"
    expect(recallText).toContain("📏 Convention:");
  }, 30_000);

  // -------------------------------------------------------------------------

  test("15. search rejects query shorter than 2 characters", async () => {
    let errorSeen = false;
    try {
      const text = await mcpCall(memberKeyA, "search", { query: "x" });
      // If mcpCall returns text instead of throwing, check for error indicators
      const lower = text.toLowerCase();
      errorSeen =
        lower.includes("error") ||
        lower.includes("invalid") ||
        lower.includes("too_small") ||
        lower.includes("string must contain");
    } catch {
      // MCP SDK may surface validation errors as thrown exceptions
      errorSeen = true;
    }
    expect(errorSeen).toBe(true);
  }, 10_000);

  // -------------------------------------------------------------------------

  test("16. mcpLatencies includes entries from search and get_entry calls", () => {
    // mcpCall() appends to the module-level mcpLatencies array on every call.
    // Tests 13–15 each make at least one mcpCall, so by the time this test
    // runs the array must have grown beyond the 8 calls made in tests 3–8.
    // We simply verify that the reporter will have data to work with.
    expect(mcpLatencies.length).toBeGreaterThan(8);
    // All recorded latencies must be non-negative finite numbers.
    const invalid = mcpLatencies.filter((ms) => !isFinite(ms) || ms < 0);
    expect(invalid).toHaveLength(0);
  });
});
