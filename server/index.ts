import { jsonError } from "./security";
import { createApp } from "./app";
import { defaultDatabasePath } from "./config";
import { openDatabase, sweepAbandonedPending } from "./db";
import { SERVER_PORT } from "./runtime";

const db = openDatabase(defaultDatabasePath());

// One Bun backend: a pending assistant reply surviving this process is
// abandoned, so it settles as interrupted before serving. Never auto-resumed.
const abandoned = sweepAbandonedPending(db);
if (abandoned > 0) console.log(`storyfold: settled ${abandoned} abandoned pending reply(s) as interrupted`);

const app = createApp({ database: db });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: SERVER_PORT,
  // Narration streams can pause well past ten seconds (slow first tokens);
  // the default idle timeout would kill those connections mid-story.
  idleTimeout: 0,
  fetch: app.fetch,
  error: () => jsonError(500, "Internal server error"),
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  app.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`storyfold server listening on http://${server.hostname}:${server.port}`);
