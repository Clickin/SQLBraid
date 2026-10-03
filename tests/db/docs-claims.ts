// Shared helpers for tests that prove documented behavior on real databases.
// A test title names the documentation page that makes the claim, so a failure
// points at the page to correct. Do not use the `[contract:` prefix here.
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ExecutionObserver } from "@sqlbraid/core";

export function docsClaim(page: string, claim: string, fn: () => Promise<void>, timeout = 60_000): void {
  test(`docs/${page}: ${claim}`, { timeout }, fn);
}

/** Runs `fn` and returns the SQLBraid error code, or "no-error". Async iterables are started. */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    const result = await fn();
    if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
      for await (const row of result as AsyncIterable<unknown>) {
        void row;
        break;
      }
    }
    return "no-error";
  } catch (error) {
    return (error as { code?: unknown }).code === undefined ? String(error) : String((error as { code: unknown }).code);
  }
}

export async function assertCode(fn: () => unknown, code: string): Promise<void> {
  assert.equal(await errorCode(fn), code);
}

/** Records the executionMode of the last `bulk:result` event. */
export function bulkModeObserver(): { readonly observer: ExecutionObserver; readonly mode: () => string | undefined } {
  let mode: string | undefined;
  return {
    observer: {
      onEvent(event) {
        if (event.type === "bulk:result") mode = event.executionMode;
      },
    },
    mode: () => mode,
  };
}
