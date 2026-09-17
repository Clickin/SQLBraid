import { certifyTarget } from "../runner.ts";
import { createPostgresTarget, disposePostgresTarget } from "./postgres-pg.ts";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  readonly writeTextFile: (path: string, contents: string) => Promise<void>;
};

const connectionUri = Deno.env.get("SQLBRAID_POSTGRES_URL");
const sourceSha = Deno.env.get("SQLBRAID_CERT_SOURCE_SHA");
if (!connectionUri) throw new Error("SQLBRAID_POSTGRES_URL is required for the Deno PostgreSQL artifact.");
if (!sourceSha) throw new Error("SQLBRAID_CERT_SOURCE_SHA is required for the Deno PostgreSQL artifact.");

const target = createPostgresTarget("postgres-pg-deno-2-9-3", connectionUri, sourceSha);
try {
  const artifact = await certifyTarget(target, { stress: Deno.env.get("SQLBRAID_CERT_STRESS") === "true" });
  await Deno.writeTextFile(
    Deno.env.get("SQLBRAID_CERT_ARTIFACT") ?? "/tmp/sqlbraid-rc3-pg-postgres-pg-deno-2-9-3.json",
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  if (Object.values(artifact.cases).some((result) => result.status === "fail")) {
    throw new Error("Deno PostgreSQL certification produced failing cases.");
  }
} finally {
  await disposePostgresTarget(target.id);
}
