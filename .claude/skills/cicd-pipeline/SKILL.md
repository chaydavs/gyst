---
name: cicd-pipeline
description: Sets up and maintains CI/CD pipelines for the Gyst project using GitHub Actions. Use when the user mentions "CI," "CD," "pipeline," "deploy," "actions," "workflow," "release," or "publish." Also use when creating or modifying .github/workflows/ files.
allowed-tools: Bash, Read, Write, Glob
paths: ".github/**/*.yml, .github/**/*.yaml"
---

# Gyst CI/CD Pipeline

This project uses GitHub Actions for CI/CD. All workflows live in `.github/workflows/`.

## Pipeline Architecture

Three workflows, triggered by different events:

### 1. `ci.yml` — Runs on every push and PR
Jobs: lint, test, security, eval (sequential, each depends on the previous)
- **lint**: `bun run lint` (tsc --noEmit)
- **test**: `bun test` + upload test-results artifact
- **security**: grep for secrets (`AKIA`, `sk-`, `-----BEGIN.*KEY`, `xoxb-`, `xapp-`, `gho_`) in `src/`, grep for `console.log` in `src/`, run `tests/compiler/security.test.ts`
- **eval**: `bun run eval`, check MRR@5 ≥ 0.5 threshold, upload `tests/eval/results.json` as artifact

### 2. `release.yml` — Runs on version tags `v*`
- Check out, setup Bun, install deps, run tests, build
- Create GitHub Release with auto-generated notes using `softprops/action-gh-release@v2`
- Commented-out npm publish step (uncomment when `NPM_TOKEN` is configured)

### 3. `eval-regression.yml` — Weekly retrieval quality check
- Cron: `0 6 * * 1` (Monday 6am UTC) + `workflow_dispatch`
- Runs eval and calls `scripts/compare-eval.ts`
- On regression: opens a GitHub issue via `actions/github-script@v7`

## Required Secrets

Set in GitHub repo Settings → Secrets:
- `NPM_TOKEN` — for `npm publish` (optional, not wired yet)

No other secrets needed for CI — all tests run locally.

## Quality Gates (CI must enforce)

- Zero TypeScript errors (`tsc --noEmit`)
- All tests passing (`bun test`)
- MRR@5 above 0.5 (retrieval eval)
- No secrets in source code (grep scan)
- No `console.log` in `src/` (grep scan)
- No `any` types in `src/` (tsc strict mode handles this)

## Package.json Scripts (CI relies on these)

```json
{
  "scripts": {
    "lint": "tsc --noEmit",
    "test": "bun test",
    "build": "bun build src/mcp/server.ts --outdir dist --target node",
    "eval": "bun run tests/eval/retrieval-eval.ts",
    "eval:tune": "bun run tests/eval/tune-weights.ts",
    "calibrate": "bun run scripts/calibrate-confidence.ts"
  }
}
```

## Release Process

```bash
# 1. Update version in package.json
# 2. Commit
git add package.json && git commit -m "release: v0.1.0"
# 3. Tag
git tag v0.1.0
# 4. Push
git push origin main --tags
# GitHub Actions handles the rest: tests → build → release
```

## When Adding a New Workflow

1. Check `ci.yml` for the standard setup-bun + install pattern — match it
2. Use `oven-sh/setup-bun@v2` with `bun-version: latest`
3. Use `actions/checkout@v4`
4. Always use `bun install --frozen-lockfile` in CI
5. Add the new workflow to this skill's documentation
