const children = ["dev:server", "dev:ui"].map((script) =>
  Bun.spawn(["bun", "run", script], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
);

let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  void Promise.all(children.map((child) => child.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
for (const child of children) {
  void child.exited.then((code) => stop(code === 0 ? 0 : 1));
}

await Promise.all(children.map((child) => child.exited));
export {};
