import { certifyTarget, validateCertificationArtifact, writeCertificationArtifact } from "./runner.ts";
import { isSourceSha, type CertificationTarget } from "./types.ts";
import { dirname } from "node:path";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
  readonly version: { readonly deno: string };
  readonly Command: new (
    command: string,
    options: { readonly args: readonly string[] },
  ) => {
    output(): Promise<{ readonly success: boolean; readonly stdout: Uint8Array }>;
  };
  readonly mkdir: (path: string, options?: { readonly recursive?: boolean }) => Promise<void>;
};

export interface DenoCertificationDescriptor {
  readonly target: CertificationTarget;
  readonly dispose: () => void | Promise<void>;
}

export type DenoCertificationFactory = (
  sourceSha: string,
) => DenoCertificationDescriptor | Promise<DenoCertificationDescriptor>;

export async function loadDenoDriverVersion(packageName: string): Promise<string> {
  const metadata = await import(`npm:${packageName}/package.json`, { with: { type: "json" } });
  const version: unknown = metadata.default?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Deno ${packageName} package metadata did not expose a version.`);
  }
  return version;
}

export async function assertDenoSourceSha(sourceSha: string): Promise<void> {
  const result = await new Deno.Command("git", { args: ["rev-parse", "HEAD"] }).output();
  if (!result.success)
    throw new Error("Deno certification source SHA cannot be verified because the checkout has no readable git HEAD.");
  const head = new TextDecoder().decode(result.stdout).trim();
  if (head.toLowerCase() !== sourceSha.toLowerCase()) {
    throw new Error(`Deno certification source SHA ${sourceSha} does not match checked-out HEAD ${head}.`);
  }
}

export async function runDenoCertification(
  factories: Readonly<Record<string, DenoCertificationFactory>>,
  defaultTarget: string,
): Promise<void> {
  const sourceSha = Deno.env.get("SQLBRAID_CERT_SOURCE_SHA");
  if (!sourceSha || !isSourceSha(sourceSha))
    throw new Error("SQLBRAID_CERT_SOURCE_SHA must be a full 40-character SHA.");
  await assertDenoSourceSha(sourceSha);
  const targetId = Deno.env.get("SQLBRAID_CERT_TARGET") ?? defaultTarget;
  const factory = factories[targetId];
  if (!factory) throw new Error(`Unknown Deno certification target: ${targetId}`);
  const descriptor = await factory(sourceSha);
  try {
    const stress = Deno.env.get("SQLBRAID_CERT_STRESS");
    const target = { ...descriptor.target, measuredRuntimeVersion: Deno.version.deno };
    const artifact = await certifyTarget(target, { stress: stress === "1" || stress === "true" });
    const artifactPath = Deno.env.get("SQLBRAID_CERT_ARTIFACT") ?? `/tmp/sqlbraid-cert-${targetId}.json`;
    validateCertificationArtifact(artifact, { sourceSha });
    await Deno.mkdir(dirname(artifactPath), { recursive: true });
    await writeCertificationArtifact(artifactPath, artifact);
  } finally {
    await descriptor.dispose();
  }
}
