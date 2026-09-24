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

## Idea 4: "TripCopilot" — Travel Coordination Agent Skill

**Problem:** Coordinating a family trip means juggling flight times, packing lists, time-zone-shifted schedules, and "is everyone ready" logistics across scattered apps and group texts.

**Solution:** A self-hosted MCP server that lets Alexa+ manage an entire trip as one ongoing context — checking flight status, building/checking off a packing list against the destination's weather, and coordinating multi-person departure timing ("is everyone ready to leave for the airport") in one conversational thread.

- **Tech Implementation:** MCP tools wrapping a flight-status API and a weather API, with trip-scoped state (dates, destination, travelers) persisted across the whole trip rather than reset per session.
- **Design:** Time-boxed urgency built into the voice UX (countdown-aware prompts near departure) rather than a generic checklist reader.
- **Potential Impact:** A genuinely bursty but high-stakes use case — most valuable in the exact hours when a household is most stressed and time-constrained.
- **Quality of Idea:** Demonstrates stateful, multi-day agentic context-holding rather than a single-turn command, a step beyond household chores' steady-state loop.

## Idea 5: "AccessibilityBridge" — Voice-First Smart Home Control Hub

**Problem:** Many smart-home ecosystems require multi-step app navigation (open app, pick device, pick scene) that's genuinely inaccessible for users with limited mobility or vision — voice control today often only covers the simple cases.

**Solution:** An MCP server that translates complex, multi-device smart-home actions into single natural-language requests ("get me ready for bed" → lock the door, dim the lights, lower the thermostat, set tomorrow's alarm) with an accessibility-first design: no assumption of screen access, confirms every state change verbally rather than visually.

- **Tech Implementation:** MCP tools wrapping a smart-home device-control API, with a compound "scene" tool that chains multiple device actions and reports back success/failure per device in plain language.
- **Design:** Every interaction assumes voice-only, no-screen use; failure states are announced clearly ("the thermostat didn't respond") rather than silently dropped.
- **Potential Impact:** Directly serves an underserved, high-need audience (mobility/vision-impaired users) with genuine independence gains, not just convenience.
- **Quality of Idea:** Accessibility-first design is an explicit, differentiated angle most smart-home submissions treat as an afterthought rather than the core design constraint.

## Why these win

Each idea centers on genuine multi-step delegation (the core differentiator of Agent Skills/MCP vs. classic voice commands), uses the required Streamable HTTP MCP transport, and can be demoed live against the Alexa+ web app simulator. Idea 3 also offers a natural bridge to the Ring track for teams wanting a cross-ecosystem submission — but remember only one track prize can be won per project, so use that bridge for demo richness, not for double-prize strategy. Ideas 4 and 5 round out the set with a time-boxed, bursty use case (travel) and an explicitly accessibility-first design constraint — both strong "Potential Impact" angles if idea 1's steady-state household-ops story feels too crowded a category to stand out in.
