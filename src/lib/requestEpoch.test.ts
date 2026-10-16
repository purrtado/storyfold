import { expect, test } from "bun:test";
import { createRequestEpoch } from "./requestEpoch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("an older campaign response cannot replace the latest result", async () => {
  const epoch = createRequestEpoch();
  const campaignA = deferred<string>();
  const campaignB = deferred<string>();
  let displayed = "";

  const requestA = epoch.next();
  const loadA = campaignA.promise.then((result) => {
    if (epoch.isCurrent(requestA)) displayed = result;
  });
  const requestB = epoch.next();
  const loadB = campaignB.promise.then((result) => {
    if (epoch.isCurrent(requestB)) displayed = result;
  });

  campaignB.resolve("Campaign B");
  await loadB;
  campaignA.resolve("Campaign A");
  await loadA;

  expect(displayed).toBe("Campaign B");
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
  response.resolve("Unmounted campaign");
  await load;

  expect(displayed).toBe("");
});
