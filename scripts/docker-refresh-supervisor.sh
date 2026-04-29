#!/bin/sh
set -u

INTERVAL_MS="${OUTBREAK_REFRESH_INTERVAL_MS:-600000}"
TIMEOUT_MS="${CHATGPT_REFRESH_SUPERVISOR_TIMEOUT_MS:-540000}"
KILL_AFTER="${CHATGPT_REFRESH_SUPERVISOR_KILL_AFTER:-30s}"

interval_seconds=$((INTERVAL_MS / 1000))
timeout_seconds=$((TIMEOUT_MS / 1000))

if [ "$interval_seconds" -lt 1 ]; then
  interval_seconds=1
fi

if [ "$timeout_seconds" -lt 60 ]; then
  timeout_seconds=60
fi

stop_requested=0
trap 'stop_requested=1' INT TERM

if [ "$#" -eq 0 ]; then
  set -- --sync-d1 --d1-local --d1-persist-to /data/wrangler
fi

echo "[refresh-supervisor] starting interval=${interval_seconds}s timeout=${timeout_seconds}s"
echo "[refresh-supervisor] worker args: $*"

while [ "$stop_requested" -eq 0 ]; do
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[refresh-supervisor] cycle starting at ${started_at}"

  timeout --kill-after="$KILL_AFTER" "${timeout_seconds}s" \
    node scripts/chatgpt-refresh-worker.mjs "$@"
  status=$?

  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$status" -eq 0 ]; then
    echo "[refresh-supervisor] cycle succeeded at ${finished_at}"
  elif [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "[refresh-supervisor] cycle timed out with status ${status} at ${finished_at}"
  else
    echo "[refresh-supervisor] cycle failed with status ${status} at ${finished_at}"
  fi

  if [ "$stop_requested" -ne 0 ]; then
    break
  fi

  echo "[refresh-supervisor] sleeping ${interval_seconds}s"
  sleep "$interval_seconds" &
  wait $!
done

echo "[refresh-supervisor] stopped"
