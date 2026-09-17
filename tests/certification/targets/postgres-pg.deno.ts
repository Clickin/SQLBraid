import { runDenoCertification, type DenoCertificationDescriptor } from "../run-deno.ts";
import { createPostgresTarget, disposePostgresTarget, type PostgresTargetId } from "./postgres-pg.ts";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
};

const connectionUri = Deno.env.get("SQLBRAID_POSTGRES_URL");
if (!connectionUri) throw new Error("SQLBRAID_POSTGRES_URL is required for the Deno PostgreSQL artifact.");
const pgMetadata = await import("npm:pg/package.json", { with: { type: "json" } });
const measuredDriverVersion = pgMetadata.default.version;
if (typeof measuredDriverVersion !== "string" || measuredDriverVersion.length === 0) throw new Error("Deno pg package metadata did not expose a version.");

const targetIds: readonly PostgresTargetId[] = ["postgres-pg-node-16-4", "postgres-current", "postgres-pg-deno-2-9-3"];
const descriptorFor = (targetId: PostgresTargetId) => async (sourceSha: string): Promise<DenoCertificationDescriptor> => ({
  target: createPostgresTarget(targetId, connectionUri, sourceSha, measuredDriverVersion),
  dispose: () => disposePostgresTarget(targetId),
});

await runDenoCertification(
  Object.fromEntries(targetIds.map((targetId) => [targetId, descriptorFor(targetId)])),
  "postgres-pg-deno-2-9-3",
);
