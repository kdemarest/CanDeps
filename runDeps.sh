#!/data/data/com.termux/files/usr/bin/bash
# Starts deps in the background, keeping deps/status.md and status.json current (port 8070).
#   runDeps         start (or say it is already running)
#   runDeps stop    stop it
#   runDeps log     follow its log
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$HOME/.cache/deps.pid"
LOG="$DIR/deps.log"
mkdir -p "$(dirname "$PIDFILE")"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  stop)
    if running; then kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "deps: stopped"; else echo "deps: not running"; fi
    exit 0 ;;
  log)
    exec tail -n 40 -f "$LOG" ;;
  start) ;;
  *) echo "usage: runDeps [start|stop|log]" >&2; exit 2 ;;
esac

if running; then
  echo "deps: already running (pid $(cat "$PIDFILE")); page: http://localhost:${PORT:-8070}/"
else
  : > "$LOG"
  nohup node "$DIR/deps.js" serve "${PORT:-8070}" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "deps: started (pid $(cat "$PIDFILE")); page: http://localhost:${PORT:-8070}/ (status also in deps/status.md)"
fi
