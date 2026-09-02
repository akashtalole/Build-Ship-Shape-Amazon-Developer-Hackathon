# Alexa+ Track — Top Winning Ideas

**Prizes:** $25,000 + $15K AWS credits + Amazon meeting (1st) · $15,000 + $5K AWS credits (2nd) · $4,000 + $1K AWS credits (3rd)
**Required tech:** An Agent Skill or a self-hosted MCP server (spec 2025-11-25 or later), using open standards for Agent Skills and Streamable HTTP transport; simulate via the provided web app
**Guidance:** Build MCP integrations using open standards; prioritize genuinely useful, agentic tasks Alexa+ can hand off to

## Idea 1: "HomeOps" — Household Operations MCP Skill (Recommended top pick)

**Problem:** Running a household means juggling many small services (grocery reorder, bill tracking, appointment scheduling, chore rotation) that Alexa+ can't currently reason across.

**Solution:** A self-hosted MCP server exposing tools for a unified household "ops" system — Alexa+ can be asked "what's due this week" or "reorder anything running low" and the agent orchestrates across connected tools (calendar, shopping list, simple budget tracker).

- **Tech Implementation:** MCP server (Streamable HTTP transport, 2025-11-25+ spec) exposing well-scoped tools (`list_upcoming_tasks`, `reorder_item`, `add_expense`) with clear input/output schemas so Alexa+'s agent can chain them.
- **Design:** Conversational flows feel like delegating to a competent assistant, not issuing single commands; confirms before any purchase/spend action.
- **Potential Impact:** Broad household applicability; a real reason to keep an MCP server running daily, not just for the demo.
- **Quality of Idea:** Demonstrates multi-tool agentic orchestration, which is exactly what distinguishes an "Agent Skill" from a legacy Alexa Skill.

## Idea 2: "DevDesk" — Developer Productivity Agent Skill

**Problem:** Developers want hands-free status checks (build status, PR review queue, incident alerts) without switching context away from what they're doing.

**Solution:** An MCP server that lets Alexa+ answer "what's blocking me today" by querying GitHub/CI/ticket systems, and can take safe actions (approve a routine PR, snooze a non-urgent alert) via voice.

- **Tech Implementation:** MCP tools wrapping GitHub/CI APIs; read-only tools by default, explicit confirmation for any state-changing tool call.
- **Design:** Short, information-dense voice responses; a companion web view via the Alexa+ web app to show detail (PR diffs, alert lists) when useful.
- **Potential Impact:** Speaks directly to the "AWS Builder" developer audience — plausible daily-use tool for engineering teams, not just a hackathon demo.
- **Quality of Idea:** Shows a non-obvious, work-context use of Alexa+ beyond home/media use cases — differentiates from the flood of home-automation submissions.

## Idea 3: "CareCheck" — Caregiver Coordination Skill

**Problem:** Families coordinating care for an aging or ill relative rely on scattered texts/calls to track medication, visits, and needs.

**Solution:** An MCP-backed Alexa+ skill that lets a caregiver ask "has mom taken her afternoon meds" or "who's visiting this week," pulling from a shared care log that any family member (or the Ring/Bee ecosystem) can also feed.

- **Tech Implementation:** MCP server backed by a simple shared datastore; tools for logging and querying care events; can cross-reference with a Ring doorbell event log for "who visited today" if paired with the Ring track.
- **Design:** Reassuring, low-friction voice interactions for often-stressed caregivers; clear, calm confirmations.
- **Potential Impact:** Strong social-good angle with a real recurring need; extensible ecosystem story ties Alexa+ + Ring + Bee together, which the hackathon explicitly encourages ("connect the living room, the front door, and the cloud").
- **Quality of Idea:** Cross-track integration story is a distinctive way to demonstrate ecosystem understanding.

## Why these win

Each idea centers on genuine multi-step delegation (the core differentiator of Agent Skills/MCP vs. classic voice commands), uses the required Streamable HTTP MCP transport, and can be demoed live against the Alexa+ web app simulator. Idea 3 also offers a natural bridge to the Ring track for teams wanting a cross-ecosystem submission — but remember only one track prize can be won per project, so use that bridge for demo richness, not for double-prize strategy.
