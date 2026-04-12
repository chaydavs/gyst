#!/bin/sh
# install-hooks.sh
#
# Installs a git post-commit hook that captures commit data for Gyst.
# Chains with existing hooks (Husky, Lefthook) rather than replacing them.
#
# Usage:
#   bash scripts/install-hooks.sh
#
# The hook will be installed in one of three ways depending on what is detected:
#   1. Husky   — appends the gyst command to .husky/post-commit
#   2. Lefthook — prints manual instructions (Lefthook config is YAML; no safe append)
#   3. Plain git — creates or appends to .git/hooks/post-commit

set -e

# Resolve the repository root (works from any subdirectory)
REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DIR="$(git rev-parse --git-dir)/hooks"
HOOK_FILE="$HOOK_DIR/post-commit"

# Command that the hook will execute.  Runs the TypeScript file directly with
# Bun so no build step is needed.  The $(…) is intentionally unquoted here
# because it forms part of a shell string that will be written verbatim into
# the hook file.
# shellcheck disable=SC2016
GYST_CMD='bun run "$(git rev-parse --show-toplevel)/src/capture/git-hook.ts"'

# ---------------------------------------------------------------------------
# 1. Husky
# ---------------------------------------------------------------------------
if [ -d "$REPO_ROOT/.husky" ]; then
  echo "Husky detected. Adding gyst to .husky/post-commit"

  HUSKY_HOOK="$REPO_ROOT/.husky/post-commit"

  # Create the file with the husky header if it does not exist yet
  if [ ! -f "$HUSKY_HOOK" ]; then
    cat > "$HUSKY_HOOK" << 'HUSKYEOF'
#!/bin/sh
HUSKYEOF
    chmod +x "$HUSKY_HOOK"
  fi

  # Append only if the line is not already present
  if ! grep -q "gyst" "$HUSKY_HOOK" 2>/dev/null; then
    echo "$GYST_CMD" >> "$HUSKY_HOOK"
  fi

  echo "Gyst post-commit hook installed (Husky)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Lefthook
# ---------------------------------------------------------------------------
if [ -f "$REPO_ROOT/lefthook.yml" ] || [ -f "$REPO_ROOT/lefthook.yaml" ]; then
  echo "Lefthook detected. Please add gyst to your lefthook.yml manually:"
  echo ""
  echo "  post-commit:"
  echo "    commands:"
  echo "      gyst:"
  echo "        run: $GYST_CMD"
  echo ""
  echo "Then run: lefthook install"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Standard git hook
# ---------------------------------------------------------------------------
if [ -f "$HOOK_FILE" ]; then
  # Append only if not already present
  if ! grep -q "gyst" "$HOOK_FILE" 2>/dev/null; then
    echo "$GYST_CMD" >> "$HOOK_FILE"
    echo "Gyst post-commit hook appended to existing hook at $HOOK_FILE"
  else
    echo "Gyst post-commit hook already present in $HOOK_FILE — skipping"
  fi
else
  # Ensure the hooks directory exists (bare clones may not have it)
  mkdir -p "$HOOK_DIR"

  cat > "$HOOK_FILE" << HOOKEOF
#!/bin/sh
$GYST_CMD
HOOKEOF
  chmod +x "$HOOK_FILE"
  echo "Gyst post-commit hook installed at $HOOK_FILE"
fi
