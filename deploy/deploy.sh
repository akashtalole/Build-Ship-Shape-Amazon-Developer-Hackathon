#!/usr/bin/env bash
# Deploys one of this repo's hackathon services to Amazon ECS Express Mode.
# Written for AWS CloudShell (AWS CLI v2 + Docker preinstalled, credentials
# already configured) but works anywhere those two things are true.
#
# This targets ECS Express Mode rather than App Runner because AWS closed
# App Runner to new customers on 2026-04-30 (existing App Runner customers
# are unaffected, but a fresh AWS account cannot create its first App Runner
# service). Express Mode is AWS's own documented successor: one CLI call,
# a container image plus two IAM roles, and ECS provisions a Fargate
# service, an Application Load Balancer, auto scaling, and a live HTTPS
# endpoint — the same "no infrastructure to hand-configure" experience App
# Runner offered. It also still supports the long-lived SSE connections
# several of these services use, unlike Lambda + API Gateway.
#
# ECS Express Mode is a very new AWS API (GA at re:Invent 2025). Its exact
# response shape wasn't consistently documented everywhere at the time this
# script was written, so a couple of spots below (see extract_url_field in
# lib.sh) are deliberately defensive rather than assuming one exact field
# name — if something here doesn't match your AWS CLI version's behavior,
# `aws ecs create-express-gateway-service help` is the source of truth.
#
# Usage:
#   ./deploy/deploy.sh <service-dir> [aws-region]
#
# Example:
#   ./deploy/deploy.sh ring-porchpass us-east-1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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
PORT="${CONFIG##*:}"
ECR_REPO="$APP_NAME"

SERVICE_PATH="$REPO_ROOT/$SERVICE_DIR"
[ -d "$SERVICE_PATH" ] || { echo "No such directory: $SERVICE_PATH"; exit 1; }

REGION="$(resolve_region "${2:-}")"

require_cmd aws
require_cmd docker

echo "==> Deploying '$SERVICE_DIR' as ECS Express service '$APP_NAME' (region: $REGION, port: $PORT)"

docker info >/dev/null 2>&1 || {
  echo "Docker daemon not reachable. In AWS CloudShell this usually means the session"
  echo "needs a moment after starting, or you need to start a fresh CloudShell tab."
  exit 1
}

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"

echo "==> Ensuring ECR repository '$ECR_REPO' exists"
if ! aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1; then
  aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPO" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  echo "    created"
fi

echo "==> Logging Docker in to ECR"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com" >/dev/null

echo "==> Building image (this reads $SERVICE_DIR/Dockerfile)"
docker build -t "$ECR_REPO:latest" "$SERVICE_PATH"
docker tag "$ECR_REPO:latest" "$ECR_URI:latest"

echo "==> Pushing image to ECR"
docker push "$ECR_URI:latest"

echo "==> Ensuring the two IAM roles ECS Express Mode requires exist"
ensure_role "$EXEC_ROLE_NAME" "ecs-tasks.amazonaws.com" "$EXEC_ROLE_POLICY_ARN" \
  "Standard ECS task execution role (pulls images, writes logs) — the well-known AWS default name, reused across ECS workloads"
ensure_role "$INFRA_ROLE_NAME" "ecs.amazonaws.com" "$INFRA_ROLE_POLICY_ARN" \
  "Lets ECS Express Mode provision/manage the ALB, target groups, security groups, and auto-scaling for its services"
EXEC_ROLE_ARN="$(aws iam get-role --role-name "$EXEC_ROLE_NAME" --query 'Role.Arn' --output text)"
INFRA_ROLE_ARN="$(aws iam get-role --role-name "$INFRA_ROLE_NAME" --query 'Role.Arn' --output text)"

PRIMARY_CONTAINER="image=$ECR_URI:latest,containerPort=$PORT"
ENV_SPEC="$(service_environment "$SERVICE_DIR" "$REGION")"
[ -n "$ENV_SPEC" ] && PRIMARY_CONTAINER="$PRIMARY_CONTAINER,$ENV_SPEC"

TASK_ROLE_ARGS=()
TASK_ROLE_NAME="$(service_task_role "$SERVICE_DIR")"
if [ -n "$TASK_ROLE_NAME" ]; then
  echo "==> Ensuring task role '$TASK_ROLE_NAME' (lets the container call Claude on Amazon Bedrock)"
  ensure_role "$TASK_ROLE_NAME" "ecs-tasks.amazonaws.com" "$BEDROCK_INFERENCE_POLICY_ARN" \
    "Lets the HomeOps container call Claude on Amazon Bedrock at runtime"
  TASK_ROLE_ARGS=(--task-role-arn "$(aws iam get-role --role-name "$TASK_ROLE_NAME" --query 'Role.Arn' --output text)")
fi
RESULT_JSON="$(mktemp)"

echo "==> Ensuring ECS cluster '$CLUSTER_NAME' exists"
if [ -z "$(aws ecs describe-clusters --region "$REGION" --clusters "$CLUSTER_NAME" \
      --query "clusters[?status=='ACTIVE'].clusterName" --output text 2>/dev/null)" ]; then
  aws ecs create-cluster --region "$REGION" --cluster-name "$CLUSTER_NAME" >/dev/null
  echo "    created"
fi

# Express Mode services are still ordinary ECS services under the hood, so
# `describe-services` is how we detect "does this already exist" — a fresh
# deploy creates it, a redeploy updates it in place with the new image.
EXISTING_ARN="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER_NAME" --services "$APP_NAME" \
  --query "services[?status=='ACTIVE'].serviceArn | [0]" --output text 2>/dev/null || echo "None")"

if [ "$EXISTING_ARN" = "None" ] || [ -z "$EXISTING_ARN" ] || [ "$EXISTING_ARN" = "null" ]; then
  echo "==> Creating ECS Express service '$APP_NAME' in cluster '$CLUSTER_NAME'"
  echo "    (this provisions a Fargate service, an Application Load Balancer, and auto scaling — usually 3-5 minutes)"
  aws ecs create-express-gateway-service \
    --region "$REGION" \
    --service-name "$APP_NAME" \
    --cluster "$CLUSTER_NAME" \
    --execution-role-arn "$EXEC_ROLE_ARN" \
    --infrastructure-role-arn "$INFRA_ROLE_ARN" \
    ${TASK_ROLE_ARGS[@]+"${TASK_ROLE_ARGS[@]}"} \
    --primary-container "$PRIMARY_CONTAINER" \
    --health-check-path "/healthz" \
    --scaling-target "minTaskCount=1,maxTaskCount=1" \
    > "$RESULT_JSON"
else
  echo "==> Service already exists — deploying the new image to it"
  aws ecs update-express-gateway-service \
    --region "$REGION" \
    --service-arn "$EXISTING_ARN" \
    ${TASK_ROLE_ARGS[@]+"${TASK_ROLE_ARGS[@]}"} \
    --primary-container "$PRIMARY_CONTAINER" \
    > "$RESULT_JSON"
fi

echo "==> Waiting for the service to become stable (up to ~10 minutes)"
if aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER_NAME" --services "$APP_NAME"; then
  echo "    stable"
else
  echo "    not stable yet; it may still be provisioning. Check the ECS console before testing."
fi

echo ""
echo "==> Deploy call finished. Full response saved to: $RESULT_JSON"

SERVICE_URL="$(extract_url_field "$RESULT_JSON")"
if [ -n "$SERVICE_URL" ]; then
  case "$SERVICE_URL" in http*) ;; *) SERVICE_URL="https://$SERVICE_URL" ;; esac
  echo "==> Service URL (best-effort extraction — verify against the ECS console if this looks wrong):"
  echo "    $SERVICE_URL"
else
  echo "==> Couldn't auto-extract a URL from the response (see $RESULT_JSON)."
  echo "    Find it in the AWS Console: ECS -> Clusters -> $CLUSTER_NAME -> Services -> $APP_NAME"
  echo "    or run: aws ecs describe-services --region $REGION --cluster $CLUSTER_NAME --services $APP_NAME"
fi
echo ""
echo "==> Tear this one down later with: ./deploy/teardown.sh $SERVICE_DIR $REGION"
