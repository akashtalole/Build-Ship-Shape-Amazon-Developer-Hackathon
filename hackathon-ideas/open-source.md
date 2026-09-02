# Open Source Mini-Challenge — Top Winning Ideas

**Prize:** $5,000 + $5K AWS credits + Amazon meeting (1 winner)
**Required tech:** A new public repository, or a meaningful contribution (PR, branch, or fork) to an existing public repository
**Note:** Can be stacked with any one primary track submission — max one track prize + one mini-challenge prize per project

## Idea 1: "Amazon Devices Starter Kits+" — Contribute back to Amazon's own sample repos (Recommended top pick)

**Problem:** The official starter samples (React Native multi-TV app, Vega video/sports/audio samples, `ring-api-helloworld`) are useful but inevitably leave gaps teams discover while building their primary track submission.

**Solution:** While building a primary track project, generalize a genuinely reusable piece (a hook, a UI component, a helper module, a bug fix) and submit it as a **pull request back to the relevant Amazon `amazonappdev` sample repository**, with tests and documentation.

- **Tech Implementation:** Real PR with a clear description, tests, and adherence to the target repo's contribution guidelines.
- **Design:** N/A (developer-facing), but code quality, docs, and PR description quality all matter for judging.
- **Potential Impact:** Directly benefits every future hackathon participant and Amazon Devices developer — about as legible an "impact beyond the hackathon" story as this category allows.
- **Quality of Idea:** Judges can literally see the contribution accepted/reviewed upstream, which is strong, hard-to-fake evidence of quality.

## Idea 2: "MCP Toolkit for Amazon Devices" — New open-source library

**Problem:** Teams across Fire TV, Alexa+, Bee, and Ring all end up writing similar MCP server boilerplate (auth, schema validation, Streamable HTTP transport setup) from scratch.

**Solution:** Publish a new, focused open-source npm/PyPI package — e.g., a minimal MCP server scaffold with Streamable HTTP transport, schema helpers, and example tools — that any team (including ones outside this hackathon) can build on for Alexa+ Agent Skills or Bee integrations.

- **Tech Implementation:** New public repo with clean package structure, README, examples, and a permissive license (MIT/Apache-2.0); ideally used by the team's own primary-track submission as a dogfooding proof point.
- **Design:** Clear README with a "quickstart in 5 minutes" example.
- **Potential Impact:** Lowers the barrier for the entire Amazon Agent Skill/MCP developer ecosystem, not just this hackathon.
- **Quality of Idea:** A genuinely reusable library (not a hackathon-only demo repo) stands out; strengthen it with CI, tests, and a couple of external stars/usage if time allows.

## Idea 3: "Friction Log Toolkit" — Tooling that turns friction logs into structured feedback

**Problem:** The hackathon explicitly rewards friction logs (up to 10% bonus) but there's no standard tooling for capturing them systematically.

**Solution:** Build and open-source a small CLI/template tool that helps developers capture friction points (timestamped notes, tagged by API/SDK, exportable as a structured Markdown report) while building for any Amazon Devices track — then use it to produce the team's own friction log submission.

- **Tech Implementation:** New public repo — a simple CLI (`friction log start`, `friction log add "note"`, `friction log export`) with Markdown output matching common hackathon feedback formats.
- **Design:** Near-zero friction to use (irony intended) — a single command to log an issue in the moment.
- **Potential Impact:** Directly useful to every other hackathon participant and to Amazon's own developer-experience team as structured feedback.
- **Quality of Idea:** Meta and self-referential in a way that's memorable to judges, while still being a genuinely useful, novel tool.

## Why these win

Idea 1 is the safest and highest-impact choice because contributions to Amazon's own repos are directly visible to the judges and the Amazon Developer team who reviews them. Ideas 2 and 3 are stronger if a team wants full ownership of a new project, and both naturally produce artifacts (a library, a friction-log export) that also strengthen the primary track submission's "Product Feedback" and friction-log bonus sections.
