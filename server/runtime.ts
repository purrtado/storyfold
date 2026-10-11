export const SERVER_PORT = Number(process.env.STORYFOLD_PORT ?? 7834);

if (!Number.isInteger(SERVER_PORT) || SERVER_PORT < 1 || SERVER_PORT > 65535) {
  throw new Error("STORYFOLD_PORT must be an integer between 1 and 65535");
}
