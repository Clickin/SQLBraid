import { certifyTarget } from "../runner.ts";
import { nodeSqliteCertificationTarget } from "./sqlite-node-sqlite.ts";
import { sql } from "@sqlbraid/sqlite";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  readonly writeTextFile: (path: string, contents: string) => Promise<void>;
};

const sourceSha = Deno.env.get("SQLBRAID_CERT_SOURCE_SHA");
if (!sourceSha) throw new Error("SQLBRAID_CERT_SOURCE_SHA is required.");
const artifactPath = Deno.env.get("SQLBRAID_CERT_ARTIFACT") ?? "/tmp/sqlbraid-rc3-sqlite-node-sqlite-deno-2-9-3.json";
const target = {
  ...nodeSqliteCertificationTarget,
  id: "sqlite-node-sqlite-deno-2-9-3",
  sourceSha,
  createFixture: async () => {
    const fixture = await nodeSqliteCertificationTarget.createFixture();
    if (!fixture.stream) return fixture;
    const failureQuery = sql.rows`SELECT * FROM cert_missing_table`;
    const failure = { code: "ERR_SQLITE_ERROR" };
    return {
      ...fixture,
      stream: {
        ...fixture.stream,
        firstNextFailureQuery: failureQuery,
        firstNextFailure: failure,
        midStreamFailureQuery: failureQuery,
        midStreamFailure: failure,
        cleanupFailureQuery: failureQuery,
        cleanupFailure: failure,
      },
    };
  },
};
const stress = Deno.env.get("SQLBRAID_CERT_STRESS") === "1" || Deno.env.get("SQLBRAID_CERT_STRESS") === "true";
const artifact = await certifyTarget(target, { stress });
await Deno.writeTextFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
if (Object.values(artifact.cases).some((result) => result.status === "fail")) {
  throw new Error(`${target.id} certification contains failed cases.`);
}
