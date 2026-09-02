#!/usr/bin/env bash
# Removes the resources deploy.sh shares across every service: the
# ECR-access IAM role and the pinned-to-1-instance auto scaling
# configuration. Only run this after every individual service has already
# been torn down with teardown.sh — otherwise a still-running service loses
# the role it needs to pull its image on the next deploy.
#
# Usage:
#   ./deploy/teardown-shared.sh [aws-region]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

REGION="$(resolve_region "${1:-}")"
require_cmd aws

echo "==> Removing shared deploy.sh resources in $REGION"

ASC_ARN="$(aws apprunner list-auto-scaling-configurations --region "$REGION" \
  --auto-scaling-configuration-name "$ASC_NAME" \
  --query "AutoScalingConfigurationSummaryList[?Status=='ACTIVE'].AutoScalingConfigurationArn | [0]" \
  --output text 2>/dev/null || echo "None")"
if [ "$ASC_ARN" != "None" ] && [ -n "$ASC_ARN" ]; then
  if aws apprunner delete-auto-scaling-configuration --region "$REGION" \
       --auto-scaling-configuration-arn "$ASC_ARN" >/dev/null 2>&1; then
    echo "    deleted auto scaling configuration '$ASC_NAME'"
  else
    echo "    could not delete '$ASC_NAME' — it's likely still attached to a running service"
  fi
else
  echo "    no auto scaling configuration named '$ASC_NAME' found — skipping"
fi

if aws iam get-role --role-name "$ACCESS_ROLE_NAME" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "$ACCESS_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess >/dev/null 2>&1 || true
  aws iam delete-role --role-name "$ACCESS_ROLE_NAME" >/dev/null
  echo "    deleted IAM role '$ACCESS_ROLE_NAME'"
else
  echo "    no IAM role named '$ACCESS_ROLE_NAME' found — skipping"
fi

echo "==> Shared resources removed."
