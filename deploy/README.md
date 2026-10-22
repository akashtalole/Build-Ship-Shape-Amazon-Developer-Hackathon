# Deploying to AWS from CloudShell

Scripts to deploy any of this repo's five backend services to a live, public HTTPS endpoint using only
[AWS CloudShell](https://aws.amazon.com/cloudshell/) — no local machine setup required.

## Why Amazon ECS Express Mode (not App Runner)

These scripts originally targeted AWS App Runner. **AWS closed App Runner to new customers on April 30, 2026** —
existing App Runner customers are unaffected, but a fresh AWS account (the common case for a hackathon judge or a
new team) cannot create its first App Runner service anymore. AWS's own documented successor is
[Amazon ECS Express Mode](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html)
(GA at re:Invent 2025), which preserves the same pitch — one CLI call, a container image plus two IAM roles, and
ECS provisions a Fargate service, an Application Load Balancer, auto scaling, and a live HTTPS endpoint — while
running on the regular ECS control plane instead of a separate product. These scripts were rewritten to target it.

It's also still the right fit technically for the same reason App Runner was: several of these services
(PorchPass's live event feed, CourtSide's live commentary stream, the model router's streamed classification
endpoint) hold long-lived Server-Sent-Events connections, which don't survive Lambda + API Gateway's
request/response model. Express Mode just runs the same Express server these apps already run locally — nothing
about the app code changes for deployment.

**`friction-log-toolkit` is not deployed by these scripts** — it's a CLI tool, not a server, so there's nothing to
run behind a URL. See its own README for installation instead.

> **A note on how new this is:** ECS Express Mode is a very new AWS API surface, and its exact CLI response shape
> wasn't consistently documented everywhere at the time these scripts were written. `deploy.sh` extracts the
> service URL defensively (the `endpoint` field the CLI reference documents, or any field that looks like a URL)
> and always prints where to find the real service in the AWS Console as a fallback. If the AWS
> CLI's behavior has since diverged from what's here, `aws ecs create-express-gateway-service help` is the source
> of truth — please open an issue/PR if you hit a mismatch.

## Prerequisites

- An AWS account and credentials available in your shell. In **AWS CloudShell**, this is automatic — just open a
  CloudShell tab in the AWS Console for the account/region you want to deploy into.
- The IAM identity CloudShell is using needs permission to manage ECR repositories, ECS (including
  `create-express-gateway-service`/`delete-express-gateway-service`), and (once, the first time you deploy
  anything) create two IAM roles. `AdministratorAccess`, or a policy covering `ecr:*`, `ecs:*`, and
  `iam:CreateRole`/`GetRole`/`AttachRolePolicy` (plus `iam:PassRole` for the roles it creates, and
  `iam:DetachRolePolicy`/`DeleteRole` for teardown), is enough.
- Docker, `jq`, and the AWS CLI v2 are all preinstalled in CloudShell — nothing else to install. (`jq` is used
  only to make reading the deploy response nicer; the scripts fall back to plain `grep` if it's ever missing.)

## Quick start

```bash
git clone https://github.com/<your-fork>/Build-Ship-Shape-Amazon-Developer-Hackathon.git
cd Build-Ship-Shape-Amazon-Developer-Hackathon

# Deploy one service:
./deploy/deploy.sh ring-porchpass

# ...or deploy all five at once:
./deploy/deploy-all.sh
```

Each `deploy.sh` run builds the service's Docker image, pushes it to a per-service ECR repository, and creates (or
updates) an ECS Express Mode service for it, waits for the service to become stable, then prints the assigned URL
— typically 3-5 minutes per service, mostly Express Mode's own provisioning time (the ALB, target group, and auto
scaling policy it creates). The shared `hackathon-express` cluster is created on the first run.

An optional second argument sets the AWS region (defaults to whatever `aws configure get region` returns, or
`us-east-1`):

```bash
./deploy/deploy.sh firetv-courtside eu-west-1
```

## What gets created

| Resource | Scope | Purpose |
|---|---|---|
| ECR repository (one per service, e.g. `hackathon-porchpass`) | per-service | Holds that service's container image |
| ECS Express service (e.g. `hackathon-porchpass`) in cluster `hackathon-express` | per-service | Runs the container behind an ALB with an HTTPS URL |
| ECS cluster `hackathon-express` | shared | Holds all five Express services (Express Mode can share one ALB across many services) |
| IAM role `ecsTaskExecutionRole` | shared, **AWS's standard name** | Lets ECS pull images and write logs for task startup |
| IAM role `ecsInfrastructureRoleForExpressServices` | shared, **AWS's standard name** | Lets Express Mode provision/manage the ALB, target groups, and auto scaling |
| Auto scaling target `minTaskCount=1, maxTaskCount=1` | per-service | Pins each service to exactly **1** running task |
| IAM role `hackathon-homeops-bedrock-task-role` | HomeOps, Bedrock provider | Task role with the AWS managed policy `AmazonBedrockMantleInferenceAccess`, so the container can call Claude on Amazon Bedrock. Repo-specific name, so `teardown.sh alexa-homeops-mcp` deletes it |
| IAM role `hackathon-homeops-exec-role` | HomeOps, Anthropic provider | Execution role that can also read the Anthropic API key secret (and nothing else). Deleted by `teardown.sh alexa-homeops-mcp` |

**HomeOps runtime config:** `deploy.sh alexa-homeops-mcp` also passes `HOMEOPS_TOOL_PROFILE=voice` (only the 12
household tools are visible to Alexa+), `HOMEOPS_LLM_PROVIDER`, and `AWS_REGION` to the container. Claude is only
called when the connected MCP client can't sample, and the service still works (with templated narration) if the
provider isn't usable — see
[`alexa-homeops-mcp/README.md`](../alexa-homeops-mcp/README.md#language-models-mcp-sampling-first-then-claude).

**Using an Anthropic API key instead of Bedrock.** Store the key in AWS Secrets Manager, then deploy with
`HOMEOPS_LLM_PROVIDER=anthropic`. ECS injects the key into the container as `ANTHROPIC_API_KEY`, so it never
appears in the task definition, the repo, or your shell history:

```bash
read -rs -p 'Anthropic API key: ' KEY && echo        # paste the key; it isn't echoed
aws secretsmanager create-secret --region us-east-1 \
  --name hackathon/homeops/anthropic-api-key --secret-string "$KEY"
unset KEY
HOMEOPS_LLM_PROVIDER=anthropic ./deploy/deploy.sh alexa-homeops-mcp us-east-1
```

To rotate the key later: `aws secretsmanager put-secret-value --secret-id hackathon/homeops/anthropic-api-key
--secret-string "$KEY"`, then redeploy so a new task picks it up. `teardown.sh` leaves the secret in place and
prints the command to delete it.

**Why pinned to 1 instance:** every service in this repo keeps its demo data (passes, game state, flashcards,
routing metrics) in an in-memory store, the same simplification each service's own README documents. Scaling out
to multiple tasks would make requests land on inconsistent copies of that in-memory state — fine for a real,
database-backed service, not for these demos. Pinning to one task keeps the live demo behaving exactly like
running it locally.

**Why the two IAM role names matter:** `ecsTaskExecutionRole` and `ecsInfrastructureRoleForExpressServices` are
AWS's own documented default role names, not something invented for this repo — the AWS Console's own "quick
create" flow and other ECS tutorials use these exact names too. `deploy.sh` creates them if they don't already
exist and reuses them if they do; `teardown-shared.sh` deliberately never deletes them automatically, since
another ECS workload in your account might depend on a role with one of these names. See that script's output for
the manual commands if you're sure it's safe to remove them.

## Redeploying after a code change

Just run `deploy.sh` again for that service — it detects the existing Express Mode service and pushes the new
image to it instead of creating a duplicate.

## Tearing down

**Tear services down as soon as you're done demoing** — the Fargate task and Application Load Balancer behind an
Express Mode service bill for as long as the service exists, whether or not anything is calling it.

```bash
# Tear down one service (its Express Mode service + its ECR repo):
./deploy/teardown.sh ring-porchpass

# Tear down all five, plus the shared cluster (IAM roles are left in place — see below):
./deploy/teardown-all.sh
```

`teardown.sh` only removes what's specific to one service — deleting an Express Mode service also cleans up the
ALB target group, listener rule, security group, and auto-scaling policy it created (Express Mode owns and
manages those itself, unlike a plain `aws ecs delete-service`). Run `./deploy/teardown-shared.sh` once every
service has been torn down to remove the now-empty shared cluster (or just use `teardown-all.sh`, which does both
in the right order). The two shared IAM roles are intentionally never auto-deleted — `teardown-shared.sh` prints
the manual commands instead, so you can decide with full knowledge of what else in your account might use them.

## Files in this directory

```
deploy/
  lib.sh              Shared config (service name -> Express service name/port map) + small helpers
  deploy.sh            Build, push, and deploy ONE service:        ./deploy/deploy.sh <service-dir> [region]
  teardown.sh          Tear down ONE service:                      ./deploy/teardown.sh <service-dir> [region]
  deploy-all.sh        Deploy all five services in sequence:       ./deploy/deploy-all.sh [region]
  teardown-all.sh      Tear down all five + the shared cluster:    ./deploy/teardown-all.sh [region]
  teardown-shared.sh   Remove the shared cluster (prints IAM-role
                       removal commands rather than running them): ./deploy/teardown-shared.sh [region]
```

Each deployable service also has its own `Dockerfile` and `.dockerignore` (a standard two-stage Node build:
`npm ci && npm run build` in a builder image, then only `dist/` + production `node_modules` in the runtime image)
— `deploy.sh` just builds whichever one lives in the service directory you point it at.

## Troubleshooting

- **`Docker daemon not reachable`** — in CloudShell this is almost always fixed by opening a fresh CloudShell tab;
  the Docker daemon can take a moment to become available right after a session starts.
- **Service fails to stabilize / target unhealthy** — Express Mode's ALB health check is HTTP-based (not just a
  TCP check), so the container must actually return `200` on the health-check path. Every service in this repo
  exposes `GET /healthz` for exactly this reason, which is what `deploy.sh` points the check at; check CloudWatch
  Logs for the service (look under the ECS console's "Logs" tab for the service, or the log group Express Mode
  created) for the container's stdout/stderr if it's still failing.
- **`AccessDenied` on `iam:CreateRole`** — the first `deploy.sh` run for any service needs to create
  `ecsTaskExecutionRole` and `ecsInfrastructureRoleForExpressServices` if they don't already exist. If your IAM
  identity can't create roles, ask an account admin to create both once (trust policies and policy ARNs are in
  `deploy/lib.sh`'s `ensure_role` calls) and rerun `deploy.sh` — it will detect and reuse the existing roles.
- **Can't find the service URL in the terminal output** — `deploy.sh` does a best-effort scan of the CLI response
  for the `endpoint` field or anything URL-shaped (see the note at the top of this file on why). If it comes up empty, check the AWS
  Console: ECS → Clusters → `hackathon-express` → Services → the service name, or run
  `aws ecs describe-services --cluster hackathon-express --services <service-name>` yourself.
