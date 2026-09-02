#!/usr/bin/env bash
# Removes the ECS cluster deploy.sh shares across every service, once it's
# empty. Only run this after every individual service has already been torn
# down with teardown.sh.
#
# Deliberately does NOT delete the ecsTaskExecutionRole or
# ecsInfrastructureRoleForExpressServices IAM roles, even though deploy.sh
# creates them. Unlike the ECR repos and cluster name (which are specific to
# this repo), those are AWS's own documented default role names for ECS —
# the same names the AWS console's own "quick create" flow and other
# tutorials use. Another ECS or ECS-Express workload in your account,
# created outside this repo, may already depend on a role with one of these
# exact names. This script only prints the commands to remove them, so you
# can make that call yourself with the full picture of what else in your
# account might be using them.
#
# Usage:
#   ./deploy/teardown-shared.sh [aws-region]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

REGION="$(resolve_region "${1:-}")"
require_cmd aws

echo "==> Cleaning up shared deploy.sh resources in $REGION"

REMAINING="$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER_NAME" \
  --query 'length(serviceArns)' --output text 2>/dev/null || echo "0")"

if [ "$REMAINING" = "0" ]; then
  if aws ecs delete-cluster --region "$REGION" --cluster "$CLUSTER_NAME" >/dev/null 2>&1; then
    echo "    deleted empty ECS cluster '$CLUSTER_NAME'"
  else
    echo "    no ECS cluster named '$CLUSTER_NAME' found (or it's already gone) — skipping"
  fi
else
  echo "    cluster '$CLUSTER_NAME' still has $REMAINING service(s) — not deleting it."
  echo "    Run ./deploy/teardown.sh for each remaining service-dir first."
fi

echo ""
echo "==> NOT deleting these IAM roles automatically (see this script's header comment for why)."
echo "    If you're sure nothing else in this account uses them, remove them yourself with:"
echo ""
echo "    aws iam detach-role-policy --role-name $EXEC_ROLE_NAME --policy-arn $EXEC_ROLE_POLICY_ARN"
echo "    aws iam delete-role --role-name $EXEC_ROLE_NAME"
echo "    aws iam detach-role-policy --role-name $INFRA_ROLE_NAME --policy-arn $INFRA_ROLE_POLICY_ARN"
echo "    aws iam delete-role --role-name $INFRA_ROLE_NAME"
echo ""
echo "==> Shared resource cleanup finished."
