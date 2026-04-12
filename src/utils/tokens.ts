/**
 * Token counting utilities for managing AI context budgets.
 *
 * Uses the GPT/Claude average of ~4 characters per token as a fast estimator.
 * For exact counts a tiktoken binding would be needed, but this is sufficient
 * for budget-guarding purposes.
 */

const CHARS_PER_TOKEN = 4;

/**
 * Estimates the number of tokens in a string.
 *
 * @param text - The input text to measure.
 * @returns Estimated token count (rounded up).
 */
export function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncates `text` so that its estimated token count does not exceed
 * `maxTokens`. Truncation is done on character boundaries; a sentinel
 * suffix is appended to signal that content was cut.
 *
 * @param text - The input text to truncate.
 * @param maxTokens - Maximum allowed token budget.
 * @returns The (possibly truncated) text.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "… [truncated]";
  const cutAt = maxChars - suffix.length;
  if (cutAt <= 0) {
    return suffix.slice(0, maxChars);
  }
  return text.slice(0, cutAt) + suffix;
}
