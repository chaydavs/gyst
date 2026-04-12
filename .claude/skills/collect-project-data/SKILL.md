---
name: collect-project-data
description: Collects git logs, error messages, conventions, and project metadata from local repositories to build Gyst evaluation datasets. Use when the user says "collect data," "build test fixtures," "get git logs," "seed the database," "gather project data," or "build eval dataset." Also use when setting up the retrieval evaluation harness.
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Collect Project Data for Gyst Evaluation

You are building test fixtures and evaluation datasets for Gyst from the developer's actual projects. This is the most important setup task because synthetic data produces misleading eval scores. Real data from real projects tells you whether retrieval, normalization, and scoring actually work.

## Step 1: Discover Local Repositories

Find all git repos on the machine. Start with common locations, then ask the user if there are others.

```bash
# Find git repos in common locations (limit depth to avoid deep traversal)
find ~/projects ~/repos ~/code ~/work ~/dev ~/Documents ~/Desktop ~ \
  -maxdepth 4 -name ".git" -type d 2>/dev/null | \
  sed 's/\/.git$//' | sort -u
```

If that returns nothing or too few results:
```bash
# Broader search (slower)
find ~ -maxdepth 5 -name ".git" -type d 2>/dev/null | \
  sed 's/\/.git$//' | sort -u
```

Present the list to the user. Ask which repos to include. Default to all of them.

## Step 2: Extract Git Logs

For each selected repo, extract structured commit data:

```bash
REPO_NAME=$(basename "$REPO_PATH")
OUTPUT_DIR="tests/fixtures/project-data"
mkdir -p "$OUTPUT_DIR"

cd "$REPO_PATH"

# Full structured log
git log --all --format='{"hash":"%H","subject":"%s","author":"%an","date":"%ai","body":"%b"}' \
  --stat --stat-width=200 > "$OUTPUT_DIR/gitlog-${REPO_NAME}.jsonl" 2>/dev/null

# Bug fix commits specifically (these contain error context)
git log --all --grep="fix\|bug\|error\|crash\|fail\|broken\|patch\|hotfix\|resolve\|workaround" -i \
  --format='{"hash":"%H","subject":"%s","author":"%an","date":"%ai","body":"%b"}' \
  --stat > "$OUTPUT_DIR/fixes-${REPO_NAME}.jsonl" 2>/dev/null

# Commits with diffs for error-related changes (limited to avoid huge output)
git log --all --grep="fix\|bug\|error" -i -n 50 \
  --format='--- COMMIT %H ---\n%s\n%b' -p --stat \
  > "$OUTPUT_DIR/fix-diffs-${REPO_NAME}.txt" 2>/dev/null

# Count commits
TOTAL=$(git rev-list --all --count 2>/dev/null || echo "0")
FIXES=$(git log --all --grep="fix\|bug\|error" -i --oneline 2>/dev/null | wc -l)
echo "  $REPO_NAME: $TOTAL total commits, $FIXES fix-related"
```

## Step 3: Extract Error Messages

Look for actual error output in build logs, CI output, and terminal history:

```bash
OUTPUT_DIR="tests/fixtures/project-data"

# Shell history (zsh or bash)
if [ -f ~/.zsh_history ]; then
  # zsh history has timestamps, strip them
  grep -ai "error\|failed\|exception\|cannot\|undefined\|ENOENT\|ECONNREFUSED\|TypeError\|SyntaxError\|RangeError" \
    ~/.zsh_history | tail -500 > "$OUTPUT_DIR/shell-errors.txt"
elif [ -f ~/.bash_history ]; then
  grep -ai "error\|failed\|exception\|cannot\|undefined\|TypeError" \
    ~/.bash_history | tail -500 > "$OUTPUT_DIR/shell-errors.txt"
fi

# Look for build/test output logs in repos
for REPO in $SELECTED_REPOS; do
  REPO_NAME=$(basename "$REPO")
  # Common log locations
  find "$REPO" -maxdepth 3 \
    \( -name "*.log" -o -name "*.err" -o -name "build-output*" -o -name "test-results*" \) \
    -size -1M 2>/dev/null | head -20 | while read logfile; do
    grep -ai "error\|exception\|failed\|traceback\|panic" "$logfile" 2>/dev/null \
      >> "$OUTPUT_DIR/build-errors-${REPO_NAME}.txt"
  done
done

# TypeScript/JavaScript specific: look for recently failed test output
for REPO in $SELECTED_REPOS; do
  if [ -f "$REPO/package.json" ]; then
    REPO_NAME=$(basename "$REPO")
    # Check for test result files
    find "$REPO" -maxdepth 3 -name "junit*.xml" -o -name "test-report*" 2>/dev/null | \
      head -5 | while read f; do
      grep -ai "failure\|error" "$f" >> "$OUTPUT_DIR/test-errors-${REPO_NAME}.txt" 2>/dev/null
    done
  fi
done
```

## Step 4: Extract Conventions and CLAUDE.md Files

```bash
OUTPUT_DIR="tests/fixtures/project-data"

# Find all CLAUDE.md, AGENTS.md, .cursorrules files
find ~ -maxdepth 5 \
  \( -name "CLAUDE.md" -o -name "AGENTS.md" -o -name ".cursorrules" -o -name ".clinerules" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | while read f; do
  DIRNAME=$(dirname "$f" | xargs basename)
  FILENAME=$(basename "$f")
  cp "$f" "$OUTPUT_DIR/conventions-${DIRNAME}-${FILENAME}" 2>/dev/null
  echo "  Found: $f"
done

# Extract package.json scripts and dependencies (reveals project patterns)
for REPO in $SELECTED_REPOS; do
  if [ -f "$REPO/package.json" ]; then
    REPO_NAME=$(basename "$REPO")
    cp "$REPO/package.json" "$OUTPUT_DIR/package-${REPO_NAME}.json"
  fi
  if [ -f "$REPO/tsconfig.json" ]; then
    REPO_NAME=$(basename "$REPO")
    cp "$REPO/tsconfig.json" "$OUTPUT_DIR/tsconfig-${REPO_NAME}.json"
  fi
done
```

## Step 5: Parse Into Gyst Test Fixtures

After collecting raw data, parse it into structured test fixtures that the retrieval eval harness can use.

Create `tests/fixtures/real-entries.json`:

Parse each bug fix commit into a knowledge entry:
```json
{
  "entries": [
    {
      "type": "error_pattern",
      "title": "[extracted from commit subject]",
      "content": "[extracted from commit body + diff context]",
      "files": ["[files changed in commit]"],
      "error_message": "[extracted error if visible in diff/body]",
      "source_repo": "project-name",
      "source_commit": "abc123",
      "date": "2026-01-15"
    }
  ]
}
```

For each commit:
- If the subject starts with "fix:" or contains "fix", "bug", "error" → type: error_pattern
- If the subject contains "refactor", "convention", "standard", "lint" → type: convention
- If the subject contains "decide", "switch", "migrate", "choose" → type: decision
- Otherwise → type: learning
- Extract affected file paths from the --stat output
- Extract error messages from the diff if present (look for - and + lines near error/throw/catch)

Create `tests/fixtures/eval-queries.json`:

For each entry, generate 2-3 natural language queries that SHOULD find it:
```json
{
  "queries": [
    {
      "query": "postgres connection pool error in lambda",
      "expected_entry_ids": ["entry-001", "entry-015"],
      "relevance_grades": {"entry-001": 3, "entry-015": 2}
    }
  ]
}
```

Use relevance grades (0-3):
- 3 = directly answers the query
- 2 = strongly related
- 1 = somewhat related
- 0 = not relevant

Create `tests/fixtures/real-errors.json`:

Extract pairs of error messages that SHOULD group together:
```json
{
  "error_groups": [
    {
      "group_id": "stripe-webhook-sig",
      "errors": [
        "SignatureVerificationError: No signatures found matching the expected signature for payload at /Users/alice/src/webhooks.ts:47:12",
        "Error: Webhook signature verification failed at /home/bob/project/src/webhooks.ts:92:8"
      ],
      "should_match": true
    },
    {
      "group_id": "different-errors",
      "errors": [
        "TypeError: Cannot read property 'id' of undefined",
        "RangeError: Maximum call stack size exceeded"
      ],
      "should_match": false
    }
  ]
}
```

## Step 6: Verify and Report

After parsing, print a summary:

```
=== Gyst Data Collection Report ===
Repos scanned: 6
Total commits processed: 1,247
Bug fix commits found: 203
Error messages extracted: 89
Conventions files found: 4
Knowledge entries created: 156
Eval queries generated: 78
Error grouping pairs: 34

Fixture files created:
  tests/fixtures/real-entries.json (156 entries)
  tests/fixtures/eval-queries.json (78 queries)
  tests/fixtures/real-errors.json (34 groups)
  tests/fixtures/project-data/ (raw source data)

Next step: Run the retrieval eval harness
  bun run tests/eval/retrieval-eval.ts
```

## Important Rules

- NEVER include file content that looks like API keys, tokens, or credentials in any fixture
- Run the security filter (src/compiler/security.ts stripSensitiveData) on ALL extracted content
- Skip binary files, images, and files larger than 100KB
- Skip node_modules, .git directories, dist, build output
- If a repo has fewer than 10 commits, skip it (not enough data)
- Prefer recent commits (last 12 months) over ancient history
- Ask the user before accessing repos outside their home directory