# Build, Ship, Shape: Amazon Developer Hackathon

Six standalone, fully tested implementations — one per prize category — for the
[Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/), plus the
research behind them and the tooling used to ship and demo them.

[:octicons-mark-github-16: View the repo](https://github.com/akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon){ .md-button .md-button--primary }
[Devpost submission draft](devpost-submission.md){ .md-button }

## Prize categories

| Category | Project | Track prize |
|---|---|---|
| [Alexa+](ideas/alexa-plus.md) | [HomeOps](projects/homeops.md) — household operations MCP server | $25,000 top prize |
| [Fire TV](ideas/fire-tv.md) | [CourtSide](projects/courtside.md) — AI co-commentator backend | $25,000 top prize |
| [Ring](ideas/ring.md) | [PorchPass](projects/porchpass.md) — delegated access control | $12,000 top prize |
| [Bee](ideas/bee.md) | [StudyLoop](projects/studyloop.md) — ambient study session coach | $12,000 top prize |
| [AWS Builder (mini)](ideas/aws-builder.md) | [Model Router](projects/model-router.md) — SageMaker sidecar pattern | $5,000 |
| [Open Source (mini)](ideas/open-source.md) | [friction-log-toolkit](projects/friction-log-toolkit.md) — friction-log CLI | $5,000 |

A project can win at most one track prize plus one mini-challenge prize — see the
[Devpost submission draft](devpost-submission.md) for the recommended pairing and per-project
write-ups.

## What's real here

Every project is genuinely working code, not a mockup: real HTTP/MCP end-to-end tests, real
protocol implementations (MCP elicitation, sampling, resumable transport; HMAC-signed webhooks;
Server-Sent Events; a real SM-2 spaced-repetition scheduler), and an honest interface boundary
wherever real hardware or credentials weren't available in the build environment (Ring, Bee,
Fire TV, Bedrock, SageMaker) — each documented in that project's own README as the exact seam
where the real integration plugs in.

## Explore

- **[Winning idea research](ideas/index.md)** — the judging-criteria-scored candidate ideas this
  repo's six implementations were chosen from.
- **[The six projects](projects/homeops.md)** — how each one works, its advanced features, and its
  friction log.
- **[Deploying to AWS](deploy.md)** — CloudShell scripts that take any backend service live on
  Amazon ECS Express Mode.
- **[Demo video narration](demo.md)** — the Polly SSML script used for the Devpost demo video.
- **[Devpost submission draft](devpost-submission.md)** — ready-to-paste per-project write-ups and
  submission strategy.
