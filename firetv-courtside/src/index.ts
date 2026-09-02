import { TemplateCommentaryProvider } from "./commentaryProvider.js";
import { createApp } from "./server.js";

const PORT = Number(process.env.PORT ?? 4455);

const provider = new TemplateCommentaryProvider();
const app = createApp(provider);

app.listen(PORT, () => {
  console.log(`CourtSide listening on http://localhost:${PORT}`);
  console.log(`Start a game:        POST http://localhost:${PORT}/games  { "homeTeam": "Hawks", "awayTeam": "Nets" }`);
  console.log(`Ingest a play:       POST http://localhost:${PORT}/games/:id/events  { "type": "score", "team": "home", "points": 2 }`);
  console.log(`Get game state:      GET  http://localhost:${PORT}/games/:id/state`);
  console.log(`Get commentary:      GET  http://localhost:${PORT}/games/:id/commentary`);
  console.log(`Ask a question:      POST http://localhost:${PORT}/games/:id/ask  { "question": "what's the score?" }`);
});
