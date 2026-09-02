# AWS Builder Mini-Challenge — Top Winning Ideas

**Prize:** $5,000 + $5K AWS credits + Amazon meeting (1 winner)
**Required tech:** Meaningfully incorporate AWS services such as Bedrock, AgentCore, SageMaker, Strands SDK, or Kiro
**Note:** Can be stacked with any one primary track submission (Fire TV, Alexa+, Bee, or Ring) — max one track prize + one mini-challenge prize per project

## Idea 1: "Bring your own brain" — Bedrock/AgentCore backend for any primary-track idea (Recommended top pick)

**Problem:** Most compelling hackathon ideas need an AI reasoning layer, but teams often bolt on a generic LLM call as an afterthought rather than a genuine AWS-native agent architecture.

**Solution:** Rather than treating AWS Builder as a separate project, design the primary track's AI features (e.g., Fire TV's "CourtSide" commentary, Alexa+'s "HomeOps" orchestration, or Ring's "StoreWatch" analytics) around **Amazon Bedrock AgentCore** for multi-step agent orchestration and **Strands SDK** for tool-calling, with SageMaker for any custom model (e.g., computer-vision tagging).

- **Tech Implementation:** AgentCore session/runtime for agent state; Strands SDK to define and register tools cleanly; Bedrock foundation models for generation/reasoning; SageMaker endpoint for any bespoke model.
- **Design:** Invisible to the end user — the win is architectural rigor (retries, observability, tool schemas) rather than a new UI.
- **Potential Impact:** A well-built agent backend is directly reusable infrastructure, independent of which device track it powers.
- **Quality of Idea:** Judges for this mini-challenge are specifically evaluating AWS-service depth, not novelty of the end-user idea, so this is the lowest-risk, highest-synergy way to add the mini-challenge without a second parallel project.

## Idea 2: "Kiro Crew" — Multi-Agent Content Pipeline

**Problem:** Building the kind of AI-enhanced content pipelines the tracks reward (e.g., Fire TV's scene-tagging, Bee's summarization) usually means hand-writing orchestration glue code.

**Solution:** Use **Kiro** (spec-driven, agentic development) to define and generate a multi-agent pipeline — e.g., a "tagging agent," a "summarization agent," and a "QA agent" — that processes content for whichever primary track needs it, with the Kiro spec and generated code included as part of the submission.

- **Tech Implementation:** Kiro specs driving codegen for each pipeline agent; Strands SDK or AgentCore for agent-to-agent handoff; Bedrock models doing the actual generation work.
- **Design:** Submission includes the Kiro spec files themselves as part of the "quality of idea" story — showing spec-driven, reviewable AI development rather than ad hoc prompting.
- **Potential Impact:** Demonstrates a repeatable engineering pattern other developers could adopt, not just a one-off feature.
- **Quality of Idea:** Directly showcases the newest tool in the required list (Kiro), which stands out among submissions that default to a plain Bedrock API call.

## Idea 3: "SageMaker Sidecar" — Custom On-Device-Adjacent ML Model

**Problem:** Off-the-shelf foundation models are often overkill (cost/latency) for narrow, well-defined tasks like the computer-vision scoring in Fire TV's "FamilyPlay" or Ring's traffic analytics.

**Solution:** Train and deploy a small, purpose-built model on **SageMaker** (e.g., a lightweight motion-classification or traffic-counting model) as a fast, cheap "sidecar" that the primary track's app calls before falling back to a larger Bedrock model for anything ambiguous.

- **Tech Implementation:** SageMaker training job + real-time or serverless inference endpoint; primary app calls the SageMaker endpoint first, escalating to Bedrock only when confidence is low.
- **Design:** End users never see this layer directly, but its effect is faster, cheaper, more responsive core features.
- **Potential Impact:** Shows engineering maturity — using the right-sized model for the job is a real production consideration judges will recognize.
- **Quality of Idea:** Differentiates from submissions that only call Bedrock, since it demonstrates SageMaker specifically.

## Why these win

The AWS Builder mini-challenge is judged on genuine, well-architected AWS usage rather than a standalone idea — so the strongest strategy is to fold one of these patterns directly into whichever primary track submission a team is already building, maximizing shared demo time and effort while still meeting the "meaningfully incorporate AWS services" bar.
