#!/usr/bin/env bash
# Shared config + helpers sourced by every script in this directory.
# Not meant to be run directly.

# service-dir -> "AppRunnerServiceName:ContainerPort"
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

ACCESS_ROLE_NAME="AppRunnerECRAccessRole"
ASC_NAME="hackathon-single-instance"

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
