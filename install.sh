#!/usr/bin/env bash
# Link this checkout into place so the repo stays the single source of truth:
#   ~/.agents/skills/opencode-dispatch   -> skills/opencode-dispatch
#   ~/.claude/skills/opencode-dispatch   -> ~/.agents/skills/opencode-dispatch (only if missing)
#   ~/.config/opencode-dispatch/benchmarks.json -> config/benchmarks.json
# Anything already in the way is moved to ~/.config/opencode-dispatch/backups/<timestamp>/ first.
# An old scores.json (the pre-split table) is moved to the same backup folder.
# track.jsonl (your private dispatch history), internal.json (derived from it) and limits.json stay in
# ~/.config/opencode-dispatch and are never linked.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
