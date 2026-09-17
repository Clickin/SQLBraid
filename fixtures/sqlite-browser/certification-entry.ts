import { certifyTarget } from "../../tests/certification/execute.js";
import { createSqliteWasmTarget } from "../../tests/certification/targets/sqlite-wasm.js";

declare global {
  interface Window {
    __sqlbraidSqlite3?: Parameters<typeof createSqliteWasmTarget>[0];
    __sqlbraidCertificationArtifact?: unknown;
    __sqlbraidCertificationStressArtifact?: unknown;
    __sqlbraidCertificationError?: string;
    __sqlbraidWasmCertificationEvidence?: unknown;
  }
}

void (async () => {
  const sourceSha = new URLSearchParams(location.search).get("sourceSha") ?? "working-tree";
  try {
    const sqlite3 = window.__sqlbraidSqlite3;
    if (sqlite3 === undefined) throw new Error("SQLite WASM fixture did not expose its initialized sqlite3 module.");
    const target = createSqliteWasmTarget(sqlite3, sourceSha);
    const artifact = await certifyTarget(target);
    window.__sqlbraidCertificationArtifact = artifact;
    const stressArtifact = await certifyTarget(target, { stress: true });
    window.__sqlbraidCertificationStressArtifact = stressArtifact;
    window.__sqlbraidWasmCertificationEvidence = {
      target: target.id,
      sourceSha,
      cases: artifact.cases,
    };
  } catch (error) {
    window.__sqlbraidCertificationError = error instanceof Error ? error.stack ?? error.message : String(error);
  }
})();
