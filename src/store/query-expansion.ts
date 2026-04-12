/**
 * Query expansion for natural-language queries.
 *
 * Addresses the vocabulary mismatch between how users ask questions
 * ("why did we choose X") and how entries are titled ("Why we chose X over Y").
 *
 * Key insight: FTS5 uses implicit AND for multi-word queries, so simply
 * appending synonyms would ADD more required terms and make queries HARDER
 * to satisfy. Instead, synonyms are injected as FTS5 OR expressions:
 *   "choose" → "choose OR chose"
 *
 * This means the document only needs to contain ONE of the alternatives.
 *
 * Additional transformations:
 *  - FTS5 NOT operator: bare "not" in a query is treated by FTS5 as an
 *    exclusion operator. We strip stop words that have no index value but
 *    that FTS5 would misinterpret (did, not, we, it, to, how, why, should).
 *
 * Design principles:
 *  - Only map terms that stem differently under Porter (e.g. choose→choos
 *    vs chose→chos) — stemmer already handles regular inflections.
 *  - Keep the map small; every synonym is a potential source of noise.
 */

/**
 * Words that cause FTS5 mismatch or false exclusions when left in the query.
 * - "not" is an FTS5 NOT operator (causes exclusion of following term).
 * - Common stop words that rarely appear verbatim in entry text.
 */
const FTS5_PROBLEM_WORDS = new Set([
  "not",
  "did",
  "do",
  "does",
  "we",
  "our",
  "it",
  "to",
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "be",
  "of",
  "in",
  "on",
  "for",
  "at",
  "by",
]);

/**
 * Maps a query term to a list of synonyms that should be ORed with the
 * original term. Only covers terms where the Porter stemmer produces
 * DIFFERENT roots (so the stemmer won't handle them automatically), or
 * abbreviated vs full forms.
 *
 * Format: { original: [...alternatives] }
 * The FTS5 expression emitted is: (original OR alt1 OR alt2 ...)
 */
const SYNONYM_MAP: Record<string, readonly string[]> = {
  // choose/chose stem to "choos" vs "chos" — different roots.
  choose: ["chose"],
  chose: ["choose"],
  pick: ["chose"],
  picked: ["chose", "selected"],
  selected: ["chose", "picked"],

  // "postgres" is a prefix of "postgresql" but FTS5 treats full token;
  // bare "postgres" will not match entries that say "postgresql".
  postgres: ["postgresql"],
  postgresql: ["postgres"],

  // "failing" and "leaking" — no shared stem.
  // "tests failing open handles" → needs "leaking" to hit entry about
  // "async test leaking open handles".
  failing: ["leaking"],

  // "reranker" vs "re-ranker" (hyphen stripped → "re ranker" = two tokens)
  reranker: ["ranker"],

  // "duplicate" helps find UNIQUE constraint entries ("UNIQUE" key word).
  duplicate: ["constraint"],

  // Migration vocabulary
  switch: ["migrate"],
  switched: ["migrated"],
  migrate: ["switch"],
};

/**
 * Expands a query string into an FTS5-compatible expression that uses OR
 * for synonym groups and removes stop words / FTS5 operator words.
 *
 * IMPORTANT: FTS5 requires EXPLICIT `AND` between tokens when any token is
 * a parenthesised OR group. Implicit AND only works when all tokens are
 * plain terms. So we always join with ` AND ` when at least one OR group
 * is present, and fall back to plain juxtaposition otherwise.
 *
 * Examples:
 *   "why did we choose bun over node"
 *   → "why AND (choose OR chose) AND bun AND over AND node"
 *
 *   "postgres connection pool"
 *   → "(postgres OR postgresql) AND connection AND pool"
 *
 *   "plain query no synonyms"
 *   → "plain query no synonyms"   (no OR groups, plain juxtaposition)
 *
 * @param query - The raw user query string.
 * @returns An FTS5-compatible query expression.
 */
export function expandQuery(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  let hasOrGroup = false;

  for (const word of words) {
    // Strip FTS5 problem words (stop words and operator keywords like "not").
    if (FTS5_PROBLEM_WORDS.has(word)) {
      continue;
    }

    const synonyms = SYNONYM_MAP[word];
    if (synonyms !== undefined && synonyms.length > 0) {
      // Emit an OR group so only ONE alternative needs to match.
      tokens.push(`(${word} OR ${synonyms.join(" OR ")})`);
      hasOrGroup = true;
    } else {
      tokens.push(word);
    }
  }

  // When the expression contains at least one OR group, FTS5 needs explicit
  // AND between every token. Otherwise plain space-separation is fine.
  return hasOrGroup ? tokens.join(" AND ") : tokens.join(" ");
}

/**
 * Detects whether a query is a natural-language "why" or "reasoning" query
 * that should boost decision entries in the result ranking.
 */
export function isReasoningQuery(query: string): boolean {
  return /\b(why|reason|rationale|decision|chose|choose|picked|selected)\b/i.test(
    query,
  );
}
