import { test, expect } from "bun:test";
import { initDatabase } from "../../src/store/database.js";
import { getPendingEvents } from "../../src/store/events.js";
import { instrumentServer } from "../../src/mcp/register-tools.js";

test("instrumentServer wraps tool handlers to emit tool_use events", async () => {
  const db = initDatabase(":memory:");
  
  // A minimal mock of McpServer
  const mockServer: any = {
    tool: function(name: string, description: string, schema: any, handler: Function) {
      this.registeredHandler = handler;
    },
    registeredHandler: null as Function | null,
  };

  // 1. Instrument the server
  instrumentServer(mockServer, db);

  // 2. Register a tool
  const toolHandler = async (args: any) => {
    return { content: [{ type: "text", text: `Hello ${args.name}` }] };
  };

  mockServer.tool("greet", "Greets the user", {}, toolHandler);

  // 3. Verify handler was wrapped
  expect(mockServer.registeredHandler).not.toBe(toolHandler);
  expect(typeof mockServer.registeredHandler).toBe("function");

  // 4. Call the wrapped handler
  const result = await mockServer.registeredHandler({ name: "World" });
  expect(result.content[0].text).toBe("Hello World");

  // 5. Verify event was emitted
  const events = getPendingEvents(db);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("tool_use");
  
  const payload = JSON.parse(events[0].payload);
  expect(payload.tool).toBe("greet");
  expect(payload.args).toEqual({ name: "World" });
  expect(typeof payload.ts).toBe("number");

  db.close();
});
