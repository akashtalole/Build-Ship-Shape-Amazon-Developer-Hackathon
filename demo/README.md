# Demo video narration (Amazon Polly)

`narration.ssml` is the voiceover script for the Devpost demo video, sized to run well under the
hackathon's 3-minute cap (~330 words plus pauses — roughly 2:00–2:30 spoken by Polly, leaving room
for a silent title card and closing card). It covers the recommended primary
submission from `../DEVPOST_SUBMISSION.md`: **HomeOps (Alexa+ track)** plus the
**AWS Builder mini-challenge** (Claude on Amazon Bedrock, deployed on Amazon ECS Express Mode).

## Rendering it with Polly

Requires the AWS CLI configured with Polly access (works from AWS CloudShell with no extra setup,
same as `../deploy/`).

```bash
# Audio only, neural voice (Matthew or Joanna both work well for this tone):
aws polly synthesize-speech \
  --engine neural \
  --voice-id Matthew \
  --text-type ssml \
  --text file://demo/narration.ssml \
  --output-format mp3 \
  demo/narration.mp3
```

### Getting timing marks (to sync screen recording cuts)

Every section of the script has a `<mark name="..."/>` at the point where the screen recording
should cut to the next feature. Polly can return the exact millisecond offset of each mark, so you
can cut your screen capture to match the narration instead of eyeballing it:

```bash
aws polly synthesize-speech \
  --engine neural \
  --voice-id Matthew \
  --text-type ssml \
  --text file://demo/narration.ssml \
  --output-format json \
  --speech-mark-types '["ssml"]' \
  demo/narration-marks.json
```

`narration-marks.json` will contain one JSON line per mark, each with a `time` field in
milliseconds from the start of `narration.mp3` — cut your screen recording to the next shot the
instant that mark's timestamp passes.

## Shot list (matches each `<mark>`)

| Mark | What's being said | What to show on screen |
|---|---|---|
| `intro_start` | The one-command-at-a-time problem, then HomeOps's pitch | Title card, or Alexa+ device idle |
| `feature_tasks` | Adding a task with fair auto-assignment | Terminal/client calling `add_task`, showing the assignee it picked |
| `feature_reorder` | Elicitation-gated reorder | `reorder_item` triggering a real elicitation prompt the user approves |
| `feature_budget` | Spending-pace alert + `get_proactive_alerts` | An expense putting a category on pace to go over, then "anything I should know about?" surfacing the alerts |
| `feature_briefing` | The `run_morning_briefing` compound tool, narrated by sampling or Claude on Bedrock | One call to `run_morning_briefing`, then the combined tasks/budget/stock narration it returns |
| `aws_start` | AWS Builder pitch | `./deploy/deploy.sh alexa-homeops-mcp` in CloudShell printing the service URL, then the ECS console showing the running service |
| `close_start` | Closing line | The HomeOps README, or the test run passing |

## Notes on the SSML

- Wrapped in `<amazon:domain name="conversational">` for a natural, non-robotic delivery — supported
  by Polly's neural engine on voices like Matthew, Joanna, and Matthew-Neural equivalents in other
  locales.
- `MCP`, `AWS`, `ECS`, and similar acronyms use `<say-as interpret-as="characters">` so Polly spells them
  out (`M-C-P`) instead of trying to pronounce them as a word.
- Only SSML tags supported by Polly's **neural** engine are used (`speak`, `amazon:domain`, `break`,
  `emphasis`, `say-as`, `mark`) — no `<prosody pitch>` or `<amazon:effect name="whispered">`, which
  neural voices don't support.
- If you'd rather use the **standard** (non-neural) engine, drop `--engine neural` — the script is
  compatible with both, though `amazon:domain` sounds best on neural voices.
