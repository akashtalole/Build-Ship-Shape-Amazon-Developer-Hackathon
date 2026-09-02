import { createApp } from "./server.js";
import { SimulatedRingClient } from "./ringClient.js";
import { LoggingNotifier } from "./notify.js";
import { DEFAULT_DEV_WEBHOOK_SECRET, getWebhookSecret } from "./webhookAuth.js";

const PORT = Number(process.env.PORT ?? 4444);

const ringClient = new SimulatedRingClient();
const notifier = new LoggingNotifier();
const app = createApp(ringClient, notifier);

app.listen(PORT, () => {
  console.log(`PorchPass listening on http://localhost:${PORT}`);
  console.log(`Issue a pass:         POST http://localhost:${PORT}/passes`);
  console.log(`Simulate a "ding":    POST http://localhost:${PORT}/ring/events  (needs a valid X-Ring-Signature)`);
  console.log(`Live dashboard feed:  GET  http://localhost:${PORT}/events/stream`);
  if (getWebhookSecret() === DEFAULT_DEV_WEBHOOK_SECRET) {
    console.log(`Using the DEFAULT DEV webhook secret — set RING_WEBHOOK_SECRET before deploying this anywhere real.`);
  }
});
