import { AsyncLocalStorage } from "node:async_hooks";
import type { AsyncContextStorage } from "./async-context.js";

export function createAsyncContextStorage<T>(): AsyncContextStorage<T> & { readonly conservative: false } {
  const storage = new AsyncLocalStorage<T>();
  return {
    conservative: false,
    getStore: () => storage.getStore(),
    run: <R>(store: T, callback: () => R): R => storage.run(store, callback),
  };
}
