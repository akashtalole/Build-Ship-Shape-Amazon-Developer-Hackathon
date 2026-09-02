#!/usr/bin/env bash
# Deploys all five hackathon services to ECS Express Mode, one after
# another. Useful right before a demo; each service still gets its own ECR
# repo and Express Mode service, so any one of them can be redeployed or
# torn down independently afterward with deploy.sh/teardown.sh.
#
# Usage:
#   ./deploy/deploy-all.sh [aws-region]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

REGION="$(resolve_region "${1:-}")"

for svc in $ALL_SERVICES; do
  echo ""
  echo "########## $svc ##########"
  "$SCRIPT_DIR/deploy.sh" "$svc" "$REGION"
done

echo ""
echo "==> All five services deployed. Tear everything down with: ./deploy/teardown-all.sh $REGION"
