#!/usr/bin/env bash
# Tears down one service deployed by deploy.sh: deletes its ECS Express Mode
# service (which also removes the ALB target group/listener rule, security
# group, and auto-scaling policy it owns — Express Mode cleans those up
# itself, unlike a plain `aws ecs delete-service`) and its ECR image
# repository. Run this as soon as you're done demoing — the underlying
# Fargate task and Application Load Balancer bill for as long as the
# service exists, whether or not anything is calling it.
#
# The two IAM roles deploy.sh creates are intentionally left alone here —
# see teardown-shared.sh for why. The shared "hackathon-express" ECS
# cluster is removed by teardown-shared.sh once it's empty.
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

SERVICE_ARN="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER_NAME" --services "$APP_NAME" \
  --query "services[?status=='ACTIVE'].serviceArn | [0]" --output text 2>/dev/null || echo "None")"

if [ "$SERVICE_ARN" != "None" ] && [ -n "$SERVICE_ARN" ] && [ "$SERVICE_ARN" != "null" ]; then
  echo "==> Deleting ECS Express service (this also removes its ALB target group, listener rule,"
  echo "    security group, and auto-scaling policy — usually a couple of minutes)"
  aws ecs delete-express-gateway-service --region "$REGION" --service-arn "$SERVICE_ARN" >/dev/null
else
  echo "==> No ECS Express service named '$APP_NAME' found in cluster '$CLUSTER_NAME' — skipping"
fi

echo "==> Deleting ECR repository '$ECR_REPO' (and every image tag in it)"
if aws ecr delete-repository --region "$REGION" --repository-name "$ECR_REPO" --force >/dev/null 2>&1; then
  echo "    deleted"
else
  echo "    no ECR repository named '$ECR_REPO' found — skipping"
fi

if [ "$SERVICE_DIR" = "alexa-homeops-mcp" ]; then
  if aws iam get-role --role-name "$HOMEOPS_TASK_ROLE_NAME" >/dev/null 2>&1; then
    echo "==> Deleting this service's own task role '$HOMEOPS_TASK_ROLE_NAME'"
    aws iam detach-role-policy --role-name "$HOMEOPS_TASK_ROLE_NAME" --policy-arn "$BEDROCK_INFERENCE_POLICY_ARN" >/dev/null 2>&1 || true
    aws iam delete-role --role-name "$HOMEOPS_TASK_ROLE_NAME" >/dev/null
    echo "    deleted"
  fi
  if aws iam get-role --role-name "$HOMEOPS_EXEC_ROLE_NAME" >/dev/null 2>&1; then
    echo "==> Deleting this service's own execution role '$HOMEOPS_EXEC_ROLE_NAME'"
    aws iam delete-role-policy --role-name "$HOMEOPS_EXEC_ROLE_NAME" --policy-name "$HOMEOPS_SECRET_POLICY_NAME" >/dev/null 2>&1 || true
    aws iam detach-role-policy --role-name "$HOMEOPS_EXEC_ROLE_NAME" --policy-arn "$EXEC_ROLE_POLICY_ARN" >/dev/null 2>&1 || true
    aws iam delete-role --role-name "$HOMEOPS_EXEC_ROLE_NAME" >/dev/null
    echo "    deleted"
  fi
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$HOMEOPS_ANTHROPIC_SECRET_NAME" >/dev/null 2>&1; then
    echo "==> Left the Anthropic API key secret '$HOMEOPS_ANTHROPIC_SECRET_NAME' in place. Delete it with:"
    echo "    aws secretsmanager delete-secret --region $REGION --secret-id $HOMEOPS_ANTHROPIC_SECRET_NAME --force-delete-without-recovery"
  fi
fi

echo ""
echo "==> Done. No further charges accrue for '$SERVICE_DIR' specifically."
echo "    (The shared 'hackathon-express' ECS cluster and the ecsTaskExecutionRole /"
echo "     ecsInfrastructureRoleForExpressServices IAM roles were left in place in case other"
echo "     services still use them — run ./deploy/teardown-shared.sh once ALL services are"
echo "     torn down to clean up the cluster, and see that script's output for the IAM roles.)"
