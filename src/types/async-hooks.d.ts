// Minimal typing for AsyncLocalStorage (available in Workers with the nodejs_compat flag).
// We don't load all of @types/node into the Worker build because it conflicts with workers-types.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
