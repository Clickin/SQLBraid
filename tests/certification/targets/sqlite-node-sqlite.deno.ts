import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "../runner.ts";
import { assertDenoSourceSha } from "../run-deno.ts";
import { nodeSqliteCertificationTarget } from "./sqlite-node-sqlite.ts";
import { isSourceSha } from "../types.ts";
import { dirname } from "node:path";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  readonly version: { readonly deno: string };
  readonly writeTextFile: (path: string, contents: string) => Promise<void>;
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<void>;
};

const sourceSha = Deno.env.get("SQLBRAID_CERT_SOURCE_SHA");
if (!sourceSha || !isSourceSha(sourceSha)) throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
await assertDenoSourceSha(sourceSha);
const artifactPath = Deno.env.get("SQLBRAID_CERT_ARTIFACT");
if (!artifactPath) throw new Error("SQLBRAID_CERT_ARTIFACT is required.");
const target = {
  ...nodeSqliteCertificationTarget,
  id: "sqlite-node-sqlite-deno-2-9-3",
  sourceSha,
  measuredDriverVersion: Deno.version.deno,
  measuredRuntimeVersion: Deno.version.deno,
};
const stress = Deno.env.get("SQLBRAID_CERT_STRESS") === "1" || Deno.env.get("SQLBRAID_CERT_STRESS") === "true";
const artifact = await certifyTarget(target, { stress });
validateCertificationArtifact(artifact, { sourceSha });
await Deno.mkdir(dirname(artifactPath), { recursive: true });
await writeCertificationArtifact(artifactPath, artifact);
if (Object.values(artifact.cases).some((result) => result.status === "fail")) {
  throw new Error(`${target.id} certification contains failed cases.`);
}
