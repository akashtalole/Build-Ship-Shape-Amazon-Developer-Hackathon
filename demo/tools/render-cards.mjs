// Renders every card and clip-placeholder slate in demo/script.json to a
// 1920x1080 PNG in demo/cards/. Usage (from the repo root):
//   (cd alexa-homeops-mcp && npm test) > /tmp/homeops-tests.txt
//   node demo/tools/render-cards.mjs /tmp/homeops-tests.txt
// Needs Playwright with Chromium (a global install works: NODE_PATH="$(npm root -g)").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, "..");
const script = JSON.parse(fs.readFileSync(path.join(demoDir, "script.json"), "utf-8"));
const testsFile = process.argv[2];
const outDir = path.join(demoDir, "cards");
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const TEST_HIGHLIGHTS = [
  /all \d+ HomeOps tools discoverable/,
  /reorder_item confirms via MCP elicitation/,
  /run_morning_briefing/,
  /capture_note routes a freeform 'running low'/,
  /get_proactive_alerts flags/,
  /two different bearer tokens/,
  /survives a simulated restart/,
  /uses Claude on Bedrock/,
  /capture_note classifies via Claude on Bedrock/,
  /MCP sampling is still preferred/,
  /a refusal from/,
  /a failing Bedrock endpoint degrades/,
  /the voice profile exposes only/,
];

function testLines() {
  if (!testsFile) throw new Error("Pass the path to captured `npm test` output as the first argument.");
  const lines = fs.readFileSync(testsFile, "utf-8").split("\n");
  const checks = lines.filter((l) => l.startsWith("✓"));
  const picked = TEST_HIGHLIGHTS.map((re) => checks.find((l) => re.test(l))).filter(Boolean);
  const passed = lines.find((l) => /tests passed/.test(l));
  if (!passed) throw new Error("Captured test output doesn't end in a pass; refusing to render a tests card from it.");
  return { picked, total: checks.length, passed };
}

const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1920px; height: 1080px; overflow: hidden; font-family: Inter, "DejaVu Sans", sans-serif;
         color: #F2F4F7; background: radial-gradient(1400px 900px at 15% 10%, #1A2230 0%, #0E1116 60%); }
  .frame { position: absolute; inset: 0; padding: 110px 130px; display: flex; flex-direction: column; }
  .label { font-size: 26px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #3DD6C6; }
  .muted { color: #9AA4B2; }
  .grow { flex: 1; }
  .mono { font-family: "DejaVu Sans Mono", monospace; }
  .bubble { margin-top: 28px; padding: 36px 44px; border-radius: 28px; background: #18202B; border: 2px solid #26313F;
            font-size: 50px; font-weight: 600; line-height: 1.3; max-width: 1500px; }
  .bubble + .bubble { margin-top: 18px; }
  .box { border: 2px solid #2E3A4A; background: #151C26; border-radius: 22px; padding: 30px 32px; }
  .box h3 { font-size: 34px; font-weight: 800; margin-bottom: 12px; }
  .box p { font-size: 25px; line-height: 1.4; color: #B7C0CC; }
`;

function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`;
}

const cards = {
  title: () => page(`<div class="frame">
    <div class="label">Alexa+ track · AWS Builder mini-challenge</div>
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:190px;font-weight:800;letter-spacing:-0.03em;line-height:1">HomeOps</div>
      <div style="font-size:52px;font-weight:600;line-height:1.3;margin-top:40px;max-width:1500px">
        A household agent that asks before it spends,<br>and speaks up before problems happen.</div>
    </div>
    <div class="muted" style="font-size:28px">Self-hosted MCP server · protocol 2025-11-25 · Streamable HTTP</div>
  </div>`),

  beat: (s) => page(`<div class="frame">
    <div class="label">Beat ${s.beat} of 4</div>
    <div style="font-size:96px;font-weight:800;letter-spacing:-0.02em;margin-top:24px;line-height:1.1">${esc(s.heading)}</div>
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center">
      <div class="muted" style="font-size:30px;font-weight:600">YOU SAY TO ALEXA+</div>
      ${s.say.map((l) => `<div class="bubble">“${esc(l)}”</div>`).join("")}
    </div>
  </div>`),

  placeholder: (s) => page(`<div class="frame" style="border:18px solid transparent;
      border-image: repeating-linear-gradient(45deg,#F5B841 0 40px,#0E1116 40px 80px) 18;">
    <div class="label" style="color:#F5B841">Placeholder · not for submission</div>
    <div style="font-size:64px;font-weight:800;margin-top:18px">Alexa+ simulator clip goes here</div>
    <div class="muted mono" style="font-size:30px;margin-top:14px">Save the recording as demo/${esc(s.clip)}</div>
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:34px">
      <div><div class="muted" style="font-size:28px;font-weight:600">SAY</div>
        ${s.say.map((l) => `<div style="font-size:46px;font-weight:600;margin-top:10px">“${esc(l)}”</div>`).join("")}</div>
      <div><div class="muted" style="font-size:28px;font-weight:600">EXPECTED FROM HOMEOPS</div>
        <div style="font-size:32px;line-height:1.45;margin-top:10px;max-width:1550px;color:#C9D2DD">${esc(s.expect)}</div></div>
    </div>
  </div>`),

  architecture: () => page(`<div class="frame">
    <div class="label">Under the hood · AWS</div>
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:56px">
      <div style="display:grid;grid-template-columns:1fr 150px 1.25fr 150px 1fr;align-items:center">
        <div class="box"><h3>Alexa+</h3><p>Agent picks HomeOps tools; confirms purchases via MCP elicitation</p></div>
        <div style="text-align:center"><div style="font-size:21px;font-weight:600;color:#3DD6C6;margin-bottom:6px">MCP · HTTPS</div><svg viewBox="0 0 150 60" width="150" height="60"><path d="M8 30 H132" stroke="#3DD6C6" stroke-width="5"/><path d="M122 16 L140 30 L122 44" fill="none" stroke="#3DD6C6" stroke-width="5"/></svg></div>
        <div class="box" style="border-color:#3DD6C6"><h3>HomeOps MCP server</h3><p>Amazon ECS Express Mode<br>Fargate task + HTTPS load balancer<br>12-tool voice profile</p></div>
        <div style="text-align:center"><div class="muted" style="font-size:21px;font-weight:600;margin-bottom:6px">if needed</div><svg viewBox="0 0 150 60" width="150" height="60"><path d="M8 30 H132" stroke="#9AA4B2" stroke-width="5" stroke-dasharray="12 9"/><path d="M122 16 L140 30 L122 44" fill="none" stroke="#9AA4B2" stroke-width="5"/></svg></div>
        <div class="box"><h3>Claude on Amazon Bedrock</h3><p>Only when the client can't run its own model · refusal → fallback model</p></div>
      </div>
      <div class="box" style="background:#11171F">
        <p class="mono" style="font-size:30px;color:#F2F4F7">$ ./deploy/deploy.sh alexa-homeops-mcp</p>
        <p style="margin-top:12px">From AWS CloudShell: image → Amazon ECR → ECS Express service with a public HTTPS URL.
          Task role: AWS managed policy <span class="mono">AmazonBedrockMantleInferenceAccess</span>.</p>
      </div>
    </div>
  </div>`),

  tests: () => {
    const { picked, total, passed } = testLines();
    return page(`<div class="frame">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div class="label">Tested end to end</div>
        <div style="font-size:44px;font-weight:800;color:#5BD69B">${total} / ${total} checks pass</div>
      </div>
      <div style="margin-top:40px;border-radius:20px;overflow:hidden;border:2px solid #26313F;background:#0A0D12">
        <div style="padding:16px 24px;background:#18202B;font-size:22px" class="muted mono">alexa-homeops-mcp — npm test (real MCP client over Streamable HTTP)</div>
        <div class="mono" style="padding:26px 30px;font-size:21px;line-height:1.7">
          ${picked.map((l) => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:#5BD69B">✓</span>${esc(l.slice(1))}</div>`).join("")}
          <div style="margin-top:14px;color:#5BD69B;font-weight:700">${esc(passed)}</div>
        </div>
      </div>
    </div>`);
  },

  close: () => page(`<div class="frame">
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:150px;font-weight:800;letter-spacing:-0.03em;line-height:1">HomeOps</div>
      <div style="font-size:50px;font-weight:600;line-height:1.3;margin-top:36px">Asks before it spends.<br>Speaks up before problems happen.</div>
      <div class="mono" style="font-size:30px;margin-top:70px;color:#3DD6C6">github.com/akashtalole/Build-Ship-Shape-Amazon-Developer-Hackathon</div>
    </div>
    <div class="muted" style="font-size:28px">Built with MCP · Amazon ECS Express Mode · Claude on Amazon Bedrock</div>
  </div>`),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const tab = await browser.newPage({ viewport: { width: script.width, height: script.height } });
for (const seg of script.segments) {
  const html = seg.clip ? cards.placeholder(seg) : cards[seg.card](seg);
  await tab.setContent(html, { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: path.join(outDir, `${seg.id}.png`) });
  console.log(`rendered cards/${seg.id}.png`);
}
await browser.close();
