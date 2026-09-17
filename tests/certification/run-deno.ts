import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "./runner.ts";
import { isSourceSha, type CertificationTarget } from "./types.ts";
import { dirname } from "node:path";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<void>;
};

export interface DenoCertificationDescriptor {
  readonly target: CertificationTarget;
  readonly dispose: () => void | Promise<void>;
}

export type DenoCertificationFactory = (sourceSha: string) => DenoCertificationDescriptor | Promise<DenoCertificationDescriptor>;

export async function runDenoCertification(
  factories: Readonly<Record<string, DenoCertificationFactory>>,
  defaultTarget: string,
): Promise<void> {
  const sourceSha = Deno.env.get("SQLBRAID_CERT_SOURCE_SHA");
  if (!sourceSha || !isSourceSha(sourceSha)) throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  const targetId = Deno.env.get("SQLBRAID_CERT_TARGET") ?? defaultTarget;
  const factory = factories[targetId];
  if (!factory) throw new Error(`Unknown Deno certification target: ${targetId}`);
  const descriptor = await factory(sourceSha);
  try {
    const stress = Deno.env.get("SQLBRAID_CERT_STRESS");
    const artifact = await certifyTarget(descriptor.target, { stress: stress === "1" || stress === "true" });
    const artifactPath = Deno.env.get("SQLBRAID_CERT_ARTIFACT") ?? `/tmp/sqlbraid-cert-${targetId}.json`;
    validateCertificationArtifact(artifact, { sourceSha });
    await Deno.mkdir(dirname(artifactPath), { recursive: true });
    await writeCertificationArtifact(artifactPath, artifact);
  } finally {
    await descriptor.dispose();
  }
}
