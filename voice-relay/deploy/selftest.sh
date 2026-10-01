#!/usr/bin/env bash
# Verify the relay on the box itself: service state, broker connection, and one
# real end-to-end chat against the robot. Run after install:
#   sudo bash /opt/stackchan-relay/deploy/selftest.sh
set -euo pipefail

ENV_FILE="/etc/stackchan-relay.env"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "Cannot read $ENV_FILE; run this selftest with sudo." >&2
  exit 1
fi
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8080}"
TOKEN="$(grep -E '^RELAY_TOKEN=' "$ENV_FILE" | cut -d= -f2)"
BASE="http://127.0.0.1:$PORT"

if [[ -z "$TOKEN" ]]; then
  echo "RELAY_TOKEN is empty in $ENV_FILE" >&2
  exit 1
fi

echo "== service =="
systemctl is-active stackchan-relay.service || true

echo
echo "== healthz =="
curl -s --max-time 10 "$BASE/healthz" || { echo; echo "healthz failed" >&2; exit 1; }
echo

echo
echo "== one real chat =="
read -r -d '' BODY <<'JSON' || true
{"text":"中转自检，请回一句短话"}
JSON
JOB="$(curl -s --max-time 30 -X POST "$BASE/chat" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$BODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"

if [[ -z "$JOB" ]]; then
  echo "chat start failed" >&2
  exit 1
fi
echo "job=$JOB"

for _ in $(seq 1 60); do
  sleep 2
  SNAPSHOT="$(curl -s --max-time 20 "$BASE/chat/$JOB" -H "Authorization: Bearer $TOKEN")"
  STATUS="$(printf '%s' "$SNAPSHOT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
  SETTLED="$(printf '%s' "$SNAPSHOT" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("settled") is True else "false")')"
  echo "  status=$STATUS"
  case "$STATUS" in
    done|error|cancelled)
      [[ "$SETTLED" == "true" ]] || continue
      printf '%s' "$SNAPSHOT" | python3 -m json.tool
      [[ "$STATUS" == "done" ]]
      exit $?
      ;;
  esac
done

echo "timed out waiting for the reply" >&2
exit 1
