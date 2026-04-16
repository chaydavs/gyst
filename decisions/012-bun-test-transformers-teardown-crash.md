# 012 — Bun test-runner teardown crashes with @huggingface/transformers loaded

**Status:** Active workaround. Upstream fix pending.
**Date:** 2026-04-16

## Context

On Bun 1.3.12 (macOS arm64), `bun test` of any file that loads a
`@huggingface/transformers` feature-extraction pipeline exits with code
**133** (SIGTRAP, "A C++ exception occurred") AFTER all tests pass. The
same code running under `bun run` exits 0. Calling the pipeline's
`.dispose()` method in `afterAll` does not prevent the crash.

This breaks `npm publish` — `prepublishOnly` is an `&&`-chained shell
command and a non-zero exit short-circuits the rest of the pipeline, so
the `integration` step never runs.

Reproduced in isolation with a 10-line test file. The crash does **not**
happen with `sqlite-vec` alone, with transformers under `bun run`, or with
the combination under `bun run`. Only the `bun test` teardown path fires it.

## Options considered

1. **Tolerate exit 133 in `prepublishOnly`** via
   `(bun test ./tests/... || [ $? -eq 133 ])`. One-line, matches the
   existing wrapper already in place for `tests/uniformity/` (same
   crash, same workaround). Ships today.
2. **Safer conditional wrapper** that only swallows 133 if stderr
   contains `0 fail`. ~5 lines of shell. Protects against a future real
   bug coincidentally producing exit 133. Rejected: threat model is thin
   — nothing in this repo naturally segfaults to that code.
3. **Investigate further and fix at the source.** We traced it. The
   pipeline's `.dispose()` releases the ONNX session but something else
   (worker threads or WASM allocator) survives into `bun test`'s forced
   exit and throws in C++ destructors. This is an upstream Bun + ONNX
   runtime interaction, not something we can patch from JS.

## Decision

Adopted **Option 1** — wrap both `tests/uniformity/` and
`tests/collaborative/` with `|| [ $? -eq 133 ]` in the `prepublishOnly`
script. Also added `disposeExtractor()` to `src/store/embeddings.ts` as
correct hygiene (it doesn't prevent the crash but keeps the singleton
lifecycle clean for future multi-suite runs) and wired it into the
failing test's `afterAll`.

Filed/filing an upstream Bun bug with the 10-line reproduction so a
future Bun release can remove the workaround.

## Outcome

- 107 collaborative tests pass; wrapper returns exit 0.
- `prepublishOnly` can run end-to-end.
- `disposeExtractor()` in `src/store/embeddings.ts` remains — do **not**
  remove it, it's needed for re-initialization in long-lived test
  processes even once the Bun bug is fixed.

## Reversal criteria

Drop the `|| [ $? -eq 133 ]` wrappers once either:
- A Bun release (>1.3.12) fixes the teardown crash with transformers
  loaded (verify by running the 10-line repro from the upstream ticket),
  or
- `@huggingface/transformers` releases a version whose `.dispose()`
  fully releases all native handles including worker threads.

Until then: if a new test file loads embeddings and `prepublishOnly`
starts failing again, wrap its subdirectory with the same pattern.
