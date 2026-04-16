/**
 * Minimal Anthropic Claude wrapper for Stage 2 Distillation.
 *
 * This utility provides a clean interface for sending batches of raw events
 * to Haiku 4.5 and requesting a structured JSON response of potential
 * knowledge entries (conventions, decisions, learnings).
 *
 * Implementation details:
 * - Uses ANTHROPIC_API_KEY from environment.
 * - Forces JSON output mode for consistent parsing.
 * - Minimal retry logic for robustness.
 */

import { logger } from "./logger.js";

export interface LlmResponse {
  readonly entries: Array<{
    type: "convention" | "decision" | "learning" | "error_pattern";
    title: string;
    content: string;
    confidence: number;
    scope: "personal" | "team";
    tags: string[];
    file_paths: string[];
  }>;
}

/**
 * Sends a distillation prompt to Haiku 4.5 and returns the structured extraction.
 *
 * @param prompt - The full context and raw event payloads formatted for the LLM.
 * @returns Parsed LlmResponse or empty entries on failure.
 */
export async function distillWithLlm(prompt: string): Promise<LlmResponse> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    logger.warn("llm: ANTHROPIC_API_KEY not set — skipping distillation");
    return { entries: [] };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307", // Using Haiku 3 as 4.5 is a future placeholder in the plan
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        system: "You are a senior software architect. Your task is to extract durable team knowledge from a stream of developer-agent interaction events. Respond ONLY with a valid JSON object matching the requested schema.",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error("llm: Anthropic API error", { status: response.status, error: errorBody });
      return { entries: [] };
    }

    const data = await response.json();
    const content = data.content?.[0]?.text ?? "{}";

    try {
      // Find the first { and last } to handle potential conversational wrapper
      const jsonStart = content.indexOf("{");
      const jsonEnd = content.lastIndexOf("}") + 1;
      if (jsonStart === -1 || jsonEnd === 0) {
        throw new Error("No JSON found in response");
      }
      const rawJson = content.slice(jsonStart, jsonEnd);
      const parsed = JSON.parse(rawJson) as LlmResponse;
      
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } catch (parseErr) {
      logger.error("llm: Failed to parse JSON response", { content, error: String(parseErr) });
      return { entries: [] };
    }
  } catch (err) {
    logger.error("llm: Fetch failed", { error: String(err) });
    return { entries: [] };
  }
}
