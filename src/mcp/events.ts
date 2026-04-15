import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import {
  getPendingEvents,
  markEventCompleted,
  markEventFailed,
  EventType,
} from "../store/events.js";
import { runHarvestSession } from "../cli/harvest.js";
import { rebuildFromMarkdown } from "../store/rebuild.js";
import { loadConfig } from "../utils/config.js";
import { parseLatestCommit } from "../compiler/parsers/commit.js";
import { parseError } from "../compiler/parsers/error.js";
import { extractContextFromPrompt } from "../compiler/parsers/prompt.js";
import { insertEntry, canLoadExtensions } from "../store/database.js";
import { embedAndStore } from "../store/embeddings.js";

/**
 * Starts the background event processing loop.
 * Polling interval defaults to 5 seconds.
 */
export function startEventProcessor(db: Database): void {
  const POLLING_INTERVAL_MS = 5000;

  logger.info("Starting background event processor");

  const processNextBatch = async () => {
    try {
      const events = getPendingEvents(db);
      if (events.length === 0) {
        return;
      }

      logger.info(`Processing ${events.length} pending events`);

      for (const event of events) {
        try {
          await handleEvent(db, event.type, JSON.parse(event.payload));
          markEventCompleted(db, event.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`Failed to process event ${event.id}`, { error: msg });
          markEventFailed(db, event.id, msg);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Event processor batch failed", { error: msg });
    }
  };

  // Run immediately then poll
  processNextBatch();
  setInterval(processNextBatch, POLLING_INTERVAL_MS);
}

/**
 * Dispatches events to their respective handlers.
 */
async function handleEvent(
  db: Database,
  type: EventType,
  payload: any,
): Promise<void> {
  const config = loadConfig();

  switch (type) {
    case "session_end":
    case "pre_compact":
      logger.info(`Event [${type}]: Triggering auto-harvest`);
      await runHarvestSession();
      break;

    case "commit": {
      logger.info(`Event [${type}]: Processing commit autonomously`);
      const parsed = await parseLatestCommit(process.cwd());
      if (parsed) {
        const id = crypto.randomUUID();
        insertEntry(db, {
          id,
          type: parsed.type,
          title: parsed.title,
          content: parsed.content,
          files: parsed.files,
          tags: ["auto-commit"],
          confidence: 0.7,
          sourceCount: 1,
          sourceTool: "git",
        });
        if (canLoadExtensions()) {
          try {
            await embedAndStore(db, id, `${parsed.title}\n\n${parsed.content}`);
          } catch (e) {
            logger.warn("Failed to embed autonomous commit entry", { error: e });
          }
        }
        logger.info("Autonomous commit knowledge captured", { id, title: parsed.title });
      }
      await runHarvestSession();
      break;
    }

    case "error": {
      logger.info("Event [error]: Processing tool error autonomously");
      const rawError = payload.error || payload.raw || String(payload);
      const parsed = parseError(rawError);
      if (parsed) {
        const id = crypto.randomUUID();
        insertEntry(db, {
          id,
          type: "error_pattern",
          title: `Auto-detected: ${parsed.type}`,
          content: parsed.message,
          files: parsed.file ? [parsed.file] : [],
          tags: ["auto-error"],
          errorSignature: parsed.fingerprint,
          confidence: 0.6,
          sourceCount: 1,
          sourceTool: "error-parser",
        });
        if (canLoadExtensions()) {
          try {
            await embedAndStore(db, id, `${parsed.type}\n\n${parsed.message}`);
          } catch (e) {
            logger.warn("Failed to embed autonomous error entry", { error: e });
          }
        }
      }
      break;
    }

    case "prompt": {
      const context = extractContextFromPrompt(payload.prompt || payload.raw || "");
      logger.info("Event [prompt]: Context extracted (privacy-preserved)", { 
        files: context.files.length,
        symbols: context.symbols.length 
      });
      // Future: Update ephemeral active_context table
      break;
    }

    case "pull":
      logger.info(`Event [${type}]: Triggering auto-rebuild`);
      await rebuildFromMarkdown(config);
      break;

    case "session_start":
      logger.info("Event [session_start]: Session initiated", { payload });
      break;

    case "tool_use":
      logger.debug("Event [tool_use]: Signal captured", { payload });
      break;

    default:
      logger.debug(`Event [${type}]: No specific handler defined`, { payload });
  }
}
