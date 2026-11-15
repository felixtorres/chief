#!/usr/bin/env bash
# Install / uninstall Chief as a macOS launchd user agent.
#   scripts/launchd.sh install     build, write ~/Library/LaunchAgents/local.chief.plist, start
#   scripts/launchd.sh uninstall   stop and remove the agent
#   scripts/launchd.sh restart     restart after a config change or update
set -euo pipefail

LABEL="local.chief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
CHIEF_DIR="$(cd "$(dirname "$0")/.." && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }

case "${1:-}" in
  install)
    [[ "$(uname)" == "Darwin" ]] || { echo "launchd is macOS-only" >&2; exit 1; }
    need node "install Node 22+"
    need claude "install Claude Code and log in"
    NODE="$(command -v node)"
    # launchd starts with a bare PATH: include where node, claude, az, git and terminal-notifier live.
    PATH_DIRS="$(dirname "$NODE"):$(dirname "$(command -v claude)")"
    for bin in az git terminal-notifier; do
      if command -v "$bin" >/dev/null 2>&1; then PATH_DIRS="$PATH_DIRS:$(dirname "$(command -v "$bin")")"; fi
    done
    PATH_DIRS="$PATH_DIRS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    PATH_DIRS="$(echo "$PATH_DIRS" | tr ':' '\n' | awk '!seen[$0]++' | paste -sd: -)"

    (cd "$CHIEF_DIR" && npm run build --silent)
    node "$CHIEF_DIR/dist/cli.js" doctor || { echo "doctor found problems; fix them before installing" >&2; exit 1; }

    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/chief"
    sed -e "s#__NODE__#$NODE#g" -e "s#__CHIEF_DIR__#$CHIEF_DIR#g" \
        -e "s#__PATH__#$PATH_DIRS#g" -e "s#__HOME__#$HOME#g" \
        "$CHIEF_DIR/launchd/$LABEL.plist.template" > "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Chief is on. Logs: tail -f ~/Library/Logs/chief/chief.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Chief removed (state and worktrees left in ~/.local/state/chief)"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  *)
    echo "usage: $0 install|uninstall|restart" >&2
    exit 2
    ;;
esac
