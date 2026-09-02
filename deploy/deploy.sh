#!/usr/bin/env bash
# Deploys one of this repo's hackathon services to AWS App Runner. Written
# for AWS CloudShell (AWS CLI v2 + Docker preinstalled, credentials already
# configured) but works anywhere those two things are true.
#
# App Runner is used rather than Lambda/API Gateway because several of
# these services hold long-lived SSE connections (live commentary, live
# check-in feeds, streamed classifications) that don't survive Lambda's
# request/response model — App Runner just runs the container, so nothing
# about the app had to change for deployment. It also needs no VPC, load
# balancer, or cluster to set up: one `create-service` call and you get a
# free HTTPS endpoint.
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

echo "==> Deploying '$SERVICE_DIR' as App Runner service '$APP_NAME' (region: $REGION, port: $PORT)"

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

echo "==> Ensuring App Runner has an IAM role to pull from ECR"
if ! aws iam get-role --role-name "$ACCESS_ROLE_NAME" >/dev/null 2>&1; then
  TRUST_JSON="$(mktemp)"
  cat > "$TRUST_JSON" <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "build.apprunner.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF
  aws iam create-role --role-name "$ACCESS_ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST_JSON" \
    --description "Shared by deploy/deploy.sh: lets App Runner pull images from this account's ECR repos" >/dev/null
  rm -f "$TRUST_JSON"
  aws iam attach-role-policy --role-name "$ACCESS_ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess >/dev/null
  echo "    created IAM role '$ACCESS_ROLE_NAME' (shared across all services deployed by this script)"
  echo "    waiting ~10s for IAM propagation..."
  sleep 10
fi
ACCESS_ROLE_ARN="$(aws iam get-role --role-name "$ACCESS_ROLE_NAME" --query 'Role.Arn' --output text)"

echo "==> Ensuring a pinned-to-1-instance auto scaling configuration exists"
ASC_ARN="$(aws apprunner list-auto-scaling-configurations --region "$REGION" \
  --auto-scaling-configuration-name "$ASC_NAME" \
  --query "AutoScalingConfigurationSummaryList[?Status=='ACTIVE'].AutoScalingConfigurationArn | [0]" \
  --output text 2>/dev/null || echo "None")"
if [ "$ASC_ARN" = "None" ] || [ -z "$ASC_ARN" ]; then
  ASC_ARN="$(aws apprunner create-auto-scaling-configuration --region "$REGION" \
    --auto-scaling-configuration-name "$ASC_NAME" \
    --max-concurrency 100 --min-size 1 --max-size 1 \
    --query 'AutoScalingConfiguration.AutoScalingConfigurationArn' --output text)"
  echo "    created '$ASC_NAME' — every service is pinned to exactly 1 running instance,"
  echo "    since each keeps its demo data in memory and would look inconsistent scaled out"
fi

SERVICE_ARN="$(aws apprunner list-services --region "$REGION" \
  --query "ServiceSummaryList[?ServiceName=='$APP_NAME'].ServiceArn | [0]" --output text 2>/dev/null || echo "None")"

SOURCE_CONFIG_JSON="$(mktemp)"
cat > "$SOURCE_CONFIG_JSON" <<EOF
{
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": { "AccessRoleArn": "$ACCESS_ROLE_ARN" },
  "ImageRepository": {
    "ImageIdentifier": "$ECR_URI:latest",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": { "Port": "$PORT" }
  }
}
EOF

if [ "$SERVICE_ARN" = "None" ] || [ -z "$SERVICE_ARN" ]; then
  echo "==> Creating App Runner service '$APP_NAME'"
  CREATE_JSON="$(mktemp)"
  SOURCE_CONFIG="$(cat "$SOURCE_CONFIG_JSON")"
  cat > "$CREATE_JSON" <<EOF
{
  "ServiceName": "$APP_NAME",
  "SourceConfiguration": $SOURCE_CONFIG,
  "InstanceConfiguration": { "Cpu": "256", "Memory": "512" },
  "HealthCheckConfiguration": {
    "Protocol": "TCP", "Interval": 10, "Timeout": 5, "HealthyThreshold": 1, "UnhealthyThreshold": 5
  },
  "AutoScalingConfigurationArn": "$ASC_ARN"
}
EOF
  SERVICE_ARN="$(aws apprunner create-service --region "$REGION" --cli-input-json "file://$CREATE_JSON" \
    --query 'Service.ServiceArn' --output text)"
  rm -f "$CREATE_JSON"
else
  echo "==> Service already exists — pushing the new image to it"
  UPDATE_JSON="$(mktemp)"
  SOURCE_CONFIG="$(cat "$SOURCE_CONFIG_JSON")"
  cat > "$UPDATE_JSON" <<EOF
{
  "ServiceArn": "$SERVICE_ARN",
  "SourceConfiguration": $SOURCE_CONFIG
}
EOF
  aws apprunner update-service --region "$REGION" --cli-input-json "file://$UPDATE_JSON" >/dev/null
  rm -f "$UPDATE_JSON"
fi
rm -f "$SOURCE_CONFIG_JSON"

echo "==> Waiting for the service to become RUNNING (usually 2-5 minutes)..."
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.Status' --output text)"
  echo "    status: $STATUS"
  case "$STATUS" in
    RUNNING) break ;;
    CREATE_FAILED|DELETE_FAILED)
      echo "Service entered $STATUS. Check the App Runner console (CloudWatch logs under /aws/apprunner/$APP_NAME) for details."
      exit 1
      ;;
  esac
  sleep 10
done

SERVICE_URL="$(aws apprunner describe-service --region "$REGION" --service-arn "$SERVICE_ARN" --query 'Service.ServiceUrl' --output text)"
echo ""
if [ "$STATUS" = "RUNNING" ]; then
  echo "==> Deployed: https://$SERVICE_URL"
else
  echo "==> Still $STATUS after several minutes — it may just need more time. Check again with:"
  echo "    aws apprunner describe-service --region $REGION --service-arn $SERVICE_ARN --query 'Service.{Status:Status,Url:ServiceUrl}'"
fi
echo "==> Tear this one down later with: ./deploy/teardown.sh $SERVICE_DIR $REGION"
