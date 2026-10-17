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

## Idea 4: "Device Simulator Commons" — Shared Hardware-Simulator Library

**Problem:** Every team building for Ring, Bee, or Fire TV without hardware in hand ends up writing its own throwaway simulated client (a fake Ring event feed, a mock Bedrock provider) — the exact same problem, solved from scratch, project after project.

**Solution:** Extract the simulated-hardware-client pattern (the same interface-plus-simulator seam already used across this repo's own six projects) into a standalone, open-source npm package — typed interfaces and realistic simulators for Ring events, Bee transcripts, and Bedrock/SageMaker-shaped AI providers — that any team can depend on instead of reinventing.

- **Tech Implementation:** New public repo publishing typed interfaces + simulator implementations as a package, with this repo's own six projects as the dogfooding proof (already using the exact pattern being extracted).
- **Design:** A "quickstart in 5 minutes" README showing a real project swapping a hand-rolled mock for the shared package.
- **Potential Impact:** Directly reduces duplicated throwaway work across every future hackathon team building without hardware access — a provable, not hypothetical, reuse story.
- **Quality of Idea:** Meta and verifiably dogfooded — judges can compare the extracted library directly against the real simulators already running in this repo's six submissions.

## Idea 5: "Judge's Companion" — Submission Scorecard Assistant

**Problem:** Hackathon judges and organizers face the same repetitive task across every submission — reading a README, checking for a demo video, and scoring against four fixed judging criteria — with no tooling support, unlike the participant side which this hackathon's own bonus already incentivizes tooling for.

**Solution:** An open-source CLI/web tool that takes a submission's repo URL, checks for the required submission elements (README, demo video link, friction log, track identification), and drafts a structured scorecard against the four judging criteria (Tech Implementation, Design, Potential Impact, Quality of Idea) as a starting point for a human judge's review.

- **Tech Implementation:** New public repo — a CLI that fetches a repo's README/structure via the GitHub API, checks for required elements, and renders a draft scorecard template; no automated scoring claims, purely a checklist/draft accelerator.
- **Design:** Clearly framed as a judge's starting draft, not a replacement for human judgment — flags missing required elements rather than assigning scores itself.
- **Potential Impact:** Serves the organizer/judge side of the hackathon directly, a distinct audience from every other Open Source idea in this file, which all target participants.
- **Quality of Idea:** A genuinely different angle — most Open Source submissions optimize the builder's experience; this one optimizes the judging process itself.

## Why these win

Idea 1 is the safest and highest-impact choice because contributions to Amazon's own repos are directly visible to the judges and the Amazon Developer team who reviews them. Ideas 2 and 3 are stronger if a team wants full ownership of a new project, and both naturally produce artifacts (a library, a friction-log export) that also strengthen the primary track submission's "Product Feedback" and friction-log bonus sections. Idea 4 is the strongest "Quality of Idea" pick for a team already building multiple simulated-hardware integrations, since it can point at real, working code as proof rather than a hypothetical. Idea 5 is the highest-novelty pick of the five — it's the only one not aimed at hackathon participants at all, which is a genuine differentiator but a harder "Potential Impact" case to argue convincingly in a 3-minute demo.
