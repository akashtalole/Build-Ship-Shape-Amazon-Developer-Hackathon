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
  console.log(`Set fantasy roster:  POST http://localhost:${PORT}/games/:id/fantasy/:viewerId  { "players": ["Trae", "Bridges"] }`);
  console.log(`Fantasy highlights:  GET  http://localhost:${PORT}/games/:id/fantasy/:viewerId`);
  console.log(`Pose a prediction:   POST http://localhost:${PORT}/games/:id/predictions  { "type": "next_possession_score" }`);
  console.log(`Answer a prediction: POST http://localhost:${PORT}/games/:id/predictions/:predictionId/answer  { "viewerId": "v1", "answer": "yes" }`);
  console.log(`Prediction accuracy: GET  http://localhost:${PORT}/viewers/:viewerId/predictions/accuracy`);
  console.log(`Create a watch party:POST http://localhost:${PORT}/games/:id/parties  { "name": "Living Room", "viewerId": "v1" }`);
  console.log(`Ask into a party:    POST http://localhost:${PORT}/games/:id/ask  { "question": "...", "viewerId": "v1", "partyId": "..." }`);
  console.log(`Localized commentary:GET  http://localhost:${PORT}/games/:id/commentary?locale=en-casual  (or es-broadcast)`);
});
