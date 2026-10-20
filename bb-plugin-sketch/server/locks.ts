const tails = new Map<string, Promise<void>>();

function acquire(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  tails.set(key, tail);
  return previous.then(() => () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  });
}

export async function withLocks<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const releases: (() => void)[] = [];
  try {
    for (const key of ordered) releases.push(await acquire(key));
    return await work();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
