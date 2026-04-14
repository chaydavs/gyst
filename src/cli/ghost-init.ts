#!/usr/bin/env bun
/**
 * Ghost-init CLI — interactive onboarding to capture tribal team knowledge.
 *
 * Asks a curated set of questions about unwritten team rules and stores
 * each non-empty answer as a `ghost_knowledge` entry in the knowledge base.
 * These entries have infinite half-life (never decay) and are always
 * surfaced in recall results above the confidence threshold.
 *
 * Run via: gyst ghost-init
 */

import type { Database } from "bun:sqlite";
import { initDatabase, insertEntry } from "../store/database.js";
import { extractEntry } from "../compiler/extract.js";
import type { LearnInput } from "../compiler/extract.js";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Question set
// ---------------------------------------------------------------------------

/**
 * Curated onboarding questions that surface tribal knowledge new hires
 * are likely to learn the hard way.
 */
export const QUESTIONS: readonly { readonly id: string; readonly prompt: string }[] = [
  {
    id: "onboarding",
    prompt: "What's something every new hire learns the hard way in their first month?",
  },
  {
    id: "sacred_files",
    prompt:
      "Are there any files, modules, or services that should never be modified without checking with someone? (list paths if possible)",
  },
  {
    id: "deploy_rules",
    prompt: "What deployment rules does your team follow that aren't written down?",
  },
  {
    id: "historical",
    prompt:
      "Are there any past technical decisions the team made that new people should know about?",
  },
  {
    id: "conventions",
    prompt:
      "What patterns or conventions does the team follow that aren't in a linter or style guide?",
  },
  {
    id: "dont_touch",
    prompt:
      "Is there anything that looks like it should be changed but shouldn't be touched? Why?",
  },
  {
    id: "common_mistake",
    prompt:
      "What's the most common mistake someone makes when working on this codebase for the first time?",
  },
] as const;

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Extracts file paths from a free-form answer string using a simple regex.
 *
 * Matches patterns like `src/billing/service.ts`, `./config.json`,
 * `lib/utils.js`, etc. Does not require the path to exist on disk.
 *
 * @param text - The raw answer text to scan.
 * @returns Deduplicated array of extracted file path strings.
 */
export function extractFilePaths(text: string): string[] {
  const matches = text.match(/[\w\-./]+\.\w{1,6}/g) ?? [];
  // Deduplicate preserving first-seen order (immutable — never mutates input).
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const match of matches) {
    if (!seen.has(match)) {
      seen.add(match);
      unique.push(match);
    }
  }
  return unique;
}

/**
 * Derives a concise title from a question id and the first ~80 chars of
 * the answer. Produces a stable, human-readable title for the stored entry.
 *
 * @param questionId - The question identifier (e.g. `"deploy_rules"`).
 * @param answer     - The full answer text.
 * @returns Title string of at most 80 characters.
 */
export function deriveTitle(questionId: string, answer: string): string {
  // Convert snake_case question id to a readable prefix.
  const prefix = questionId
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  // Take first sentence or first 60 chars of answer.
  const firstSentence = answer.split(/[.!?\n]/)[0]?.trim() ?? answer.trim();
  const snippet =
    firstSentence.length > 60 ? firstSentence.slice(0, 60).trimEnd() : firstSentence;

  const candidate = `${prefix}: ${snippet}`;
  return candidate.length > 80 ? candidate.slice(0, 80).trimEnd() : candidate;
}

/**
 * Reads a single line from stdin, printing a prompt first.
 *
 * @param prompt - Text to display before the input cursor.
 * @returns The trimmed line entered by the user, or "" on EOF.
 */
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(`${prompt}\n> `);
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes("\n")) {
      break;
    }
  }

  reader.releaseLock();
  return buffer.split("\n")[0]!.trim();
}

// ---------------------------------------------------------------------------
// Main onboarding flow
// ---------------------------------------------------------------------------

/**
 * Runs the interactive ghost-init onboarding session.
 *
 * Iterates over all questions, prompts for answers, skips blank responses,
 * and persists each non-empty answer as a `ghost_knowledge` entry.
 *
 * @param db - Optional open database (for testing). When omitted, a new
 *   database is opened using the default config path.
 * @returns The count of entries successfully created.
 */
export async function runGhostInit(db?: Database): Promise<number> {
  const config = loadConfig();
  const ownDb = db === undefined;
  const database = db ?? initDatabase(config.dbPath);

  try {
    process.stdout.write(
      "\n=== Gyst Ghost-Init: Capture Tribal Team Knowledge ===\n" +
        "Answer each question with any tribal knowledge from your team.\n" +
        "Press Enter to skip a question.\n\n",
    );

    let created = 0;

    for (const question of QUESTIONS) {
      const answer = await readLine(question.prompt);

      if (answer.length === 0) {
        logger.debug("ghost-init: skipped question", { questionId: question.id });
        continue;
      }

      const files = extractFilePaths(answer);
      const title = deriveTitle(question.id, answer);

      const learnInput: LearnInput = {
        type: "ghost_knowledge",
        title,
        content: answer,
        files,
        tags: ["ghost", question.id],
        confidence: 1.0,
        scope: "team",
      };

      const entry = extractEntry(learnInput);
      insertEntry(database, entry);

      // Embed ghost knowledge entries for semantic search
      if (typeof process !== "undefined") {
        const { canLoadExtensions } = await import("../store/database.js");
        if (canLoadExtensions()) {
          const { embedAndStore } = await import("../store/embeddings.js");
          const embeddingText = `${entry.title}\n\n${entry.content}`;
          embedAndStore(database, entry.id, embeddingText).catch((err: unknown) => {
            logger.warn("Failed to embed ghost entry", { id: entry.id, error: String(err) });
          });
        }
      }

      created += 1;

      process.stdout.write(`  [+] Captured: ${title}\n`);
      logger.info("ghost-init: entry created", {
        entryId: entry.id,
        questionId: question.id,
        files: files.length,
      });
    }

    return created;
  } finally {
    if (ownDb) {
      database.close();
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const count = await runGhostInit();
  process.stdout.write(`\n${count} ghost knowledge ${count === 1 ? "entry" : "entries"} captured.\n`);
}
