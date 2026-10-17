# Build-Ship-Shape-Amazon-Developer-Hackathon
Build, Ship, Shape: Amazon Developer Hackathon

📖 **[Browse the docs site](https://akashtalole.github.io/Build-Ship-Shape-Amazon-Developer-Hackathon/)**
for a navigable version of everything below.

## Judges: start here — HomeOps (Alexa+ track)

**[`alexa-homeops-mcp/`](./alexa-homeops-mcp)** is this repo's submission: a self-hosted MCP server (spec
2025-11-25, Streamable HTTP) that lets Alexa+ run a household in one conversation — morning briefing, freeform
capture ("we're out of coffee and I need dry cleaning by Friday"), elicitation-gated reordering, proactive alerts,
and meal planning. Mini-challenge: **AWS Builder**, via Claude on Amazon Bedrock for clients that can't sample and a
one-command deploy to Amazon ECS Express Mode.

```bash
# All from the repo root:
(cd alexa-homeops-mcp && npm install && npm test)                 # 41 end-to-end checks with a real MCP client
(cd alexa-homeops-mcp && HOMEOPS_TOOL_PROFILE=voice npm run dev)  # run locally with the 12 tools Alexa+ sees
./deploy/deploy.sh alexa-homeops-mcp                              # in AWS CloudShell: public HTTPS endpoint
```

- Write-up: [`DEVPOST_SUBMISSION.md`](./DEVPOST_SUBMISSION.md)
- Friction log: [`alexa-homeops-mcp/FRICTION_LOG.md`](./alexa-homeops-mcp/FRICTION_LOG.md)
- Demo narration: [`demo/`](./demo)

## Everything else in this repo

- [`hackathon-ideas/`](./hackathon-ideas) — candidate winning ideas for every prize category, scored against the
  judging criteria.
- Prototypes for the other categories, each a standalone Node.js/TypeScript project with its own README, tests,
  and friction log. They aren't submitted because they don't yet meet their tracks' hardware requirements (see
  `DEVPOST_SUBMISSION.md`): [`ring-porchpass/`](./ring-porchpass) (Ring), [`firetv-courtside/`](./firetv-courtside)
  (Fire TV backend), [`bee-studyloop/`](./bee-studyloop) (Bee backend),
  [`aws-builder-model-router/`](./aws-builder-model-router) (mocked Bedrock/SageMaker routing pattern), and
  [`friction-log-toolkit/`](./friction-log-toolkit) (CLI).
- [`deploy/`](./deploy) — scripts to deploy any of the five backend services to a live endpoint on Amazon ECS
  Express Mode from AWS CloudShell, and to tear them back down when you're done.
- [`docs/`](./docs) + [`mkdocs.yml`](./mkdocs.yml) — source for the docs site above, built and deployed to
  GitHub Pages by [`.github/workflows/docs.yml`](./.github/workflows/docs.yml) on every push to `main`.
