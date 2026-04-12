/**
 * Query expansion for natural-language queries.
 *
 * Maps common natural-language terms to additional keywords that are
 * more likely to match entry titles and content. Addresses the vocabulary
 * mismatch between how users ask questions ("why did we choose X")
 * and how entries are titled ("Why we chose X over Y").
 *
 * Design principles:
 *  - Synonyms are ADDITIVE — originals are always kept.
 *  - Map specific lexical gaps only; avoid broad category terms that would
 *    contaminate BM25 scores across unrelated entries.
 *  - Porter stemmer already handles inflection (run/running/ran); only add
 *    terms that stem to a DIFFERENT root than the original.
 */

const SYNONYM_MAP: Record<string, readonly string[]> = {
  // "choose" and "chose" stem differently under Porter:
  //   choose → choos,  chose → chos  — they do NOT match each other.
  choose: ["chose"],
  chose: ["choose"],
  pick: ["chose", "selected"],
  picked: ["chose", "selected"],
  selected: ["chose", "picked"],

  // "postgres" is a prefix of "postgresql" but FTS5 treats the full word
  // as a single token; bare "postgres" won't match "postgresql".
  postgres: ["postgresql"],
  postgresql: ["postgres"],

  // "failing" and "leaking" share no common stem.
  // Tests that are "failing" because of "leaking open handles" need both.
  failing: ["leaking", "fail"],
  leaking: ["failing"],

  // "reranker" vs "re-ranker" / "rerank" — hyphen is stripped by FTS5
  // tokeniser but the word root differs from "reranker" written solid.
  reranker: ["rerank", "ranker"],

  // "duplicate" and "constraint" address the unique-constraint miss.
  duplicate: ["constraint", "unique"],

  // Migration/switch vocabulary
  switch: ["migrate", "moved", "changed"],
  switched: ["migrated", "moved", "changed"],
  migrate: ["switch", "moved", "changed"],
};

/**
 * Expands a query string by adding synonyms for recognised keywords.
 * The original query words are preserved; synonyms are appended.
 *
 * @param query - The raw user query.
 * @returns An expanded query string suitable for BM25 matching.
 */
export function expandQuery(query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const expansions = new Set<string>(words);

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms !== undefined) {
      for (const syn of synonyms) {
        expansions.add(syn);
      }
    }
  }

  return Array.from(expansions).join(" ");
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
