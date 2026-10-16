export function createRequestEpoch() {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (request: number) => request === current,
    invalidate: () => { current += 1; },
  };
}
