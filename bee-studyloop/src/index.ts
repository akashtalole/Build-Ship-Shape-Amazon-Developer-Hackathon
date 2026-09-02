import { createApp } from "./server.js";
import { TemplateFlashcardGenerator } from "./flashcardGenerator.js";

const PORT = Number(process.env.PORT ?? 4466);

const generator = new TemplateFlashcardGenerator();
const app = createApp(generator);

app.listen(PORT, () => {
  console.log(`StudyLoop listening on http://localhost:${PORT}`);
  console.log(`Ingest a session: POST http://localhost:${PORT}/sessions   { "title": "...", "transcript": "..." }`);
  console.log(`Review queue:     GET  http://localhost:${PORT}/review/due`);
});
