import { assertCertificationCasesPass, certifyTarget } from "../../tests/certification/execute.js";
import { createSqliteWasmTarget } from "../../tests/certification/targets/sqlite-wasm.js";

declare global {
  interface Window {
    __sqlbraidSqlite3?: Parameters<typeof createSqliteWasmTarget>[0];
    __sqlbraidCertificationArtifact?: unknown;
    __sqlbraidCertificationError?: string;
    __sqlbraidWasmCertificationEvidence?: unknown;
  }
}

void (async () => {
  const search = new URLSearchParams(location.search);
  const sourceSha = search.get("sourceSha") ?? "working-tree";
  const stress = search.get("stress") === "1";
  try {
    const sqlite3 = window.__sqlbraidSqlite3;
    if (sqlite3 === undefined) throw new Error("SQLite WASM fixture did not expose its initialized sqlite3 module.");
    const measuredDriverVersion = search.get("driverVersion");
    const measuredRuntimeVersion = search.get("runtimeVersion");
    if (measuredDriverVersion === null || measuredRuntimeVersion === null)
      throw new Error("SQLite WASM certification requires measured driver and browser versions.");
    const target = createSqliteWasmTarget(sqlite3, sourceSha, { measuredDriverVersion, measuredRuntimeVersion });
    const artifact = await certifyTarget(target, { stress });
    assertCertificationCasesPass(artifact.cases);
    window.__sqlbraidCertificationArtifact = artifact;
    window.__sqlbraidWasmCertificationEvidence = {
      target: target.id,
      sourceSha,
      cases: artifact.cases,
    };
  } catch (error) {
    window.__sqlbraidCertificationError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
})();
