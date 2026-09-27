#!/usr/bin/env bash
# Open multiple browser tabs as simulated participants.
#
# Usage:
#   ./scripts/open-participants.sh          # 3 participants (default)
#   ./scripts/open-participants.sh 5        # 5 participants
#   ./scripts/open-participants.sh 3 http://localhost:5173   # custom URL

COUNT=${1:-3}
BASE_URL=${2:-http://localhost:5173}

echo "Opening ${COUNT} participant browser tabs at ${BASE_URL} ..."

for i in $(seq 1 "$COUNT"); do
  URL="${BASE_URL}/?PROLIFIC_PID=local-test-${i}"
  echo "  Participant ${i}: ${URL}"

  # Try common browser openers
  if command -v xdg-open &>/dev/null; then
    xdg-open "$URL" 2>/dev/null &
  elif command -v open &>/dev/null; then
    open "$URL" &
  elif command -v start &>/dev/null; then
    start "$URL" &
  else
    echo "  (Could not detect browser — please open the URL manually)"
  fi

  sleep 0.3
done

echo ""
echo "Admin URL: ${BASE_URL}/?admin=<ADMIN_PASSWORD>"
echo "Open the admin URL in another tab to control the experiment."
