import { logger } from "../../utils/logger.js";

export interface ExtractedContext {
  files: string[];
  symbols: string[];
}

/**
 * Extracts context (files, symbols) from a user prompt for privacy-preserving
 * tracking. Does NOT return the raw prompt text.
 */
export function extractContextFromPrompt(prompt: string): ExtractedContext {
  const files = new Set<string>();
  const symbols = new Set<string>();

  // 1. Extract file paths
  // Matches relative paths with common source extensions. 
  // We use word boundaries and specific extension order to avoid partial matches.
  const fileRegex = /\b(?:(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx|jsx|json|yaml|yml|bash|zsh|ts|js|md|py|go|rs|c|cpp|h|java|kt|sh))\b/g;
  let match;
  while ((match = fileRegex.exec(prompt)) !== null) {
    files.add(match[0]);
  }

  // 2. Extract symbols in backticks
  const backtickRegex = /`([^`]+)`/g;
  while ((match = backtickRegex.exec(prompt)) !== null) {
    const symbol = match[1].trim();
    // Basic heuristic: no spaces, no slashes, not too long
    if (symbol && !symbol.includes("/") && !symbol.includes(" ") && symbol.length < 64) {
      symbols.add(symbol);
    }
  }

  // 3. Extract camelCase/PascalCase tokens (heuristically)
  const codeTokenRegex = /\b([a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;
  while ((match = codeTokenRegex.exec(prompt)) !== null) {
    const token = match[0];
    if (!files.has(token) && token.length < 64) {
      symbols.add(token);
    }
  }

  logger.debug("Extracted context from prompt", { 
    fileCount: files.size, 
    symbolCount: symbols.size 
  });

  return {
    files: Array.from(files),
    symbols: Array.from(symbols),
  };
}
