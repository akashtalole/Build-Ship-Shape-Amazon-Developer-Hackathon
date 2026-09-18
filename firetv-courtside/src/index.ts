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
  console.log(`Get commentary:      GET  http://localhost:${PORT}/games/:id/commentary  (?since=..., ?viewerId=...)`);
  console.log(`Live commentary:     GET  http://localhost:${PORT}/games/:id/stream  (Server-Sent Events)`);
  console.log(`Fast/escalated split GET  http://localhost:${PORT}/games/:id/metrics`);
  console.log(`Set preferences:     POST http://localhost:${PORT}/games/:id/viewers/:viewerId/preferences  { "favoriteTeam": "Hawks", "verbosity": "detailed" }`);
  console.log(`Ask a question:      POST http://localhost:${PORT}/games/:id/ask  { "question": "what's the score?" }`);
  console.log(`Game highlights:     GET  http://localhost:${PORT}/games/:id/highlights`);
  console.log(`Subscribe to alerts: POST http://localhost:${PORT}/games/:id/subscriptions  { "callbackUrl": "https://..." }`);
  console.log(`Multi-game watchlist GET  http://localhost:${PORT}/watchlist?viewerId=...`);
  console.log(`Team stats:          GET  http://localhost:${PORT}/stats/team/:teamName`);
  console.log(`Player stats:        GET  http://localhost:${PORT}/stats/player/:playerName`);
  console.log(`Catch-up recap:      GET  http://localhost:${PORT}/games/:id/recap  (?sinceMinutes=10 or ?since=...)`);
  console.log(`Player-level alert:  POST http://localhost:${PORT}/games/:id/subscriptions  { "callbackUrl": "https://...", "playerName": "Trae" }`);
});
