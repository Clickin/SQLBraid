import { DirectAsyncContextStorage, type AsyncContextStorage } from "./async-context.js";

interface AsyncHooksModule {
  readonly AsyncLocalStorage: new <T>() => AsyncContextStorage<T>;
}

// A static node: import fails to load in a Worker without nodejs_compat, so resolve the module at run time.
const asyncHooks = (
  globalThis as { readonly process?: { getBuiltinModule?(id: string): unknown } }
).process?.getBuiltinModule?.("node:async_hooks") as AsyncHooksModule | undefined;

export function createAsyncContextStorage<T>(): AsyncContextStorage<T> & { readonly conservative: boolean } {
  if (asyncHooks === undefined) return new DirectAsyncContextStorage<T>();
  const storage = new asyncHooks.AsyncLocalStorage<T>();
  return {
    conservative: false,
    getStore: () => storage.getStore(),
    run: <R>(store: T, callback: () => R): R => storage.run(store, callback),
  };
}
