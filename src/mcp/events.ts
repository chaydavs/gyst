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
    case "commit":
    case "pre_compact": // Standard mapping for Claude's PreCompact
      logger.info(`Event [${type}]: Triggering auto-harvest`);
      await runHarvestSession(); // Currently relies on filesystem discovery
      break;

    case "pull":
      logger.info(`Event [${type}]: Triggering auto-rebuild`);
      await rebuildFromMarkdown(config);
      break;

    case "session_start":
      logger.info("Event [session_start]: Session initiated", { payload });
      // Future: Proactive dashboarding link or active context injection
      break;

    case "tool_use":
      logger.debug("Event [tool_use]: Signal captured", { payload });
      break;

    default:
      logger.debug(`Event [${type}]: No specific handler defined`, { payload });
  }
}
