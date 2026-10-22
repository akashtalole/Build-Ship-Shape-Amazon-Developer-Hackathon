# Demo video

Everything for the Devpost demo video (under 3 minutes). [`script.json`](./script.json) is the single source: the
narration, the cards, and the four Alexa+ simulator clips, in order.

| Part | Status |
|---|---|
| Title, beat, architecture, test-run and closing cards (`cards/`) | Rendered |
| Narration, draft voice (`narration/draft/`, local Piper TTS) | Rendered |
| Narration, final voice (`narration/polly/`, Amazon Polly) | Run `narration.py polly` in CloudShell (step 2) |
| **Four Alexa+ simulator clips (`clips/`)** | **Record these yourself (step 1)** |
| Final video | `./demo/assemble.sh` → `demo/out/homeops-demo.mp4` |

Until the clips exist, `assemble.sh` fills those slots with striped "placeholder, not for submission" slates. Devpost
requires the video to show the project running on the target platform, so submit only a cut with real simulator
footage.

## 1. Record the four simulator clips

**Before you start:**
- Deploy (`./deploy/deploy.sh alexa-homeops-mcp`) and register `https://<service-url>/mcp` in the Alexa+ web
  simulator **without a bearer token**. Without a token you get the seeded demo household (Jordan and Sam,
  recycling due today, dog food at 0, a $150 grocery budget). A token gets a fresh, empty household, and the lines
  below won't match.
- Start from fresh demo data. Household data lives inside the container, so a new task starts clean. After a
  rehearsal, restart it with
  `aws ecs update-service --cluster hackathon-express --service hackathon-homeops-mcp --force-new-deployment`.
- Record the clips **in this order, in one session.** Each step changes the data the next one reports on.

| Save as | Say | What HomeOps should do |
|---|---|---|
| `clips/1-briefing.mp4` | "Alexa, what's going on at home today?" | `run_morning_briefing`: 1 task due today (take out recycling), Sam next up for chores, 2 items running low, spending on track |
| `clips/2-capture.mp4` | "We're almost out of coffee." then "I just spent $120 on groceries." | `capture_note` adds coffee to the shopping list, then logs $120 under groceries (Alexa+ calling `add_expense` directly is also fine) |
| `clips/3-reorder.mp4` | "Reorder the dog food." then confirm | `reorder_item` asks "Dog food has 0 on hand. Reorder it now?" (MCP elicitation); after yes: "Reordered Dog food." |
| `clips/4-alerts.mp4` | "Is there anything I should know about?" | `get_proactive_alerts`: groceries at 120 of 150 after 1 day, on pace for ~840; paper towels never reordered. The dog-food alert is gone because it was just reordered |

These are the actual outputs of a local run of this exact sequence against the seed data. Alexa+ will phrase
them in its own words.

Tips: record just the browser tab at 1080p, then trim dead air at the start and end of each clip. With the
placeholder lengths (14s, 20s, 14s, 14s) the video runs 2:24, so you have about 30 seconds of slack in total.
`assemble.sh` warns if the cut goes over 2:58.

**AWS Builder evidence.** HomeOps only calls Claude on Bedrock when the client can't run its own model. If the
simulator *can*, Bedrock won't run in these clips. In that case the architecture and test cards carry the AWS
story, or you can swap in a short clip of the ECS console showing the running service.

## 2. Final voice (optional; the draft voice works)

In AWS CloudShell, from the repo root:

```bash
python3 demo/tools/narration.py polly --voice Matthew   # writes demo/narration/polly/*.mp3
```

`assemble.sh` prefers `narration/polly/` over `narration/draft/` segment by segment. `--voice Joanna` is another
good neural voice for this.

## 3. Assemble

```bash
./demo/assemble.sh        # needs bash, ffmpeg, ffprobe, python3
```

Clips of any resolution, frame rate or orientation are fitted to 1920×1080. Clips without audio get a silent track,
and loudness is normalized to −16 LUFS. Output: `demo/out/homeops-demo.mp4`. Upload that to YouTube or Vimeo for
the Devpost form.

No ffmpeg locally? Upload the four clips (and the Polly MP3s, if you made them) to a Claude Code session on this
repo and ask it to run `assemble.sh`.

## Changing the script

1. Edit `script.json`.
2. Re-render the narration:
   `python3 demo/tools/narration.py piper --model <en_US-lessac-high.onnx>` for the draft (needs `pip install
   piper-tts` and a [Piper voice](https://huggingface.co/rhasspy/piper-voices)), and/or `polly` for the final.
3. Re-render the cards:
   `(cd alexa-homeops-mcp && npm test) > /tmp/tests.txt && NODE_PATH="$(npm root -g)" node demo/tools/render-cards.mjs /tmp/tests.txt`
   (needs Playwright with Chromium). The test-run card uses that real test output and refuses to render unless
   it ends in a pass.
4. `python3 demo/tools/narration.py ssml` regenerates [`narration.ssml`](./narration.ssml), the whole script as
   one SSML document with a `<mark>` per segment, if you'd rather render it in one Polly call.
