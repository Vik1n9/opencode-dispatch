#!/usr/bin/env bash
# Link this checkout into place so the repo stays the single source of truth:
#   ~/.agents/skills/opencode-dispatch   -> skills/opencode-dispatch
#   ~/.claude/skills/opencode-dispatch   -> ~/.agents/skills/opencode-dispatch (only if missing)
#   ~/.config/opencode-dispatch/scores.json -> config/scores.json
# Anything already in the way is moved to ~/.config/opencode-dispatch/backups/<timestamp>/ first.
# track.jsonl (your private dispatch history) stays in ~/.config/opencode-dispatch and is never linked.
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
link "$repo/config/scores.json" "$config_dir/scores.json"
