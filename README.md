# Build-Ship-Shape-Amazon-Developer-Hackathon
Build, Ship, Shape: Amazon Developer Hackathon

📖 **[Browse the docs site](https://akashtalole.github.io/Build-Ship-Shape-Amazon-Developer-Hackathon/)**
for a navigable version of everything below.

## What's in this repo

- [`hackathon-ideas/`](./hackathon-ideas) — candidate winning ideas for every prize category, scored against the
  judging criteria.
- One implementation per category, each a standalone Node.js/TypeScript project with its own README, tests, and
  friction log: [`alexa-homeops-mcp/`](./alexa-homeops-mcp) (Alexa+), [`ring-porchpass/`](./ring-porchpass) (Ring),
  [`firetv-courtside/`](./firetv-courtside) (Fire TV), [`bee-studyloop/`](./bee-studyloop) (Bee),
  [`aws-builder-model-router/`](./aws-builder-model-router) (AWS Builder mini-challenge), and
  [`friction-log-toolkit/`](./friction-log-toolkit) (Open Source mini-challenge).
- [`deploy/`](./deploy) — scripts to deploy any of the five backend services to a live endpoint on Amazon ECS
  Express Mode from AWS CloudShell, and to tear them back down when you're done.
- [`demo/`](./demo) — Polly SSML narration script for the Devpost demo video.
- [`DEVPOST_SUBMISSION.md`](./DEVPOST_SUBMISSION.md) — draft submission write-ups for Devpost.
- [`docs/`](./docs) + [`mkdocs.yml`](./mkdocs.yml) — source for the docs site above, built and deployed to
  GitHub Pages by [`.github/workflows/docs.yml`](./.github/workflows/docs.yml) on every push to `main`.
