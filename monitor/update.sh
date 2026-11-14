#!/bin/sh
# Updates the monitor to the latest code from GitHub and restarts it.
# The old container keeps collecting while the new image builds; the swap stops it gracefully
# (it sends its unsent rows and saves its state first), so nothing is lost.
# Usage, in the monitor folder on the server:  sh update.sh
set -e
cd "$(dirname "$0")"
echo "Pulling the latest code..."
git pull --ff-only
echo "Building and restarting..."
docker compose up -d --build
docker image prune -f > /dev/null
docker compose ps
echo
echo "Done. Follow the log with:  docker compose logs -f --tail 50"
