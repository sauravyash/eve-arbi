#!/bin/sh
# Pull the latest code and restart the scan server if it changed. Run by eve-arbi-update.timer
# (README, "Scans on your own server"); fine to run by hand too.
#   EVE_ARBI_DIR      checkout to update      (default /opt/eve-arbi)
#   EVE_ARBI_SERVICE  systemd unit to restart (default eve-arbi)
#   PORT              the server's port       (default 8000)
set -eu
DIR=${EVE_ARBI_DIR:-/opt/eve-arbi}
SERVICE=${EVE_ARBI_SERVICE:-eve-arbi}
PORT=${PORT:-8000}

cd "$DIR"
before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)
[ "$before" = "$after" ] && exit 0

# A restart ends any scan in progress, so wait for running scans to finish (up to 10 minutes).
busy() {
  for kind in uscan cscan; do
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/$kind" 2>/dev/null \
      | grep -Eq '"state":"(running|computing)"' && return 0
  done
  return 1
}
i=0
while busy && [ $i -lt 60 ]; do sleep 10; i=$((i + 1)); done

systemctl restart "$SERVICE"
echo "Updated $(git log --oneline -1 "$before" | cut -c1-60) → $(git log --oneline -1 | cut -c1-60)"
