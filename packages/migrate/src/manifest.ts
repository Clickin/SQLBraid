import { MigrationError } from "./errors.js";
import type { MigrationBody } from "./types.js";

/** SQL text, a migration function, or a frozen defineMigration() result. */
export function isMigrationBody(value: unknown): value is MigrationBody {
  if (typeof value === "string" || typeof value === "function") return true;
  if (!value || typeof value !== "object") return false;
  const definition = value as { readonly run?: unknown; readonly transaction?: unknown };
  return typeof definition.run === "function" && typeof definition.transaction === "boolean";
}

/** Canonical numeric identity, without conversion through floating-point numbers. */
export function normalizeVersion(version: string): string {
  if (!/^\d+(?:[._]\d+)*$/u.test(version)) {
    throw new MigrationError("BRAID_MIGRATE_SOURCE", `Invalid migration version: ${version}`);
  }
  const parts = version.split(/[._]/u).map((part) => part.replace(/^0+(?=\d)/u, ""));
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return parts.join(".");
}

/** Compares dotted (or underscore-separated) numeric versions at arbitrary precision. */
export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left).split(".");
  const b = normalizeVersion(right).split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const first = a[index] ?? "0";
    const second = b[index] ?? "0";
    if (first.length !== second.length) return first.length < second.length ? -1 : 1;
    if (first !== second) return first < second ? -1 : 1;
  }
  return 0;
}
