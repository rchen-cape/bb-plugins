export interface EchoFilter {
  note(fileName: string, stamp: string | null): void;
  consume(fileName: string, stamp: string | null): boolean;
}

export function createEchoFilter(): EchoFilter {
  const pending = new Map<string, string | null>();
  return {
    note(fileName, stamp) {
      pending.set(fileName, stamp);
    },
    consume(fileName, stamp) {
      if (!pending.has(fileName)) return false;
      const expected = pending.get(fileName);
      pending.delete(fileName);
      return expected === stamp;
    },
  };
}
