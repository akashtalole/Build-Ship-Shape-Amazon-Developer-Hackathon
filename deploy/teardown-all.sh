#!/usr/bin/env bash
# Tears down all five hackathon services and the resources they share.
# The one command to run after a demo to make sure nothing keeps billing.
#
# Usage:
#   ./deploy/teardown-all.sh [aws-region]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

REGION="$(resolve_region "${1:-}")"

for svc in $ALL_SERVICES; do
  echo ""
  echo "########## $svc ##########"
  "$SCRIPT_DIR/teardown.sh" "$svc" "$REGION"
done

echo ""
"$SCRIPT_DIR/teardown-shared.sh" "$REGION"

echo ""
echo "==> Everything deployed by this repo's scripts has been removed."
