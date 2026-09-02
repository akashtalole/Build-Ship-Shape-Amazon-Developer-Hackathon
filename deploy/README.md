# Deploying to AWS from CloudShell

Scripts to deploy any of this repo's five backend services to a live, public HTTPS endpoint using only
[AWS CloudShell](https://aws.amazon.com/cloudshell/) — no local machine setup required.

## Why App Runner

[AWS App Runner](https://aws.amazon.com/apprunner/) runs a container and gives it a free HTTPS URL, with no VPC,
load balancer, or cluster to configure — a good match for a hackathon demo where you want "one command, one URL."
It was also the right fit technically: several of these services (PorchPass's live event feed, CourtSide's live
commentary stream, the model router's streamed classification endpoint) hold long-lived Server-Sent-Events
connections, which don't survive Lambda + API Gateway's request/response model. App Runner just runs the same
Express server these apps already run locally — nothing about the app code changes for deployment.

**`friction-log-toolkit` is not deployed by these scripts** — it's a CLI tool, not a server, so there's nothing to
run behind a URL. See its own README for installation instead.

## Prerequisites

- An AWS account and credentials available in your shell. In **AWS CloudShell**, this is automatic — just open a
  CloudShell tab in the AWS Console for the account/region you want to deploy into.
- The IAM identity CloudShell is using needs permission to manage ECR repositories, App Runner services, and (once,
  the first time you deploy anything) create one shared IAM role. `AdministratorAccess`, or a policy covering
  `ecr:*`, `apprunner:*`, and `iam:CreateRole`/`GetRole`/`DeleteRole`/`AttachRolePolicy`/`DetachRolePolicy`, is
  enough.
- Docker and the AWS CLI v2 are both preinstalled in CloudShell — nothing else to install.

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
updates) an App Runner service for it. It prints the live HTTPS URL when done — typically 2-5 minutes per service,
mostly App Runner's own provisioning time.

An optional second argument sets the AWS region (defaults to whatever `aws configure get region` returns, or
`us-east-1`):

```bash
./deploy/deploy.sh firetv-courtside eu-west-1
```

## What gets created

| Resource | Scope | Purpose |
|---|---|---|
| ECR repository (one per service, e.g. `hackathon-porchpass`) | per-service | Holds that service's container image |
| App Runner service (e.g. `hackathon-porchpass`) | per-service | Runs the container, gives it an HTTPS URL |
| IAM role `AppRunnerECRAccessRole` | shared | Lets App Runner pull images from your ECR repos |
| App Runner auto scaling configuration `hackathon-single-instance` | shared | Pins every service to exactly **1** running instance |

**Why pinned to 1 instance:** every service in this repo keeps its demo data (passes, game state, flashcards,
routing metrics) in an in-memory store, the same simplification each service's own README documents. App Runner's
default auto scaling can run multiple instances behind one URL, which would make requests land on inconsistent
copies of that in-memory state — fine for a real, database-backed service, not for these demos. The shared
scaling configuration keeps each service to one instance so the live demo behaves exactly like running it locally.

## Redeploying after a code change

Just run `deploy.sh` again for that service — it detects the existing App Runner service and pushes the new image
to it instead of creating a duplicate.

## Tearing down

**Tear services down as soon as you're done demoing** — App Runner bills for compute while a service is running,
whether or not anything is calling it.

```bash
# Tear down one service (its App Runner service + its ECR repo):
./deploy/teardown.sh ring-porchpass

# Tear down all five, plus the shared IAM role and auto scaling config:
./deploy/teardown-all.sh
```

`teardown.sh` only removes what's specific to one service; the shared IAM role and auto scaling configuration are
left in place in case other services still need them. Run `./deploy/teardown-shared.sh` once every service has
been torn down (or just use `teardown-all.sh`, which does both in the right order).

## Files in this directory

```
deploy/
  lib.sh              Shared config (service name -> App Runner name/port map) + small helpers
  deploy.sh            Build, push, and deploy ONE service:      ./deploy/deploy.sh <service-dir> [region]
  teardown.sh          Tear down ONE service:                    ./deploy/teardown.sh <service-dir> [region]
  deploy-all.sh        Deploy all five services in sequence:     ./deploy/deploy-all.sh [region]
  teardown-all.sh      Tear down all five + shared resources:    ./deploy/teardown-all.sh [region]
  teardown-shared.sh   Remove the shared IAM role/scaling config: ./deploy/teardown-shared.sh [region]
```

Each deployable service also has its own `Dockerfile` and `.dockerignore` (a standard two-stage Node build:
`npm ci && npm run build` in a builder image, then only `dist/` + production `node_modules` in the runtime image)
— `deploy.sh` just builds whichever one lives in the service directory you point it at.

## Troubleshooting

- **`Docker daemon not reachable`** — in CloudShell this is almost always fixed by opening a fresh CloudShell tab;
  the Docker daemon can take a moment to become available right after a session starts.
- **Service stuck in `CREATE_FAILED`** — check CloudWatch Logs under the `/aws/apprunner/<service-name>` log group
  for the container's stdout/stderr; the most common cause is the container crashing on startup (check the port
  the app actually listens on matches the `Port` App Runner was told to health-check).
- **`AccessDenied` on `iam:CreateRole`** — the first `deploy.sh` run for any service needs to create the shared
  `AppRunnerECRAccessRole` role once; if your IAM identity can't create roles, ask an account admin to create it
  once (trust policy: `build.apprunner.amazonaws.com`; attached policy:
  `AWSAppRunnerServicePolicyForECRAccess`) and rerun `deploy.sh` — it will detect and reuse the existing role.
