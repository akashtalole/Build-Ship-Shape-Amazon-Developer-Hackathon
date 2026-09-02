import { createApp } from "./server.js";
import { TemplateFlashcardGenerator } from "./flashcardGenerator.js";

const PORT = Number(process.env.PORT ?? 4466);

const generator = new TemplateFlashcardGenerator();
const app = createApp(generator);

app.listen(PORT, () => {
  console.log(`StudyLoop listening on http://localhost:${PORT}`);
  console.log(`Ingest a session: POST http://localhost:${PORT}/sessions   { "title": "...", "transcript": "..." }`);
  console.log(`Append segments:  PATCH http://localhost:${PORT}/sessions/<id>/segments   { "segments": "..." }`);
  console.log(`Review queue:     GET  http://localhost:${PORT}/review/due`);
  console.log(`Leeches:          GET  http://localhost:${PORT}/review/leeches`);
  console.log(`Search by topic:  GET  http://localhost:${PORT}/flashcards/search?topic=<tag>`);
  console.log(`Export (Anki):    GET  http://localhost:${PORT}/export`);
});
