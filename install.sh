#!/usr/bin/env bash
# Link this checkout into place so the repo stays the single source of truth:
#   ~/.agents/skills/opencode-dispatch   -> skills/opencode-dispatch
#   ~/.claude/skills/opencode-dispatch   -> ~/.agents/skills/opencode-dispatch (only if missing)
#   ~/.config/opencode-dispatch/benchmarks.json -> config/benchmarks.json
# Anything already in the way is moved to ~/.config/opencode-dispatch/backups/<timestamp>/ first.
# Local machine only: refuses cloud sessions and containers, and opencode other than 2.x.
# Requires opencode 2.x, logged in (scripts/oc-check.mjs); a missing opencode or credential only warns.
# track.jsonl (your private dispatch history) stays in ~/.config/opencode-dispatch and is never linked.
#
# Optional companion status line: ./install.sh --statusline also links
#   ~/.claude/statusline-wrap.sh, ~/.claude/statusline-agents.mjs, ~/.claude/bin/dlwatch -> statusline/
# and points ~/.claude/settings.json statusLine at the wrapper (refreshInterval 3), after backing the
# settings up. A previous statusLine command is saved to ~/.config/opencode-dispatch/statusline-base
# and still runs as the first line (unless ~/.claude/statusline.sh exists, which runs instead).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

statusline=0
for arg in "$@"; do
  case "$arg" in
    --statusline) statusline=1 ;;
    *) echo "usage: install.sh [--statusline]" >&2; exit 2 ;;
  esac
done

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

# Optional companion status line (see the header).
if [ "$statusline" = 1 ]; then
  link "$repo/statusline/statusline-wrap.sh" "$HOME/.claude/statusline-wrap.sh"
  link "$repo/statusline/statusline-agents.mjs" "$HOME/.claude/statusline-agents.mjs"
  link "$repo/statusline/bin/dlwatch" "$HOME/.claude/bin/dlwatch"
  node - "$HOME/.claude/settings.json" "$config_dir/statusline-base" "$backup_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const [settingsPath, basePath, backupDir] = process.argv.slice(2);
const WRAP = 'bash ~/.claude/statusline-wrap.sh';
let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { console.error(`error    ${settingsPath} is not valid JSON; statusLine left unchanged`); process.exit(1); }
}
const current = settings.statusLine || {};
if (current.command === WRAP && current.refreshInterval === 3) {
  console.log(`ok       ${settingsPath} statusLine`);
  process.exit(0);
}
// Keep the old first line: ~/.claude/statusline.sh is run by the wrapper anyway; anything else is saved.
if (current.command && current.command !== WRAP && !/^bash ~\/\.claude\/statusline\.sh\s*$/.test(current.command)) {
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  fs.writeFileSync(basePath, current.command + '\n');
  console.log(`saved    previous statusLine command -> ${basePath}`);
}
if (fs.existsSync(settingsPath)) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(settingsPath, path.join(backupDir, 'settings.json'));
  console.log(`backup   ${settingsPath} -> ${path.join(backupDir, 'settings.json')}`);
}
settings.statusLine = { ...current, type: 'command', command: WRAP, refreshInterval: 3 };
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`linked   ${settingsPath} statusLine -> ${WRAP} (refreshInterval 3)`);
NODE
fi
