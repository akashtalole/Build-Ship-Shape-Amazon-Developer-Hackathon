import { createApp } from "./server.js";
import { ModelRouter } from "./router.js";
import { MockSidecarClassifier } from "./sidecarClassifier.js";
import { MockBedrockProvider } from "./foundationModel.js";

const PORT = Number(process.env.PORT ?? 4567);

const router = new ModelRouter(new MockSidecarClassifier(), new MockBedrockProvider());
const app = createApp(router);

app.listen(PORT, () => {
  console.log(`Model router listening on http://localhost:${PORT}`);
  console.log(`Classify a message: POST http://localhost:${PORT}/classify  { "text": "..." }`);
  console.log(`View metrics:       GET  http://localhost:${PORT}/metrics`);
});
