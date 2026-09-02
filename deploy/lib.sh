#!/usr/bin/env bash
# Shared config + helpers sourced by every script in this directory.
# Not meant to be run directly.

# service-dir -> "ExpressServiceName:ContainerPort"
service_config() {
  case "$1" in
    alexa-homeops-mcp)       echo "hackathon-homeops-mcp:3333" ;;
    ring-porchpass)           echo "hackathon-porchpass:4444" ;;
    firetv-courtside)         echo "hackathon-courtside:4455" ;;
    bee-studyloop)             echo "hackathon-studyloop:4466" ;;
    aws-builder-model-router) echo "hackathon-model-router:4567" ;;
    *) return 1 ;;
  esac
}

ALL_SERVICES="alexa-homeops-mcp ring-porchpass firetv-courtside bee-studyloop aws-builder-model-router"

# ECS Express Mode config. The two IAM role names are AWS's own documented
# defaults (not something this repo invented), so other ECS workloads in the
# same account may already have — or later come to depend on — roles with
# these exact names. teardown-shared.sh deliberately never deletes them
# automatically for that reason; see its comments.
CLUSTER_NAME="hackathon-express"
EXEC_ROLE_NAME="ecsTaskExecutionRole"
INFRA_ROLE_NAME="ecsInfrastructureRoleForExpressServices"
EXEC_ROLE_POLICY_ARN="arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
INFRA_ROLE_POLICY_ARN="arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required command '$1' not found." >&2; exit 1; }
}

resolve_region() {
  local passed="$1"
  if [ -n "$passed" ]; then
    echo "$passed"
  else
    aws configure get region 2>/dev/null || echo "us-east-1"
  fi
}

# Creates an IAM role if it doesn't already exist, trusting the given AWS
# service principal and with the given managed policy attached. Safe to call
# repeatedly — a pre-existing role (created by this script on an earlier run,
# by another ECS Express Mode tutorial, or by the AWS console) is reused
# as-is, never modified.
ensure_role() {
  local role_name="$1" principal="$2" policy_arn="$3" description="$4"
  if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
    return 0
  fi
  local trust_json
  trust_json="$(mktemp)"
  cat > "$trust_json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "$principal" }, "Action": "sts:AssumeRole" }
  ]
}
EOF
  aws iam create-role --role-name "$role_name" \
    --assume-role-policy-document "file://$trust_json" \
    --description "$description" >/dev/null
  rm -f "$trust_json"
  aws iam attach-role-policy --role-name "$role_name" --policy-arn "$policy_arn" >/dev/null
  echo "    created IAM role '$role_name'"
  echo "    waiting ~10s for IAM propagation..."
  sleep 10
}

# Best-effort extraction of a URL-shaped value from an Express Mode CLI
# JSON response. ECS Express Mode is a very new API (announced re:Invent
# 2025) and its exact response field name for the assigned domain wasn't
# consistently documented at the time this script was written, so this
# scans for *any* key containing "url" (case-insensitive) rather than
# hardcoding one field name that might not match your CLI version.
extract_url_field() {
  local json_file="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r '.. | objects | to_entries[]? | select(.key | test("url"; "i")) | .value' "$json_file" 2>/dev/null | grep -v '^null$' | head -1
  else
    grep -oE '"[A-Za-z]*[Uu]rl"[[:space:]]*:[[:space:]]*"[^"]*"' "$json_file" | head -1 | sed -E 's/.*"([^"]*)"$/\1/'
  fi
}
