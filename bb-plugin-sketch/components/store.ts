export type Listener = () => void;

function differs<T extends object>(state: T, patch: Partial<T>): boolean {
  return Object.entries(patch).some(([key, value]) => !Object.is(value, Reflect.get(state, key)));
}

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener>();

  constructor(initial: T) {
    this.state = initial;
  }

  readonly get = (): T => this.state;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(patch: Partial<T>): void {
    if (!differs(this.state, patch)) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}
