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
  console.log(`Start a quiz:     POST http://localhost:${PORT}/quiz/start   { "count": 5, "studentId": "..." }`);
  console.log(`Join a shared deck: POST http://localhost:${PORT}/decks/<sessionId>/join   { "studentId": "..." }`);
  console.log(`Reminder digest:  GET  http://localhost:${PORT}/reminders/digest?studentId=<id>`);
  console.log(`Study streak:     GET  http://localhost:${PORT}/students/<studentId>/streak`);
  console.log(`Review session:   GET  http://localhost:${PORT}/review/session?studentId=<id>&maxCards=20`);
  console.log(`Import (Anki-style TSV): POST http://localhost:${PORT}/import   { "tsv": "..." }`);
  console.log(`Regenerate a card: POST http://localhost:${PORT}/flashcards/<cardId>/regenerate`);
});
