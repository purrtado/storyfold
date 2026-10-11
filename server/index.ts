import { jsonError } from "./security";
import { createApp } from "./app";
import { SERVER_PORT } from "./runtime";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: SERVER_PORT,
  fetch: createApp(),
  error: () => jsonError(500, "Internal server error"),
});

console.log(`storyfold server listening on http://${server.hostname}:${server.port}`);
