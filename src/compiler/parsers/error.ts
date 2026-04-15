import { logger } from "../../utils/logger.js";
import { normalizeErrorSignature, generateFingerprint } from "../normalize.js";

export interface ParsedError {
  type: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  col?: number;
  fingerprint: string;
}

/**
 * Heuristically parses raw tool output to extract structured error data.
 * Supports:
 * - TypeScript (tsc)
 * - Node/V8 stack traces
 * - Bun/SQLite errors
 * - Prisma errors
 */
export function parseError(output: string): ParsedError | null {
  // 1. TypeScript compiler error
  // Example: src/index.ts:12:34 - error TS2322: Type 'string' is not assignable...
  const tsMatch = output.match(/((?:[\w.-]+\/)*[\w.-]+\.\w+):(\d+):(\d+) - error (TS\d+): (.*)/);
  if (tsMatch) {
    const [, file, line, col, errorCode, message] = tsMatch;
    const normalized = normalizeErrorSignature(message);
    logger.debug("Parsed TypeScript error", { errorCode, file, line });
    return {
      type: errorCode,
      message: message.trim(),
      file,
      line: parseInt(line, 10),
      col: parseInt(col, 10),
      fingerprint: generateFingerprint(errorCode, normalized, { file, function: "tsc" }),
    };
  }

  // 2. Node/V8 stack trace
  // Example: TypeError: Cannot read property 'id' of undefined
  //             at Object.<anonymous> (/path/to/file.js:12:34)
  const nodeMatch = output.match(/^(\w+): (.*)\n\s+at (.*) \((.*):(\d+):(\d+)\)/m);
  if (nodeMatch) {
    const [, type, message, fn, file, line, col] = nodeMatch;
    const normalized = normalizeErrorSignature(message);
    logger.debug("Parsed Node/V8 stack trace", { type, file, line });
    return {
      type,
      message: message.trim(),
      file,
      line: parseInt(line, 10),
      col: parseInt(col, 10),
      fingerprint: generateFingerprint(type, normalized, { file, function: fn }),
    };
  }

  // 3. Generic "Error: ..." line (fallback)
  const genericMatch = output.match(/^(\w+Error|Error): (.*)/m);
  if (genericMatch) {
    const [, type, message] = genericMatch;
    const normalized = normalizeErrorSignature(message);
    logger.debug("Parsed generic error", { type });
    return {
      type,
      message: message.trim(),
      fingerprint: generateFingerprint(type, normalized),
    };
  }

  return null;
}
