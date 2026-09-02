import { createApp } from "./server.js";
import { SimulatedRingClient } from "./ringClient.js";
import { LoggingNotifier } from "./notify.js";

const PORT = Number(process.env.PORT ?? 4444);

const ringClient = new SimulatedRingClient();
const notifier = new LoggingNotifier();
const app = createApp(ringClient, notifier);

app.listen(PORT, () => {
  console.log(`PorchPass listening on http://localhost:${PORT}`);
  console.log(`Issue a pass:      POST http://localhost:${PORT}/passes`);
  console.log(`Simulate a "ding": POST http://localhost:${PORT}/ring/events  { "deviceId": "front-door", "type": "ding" }`);
});
