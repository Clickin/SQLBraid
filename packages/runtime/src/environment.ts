import type { DatabaseEnvironment } from "@sqlbraid/core";

export const environmentQueries = new WeakSet<object>();

export function runtimeEnvironment(): DatabaseEnvironment["runtime"] {
  const host = globalThis as typeof globalThis & {
    Deno?: { version?: { deno?: string } };
    Bun?: { version?: string };
    navigator?: { userAgent?: string };
  };
  if (host.Deno) return Object.freeze({ id: "deno", version: host.Deno.version?.deno });
  if (host.Bun) return Object.freeze({ id: "bun", version: host.Bun.version });
  if (host.navigator?.userAgent === "Cloudflare-Workers") return Object.freeze({ id: "workerd" });
  // Optional host reflection keeps Node globals/types out of the browser contract.
  const nodeVersion: unknown = Reflect.get(globalThis, "process")?.versions?.node;
  if (typeof nodeVersion === "string") {
    return Object.freeze({ id: "node", version: nodeVersion });
  }
  return Object.freeze({ id: "browser" });
}
