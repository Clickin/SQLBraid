export interface AsyncContextStorage<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

/**
 * Browser fallback: async continuation is deliberately not emulated. The
 * runtime's direct-resource ownership checks remain conservative instead.
 */
export class DirectAsyncContextStorage<T> implements AsyncContextStorage<T> {
  readonly conservative = true;
  private current: T | undefined;

  getStore(): T | undefined {
    return this.current;
  }

  run<R>(store: T, callback: () => R): R {
    const previous = this.current;
    this.current = store;
    try {
      return callback();
    } finally {
      this.current = previous;
    }
  }
}

export function createAsyncContextStorage<T>(): AsyncContextStorage<T> & { readonly conservative: boolean } {
  return new DirectAsyncContextStorage<T>();
}
