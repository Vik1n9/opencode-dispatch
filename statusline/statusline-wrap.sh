#!/bin/bash
# Status line: your existing first line, untouched, plus a second line with running opencode
# dispatches (⚙), Claude Code background work (⏳) and dlwatch downloads (⬇), from
# statusline-agents.mjs. The second line only appears when something is running.
# This script must never hang, crash or leak anything to stderr.
input=$(cat 2>/dev/null)
dir="$HOME/.claude"
base_file="$HOME/.config/opencode-dispatch/statusline-base"

# Line 1: ~/.claude/statusline.sh if present, else the status line command that was configured
# before `install.sh --statusline` (saved in $base_file). Swallow stderr unless debugging
# (bash-level errors, e.g. a syntax error, happen before a script's own "exec 2>/dev/null").
run_base() {
  if [ "${WAZA_STATUSLINE_DEBUG:-}" = "1" ]; then "$@"; else "$@" 2>/dev/null; fi
}
if [ -f "$dir/statusline.sh" ]; then
  printf '%s' "$input" | run_base bash "$dir/statusline.sh"
elif [ -s "$base_file" ]; then
  printf '%s' "$input" | run_base bash -c "$(cat "$base_file")"
fi

# Line 2: Claude Code may run us with a minimal PATH that has no node; fall back to the usual
# install locations so the second line does not silently disappear.
node_bin=$(command -v node 2>/dev/null)
if [ -z "$node_bin" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && { node_bin="$c"; break; }
  done
fi

agents=''
if [ -n "$node_bin" ] && [ -f "$dir/statusline-agents.mjs" ]; then
  # Trust the output only when the script finished: a crash can leave junk on stdout.
  out=$(printf '%s' "$input" | "$node_bin" "$dir/statusline-agents.mjs" 2>/dev/null) && agents="$out"
fi
[ -n "$agents" ] && printf '%s\n' "$agents"
exit 0
