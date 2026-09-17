import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "./runner.ts";
import type { CertificationTarget } from "./types.ts";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
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
  if (!sourceSha) throw new Error("SQLBRAID_CERT_SOURCE_SHA is required for certification artifacts.");
  const targetId = Deno.env.get("SQLBRAID_CERT_TARGET") ?? defaultTarget;
  const factory = factories[targetId];
  if (!factory) throw new Error(`Unknown Deno certification target: ${targetId}`);
  const descriptor = await factory(sourceSha);
  try {
    const artifact = await certifyTarget(descriptor.target, { stress: Deno.env.get("SQLBRAID_CERT_STRESS") === "true" });
    const artifactPath = Deno.env.get("SQLBRAID_CERT_ARTIFACT") ?? `/tmp/sqlbraid-cert-${targetId}.json`;
    await writeCertificationArtifact(artifactPath, artifact);
    validateCertificationArtifact(artifact, { sourceSha });
  } finally {
    await descriptor.dispose();
  }
}
