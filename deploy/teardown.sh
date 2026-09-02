#!/usr/bin/env bash
# Tears down one service deployed by deploy.sh: deletes its App Runner
# service and its ECR image repository. Run this as soon as you're done
# demoing — App Runner bills for compute while a service is running, even
# if nothing is calling it.
#
# The shared IAM role and auto scaling configuration deploy.sh creates are
# left in place (other services may still be using them) — remove those
# with teardown-shared.sh once every service has been torn down, or just
# run teardown-all.sh which does both in the right order.
#
# Usage:
#   ./deploy/teardown.sh <service-dir> [aws-region]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  echo "Usage: $0 <service-dir> [aws-region]"
  echo "  service-dir: one of: $ALL_SERVICES"
  exit 1
}

SERVICE_DIR="${1:-}"
[ -z "$SERVICE_DIR" ] && usage

CONFIG="$(service_config "$SERVICE_DIR")" || { echo "Unknown service: $SERVICE_DIR"; usage; }
APP_NAME="${CONFIG%%:*}"
ECR_REPO="$APP_NAME"

REGION="$(resolve_region "${2:-}")"
require_cmd aws

echo "==> Tearing down '$SERVICE_DIR' ('$APP_NAME') in $REGION"

SERVICE_ARN="$(aws apprunner list-services --region "$REGION" \
  --query "ServiceSummaryList[?ServiceName=='$APP_NAME'].ServiceArn | [0]" --output text 2>/dev/null || echo "None")"

if [ "$SERVICE_ARN" != "None" ] && [ -n "$SERVICE_ARN" ]; then
  echo "==> Deleting App Runner service"
  aws apprunner delete-service --region "$REGION" --service-arn "$SERVICE_ARN" >/dev/null
  echo "==> Waiting for deletion to finish..."
  for _ in $(seq 1 60); do
    STATUS="$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" \
      --query 'Service.Status' --output text 2>/dev/null || echo "DELETED")"
    echo "    status: $STATUS"
    [ "$STATUS" = "DELETED" ] && break
    sleep 10
  done
else
  echo "==> No App Runner service named '$APP_NAME' found — skipping"
fi

echo "==> Deleting ECR repository '$ECR_REPO' (and every image tag in it)"
if aws ecr delete-repository --region "$REGION" --repository-name "$ECR_REPO" --force >/dev/null 2>&1; then
  echo "    deleted"
else
  echo "    no ECR repository named '$ECR_REPO' found — skipping"
fi

echo ""
echo "==> Done. No further App Runner charges accrue for '$SERVICE_DIR'."
echo "    (The shared 'AppRunnerECRAccessRole' IAM role and 'hackathon-single-instance' auto"
echo "     scaling configuration were left in place in case other services still use them —"
echo "     run ./deploy/teardown-shared.sh once ALL services are torn down to remove those too.)"
