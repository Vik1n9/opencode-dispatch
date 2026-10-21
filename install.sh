#!/usr/bin/env bash
# Link this checkout into place so the repo stays the single source of truth:
#   ~/.agents/skills/opencode-dispatch   -> skills/opencode-dispatch
#   ~/.claude/skills/opencode-dispatch   -> ~/.agents/skills/opencode-dispatch (only if missing)
#   ~/.config/opencode-dispatch/benchmarks.json -> config/benchmarks.json
# Anything already in the way is moved to ~/.config/opencode-dispatch/backups/<timestamp>/ first.
# Local machine only: refuses cloud sessions and containers, and opencode other than 2.x.
# Requires opencode 2.x, logged in (scripts/oc-check.mjs); a missing opencode or credential only warns.
# track.jsonl (your private dispatch history) stays in ~/.config/opencode-dispatch and is never linked.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Local machine only, opencode 2.x, logged in (scripts/oc-check.mjs).
# Exit 0 ok; 3 opencode missing / not logged in (warn, install it later); anything else exit before linking.
check=0
node "$repo/skills/opencode-dispatch/scripts/oc-check.mjs" || check=$?
if [ "$check" -eq 3 ]; then
  echo "warning  dispatching will not work until the problem above is fixed (install opencode 2.x and run \`opencode auth login\`)"
elif [ "$check" -ne 0 ]; then
  exit 1
fi
config_dir="$HOME/.config/opencode-dispatch"
backup_dir="$config_dir/backups/$(date +%Y%m%d-%H%M%S)"

link() { # link <target> <link path>
  local target="$1" path="$2"
  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
    echo "ok       $path"
    return
  fi
  if [ -e "$path" ] || [ -L "$path" ]; then
    mkdir -p "$backup_dir"
    mv "$path" "$backup_dir/"
    echo "backup   $path -> $backup_dir/$(basename "$path")"
  fi
  mkdir -p "$(dirname "$path")"
  ln -s "$target" "$path"
  echo "linked   $path -> $target"
}

link "$repo/skills/opencode-dispatch" "$HOME/.agents/skills/opencode-dispatch"
if [ ! -e "$HOME/.claude/skills/opencode-dispatch" ] && [ ! -L "$HOME/.claude/skills/opencode-dispatch" ]; then
  link "../../.agents/skills/opencode-dispatch" "$HOME/.claude/skills/opencode-dispatch"
fi
link "$repo/config/benchmarks.json" "$config_dir/benchmarks.json"
# The old mixed table is superseded by benchmarks.json (curated) + internal.json (derived from track.jsonl).
if [ -e "$config_dir/scores.json" ] || [ -L "$config_dir/scores.json" ]; then
  mkdir -p "$backup_dir"
  mv "$config_dir/scores.json" "$backup_dir/"
  echo "backup   $config_dir/scores.json -> $backup_dir/scores.json"
fi
