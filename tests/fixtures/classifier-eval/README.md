# Classifier evaluation fixture corpus

Ground-truth labels for the three-stage classifier (rules → graphify rerank → LLM distill).

Consumed by:
- `src/compiler/classify-eval.ts` — bloat score, per-type precision/recall/F1
- `tests/compiler/classify-eval.test.ts` — smoke test against this corpus

## File layout

- `labels.jsonl` — one labelled row per line. See schema below.
- `schema.ts` — Zod schema; source of truth for row shape.

## Row schema

```jsonc
{
  "id": "adv-001",                           // unique per row, stable across sessions
  "event_type": "prompt",                    // prompt | tool_use | plan_added | commit | md_change
  "payload": { "text": "..." },              // real or synthesised payload the classifier would see
  "expected": {
    "candidateType": "convention",           // convention | error_pattern | decision | learning | null
    "scopeHint": "team",                     // personal | team | uncertain
    "subcategory": "naming",                 // free-form label for downstream bucketing (optional)
    "signalStrengthMin": 0.5,                // optional tolerance bounds
    "signalStrengthMax": 1.0
  },
  "split": "train",                          // train | test — test set is sacred, no tuning
  "source": "adversarial",                   // adversarial | real
  "notes": "soft qualifier 'sometimes'..."   // optional labeller rationale
}
```

### `expected.candidateType: null`

Means "the classifier should NOT promote this event into a curated entry".
Adversarial rows for the bloat failure modes use this to assert rejection.

### `split`

- `train` — rows you may tune rules against.
- `test` — held out. Only touched by the final eval harness run.

Assignment:
- **Adversarial rows** go in `test` by design. They're the regression anchors —
  the whole point is that they fail before a fix and pass after, so they
  should never leak into the training pool.
- **Real rows** get 80/20 hash-bucketed by `id` by the export tool. Never
  label a real row into `test` by hand.

### `source`

- `adversarial` — hand-authored rows targeting specific failure modes.
  Designed to fail before the fix and pass after; kept small and sharp.
- `real` — anonymised rows from the user's `event_queue`, hand-labelled.
  Target: ~150 rows to reach the 200-row floor set in the plan.

## Adding rows

**Adversarial:**
Append to `labels.jsonl` directly. Keep each row targeting a specific failure
mode and use `notes` to explain *why* it's adversarial. Keep the adversarial
set bounded — ~30 rows is enough to pin the failure modes. Beyond that, more
adversarial rows just train the rules to overfit the fixture.

**Real:**
Run the export tool against your local DB:

```
bun run scripts/export-classifier-labels.ts \
  --db .gyst/wiki.db \
  --since 30d \
  --out /tmp/labels-to-fill.jsonl
```

The tool walks each event payload and runs `stripSensitiveData` on every
leaf string — parsing the JSON first so the output stays structurally
valid (a naive blob-strip breaks parsing by replacing `"foo":"bar"` with
`"foo":[REDACTED]`).

Paste the output into a Google Sheet for labelling, fill the `expected.*`
fields, then append the labelled rows back to `labels.jsonl`.

Before committing, **scrub home-directory paths by hand** (search/replace
your home prefix). The bundled `stripSensitiveData` targets secrets and
connection strings, not filesystem paths — so `cwd` and `file_path` fields
may still contain `/Users/<you>/...` after the tool runs.

## Validation

`bun test tests/fixtures/classifier-eval/schema.test.ts` parses every row
against the Zod schema. A green run means the fixture is consumable; a red
run means a labeller left a malformed row.
