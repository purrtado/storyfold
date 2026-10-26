import { expect, test } from "bun:test";
import { createRequestEpoch } from "./requestEpoch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("an older chat response cannot replace the latest result", async () => {
  const epoch = createRequestEpoch();
  const chatA = deferred<string>();
  const chatB = deferred<string>();
  let displayed = "";

  const requestA = epoch.next();
  const loadA = chatA.promise.then((result) => {
    if (epoch.isCurrent(requestA)) displayed = result;
  });
  const requestB = epoch.next();
  const loadB = chatB.promise.then((result) => {
    if (epoch.isCurrent(requestB)) displayed = result;
  });

  chatB.resolve("Chat B");
  await loadB;
  chatA.resolve("Chat A");
  await loadA;

  expect(displayed).toBe("Chat B");
});

test("effect cleanup invalidates a request still in flight", async () => {
  const epoch = createRequestEpoch();
  const response = deferred<string>();
  let displayed = "";
  const request = epoch.next();
  const load = response.promise.then((result) => {
    if (epoch.isCurrent(request)) displayed = result;
  });

  epoch.invalidate();
  response.resolve("Unmounted chat");
  await load;

  expect(displayed).toBe("");
});
