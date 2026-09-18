#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const layers = ["integration", "boundary"];
const statuses = new Set(["guaranteed", "guarded", "unsupported"]);
const shaPattern = /^[a-f0-9]{40}$/u;
const markerPattern = /\[contract:([^:\]\s]+):([^:\]\s]+):(integration|boundary)\]/gu;
const ownershipPattern = /\[ownership:(direct|pooled)\]/gu;
const manifestFormat = "sqlbraid-contract-report";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const transportId = (target) =>
  target.driver.id === "bun-sql" ? `bun-sql-${target.database.product}` : target.driver.id;
const groupId = (target) => `${transportId(target)}:${target.driver.profile}`;
const tuple = (target) => ({
  target: target.id,
  transport: transportId(target),
  database: target.database,
  driver: target.driver,
  runtime: target.runtime,
});
const cellKey = (transport, scenario, layer, ownership) => `${transport}:${scenario}:${layer}:${ownership}`;
function requireThat(condition, message) {
  if (!condition) throw new Error(`CONTRACT_MATRIX: ${message}`);
}
function sameKeys(actual, expected, label) {
  requireThat(
    Array.isArray(actual) && new Set(actual).size === actual.length && equal([...actual].sort(), [...expected].sort()),
    `${label}: missing, duplicate or unknown entries`,
  );
}
function supported(entry, target, requirement) {
  const [kind, key] = requirement.split(":");
  if (kind === "native") {
    requireThat(typeof entry.native?.[key]?.supported === "boolean", `unclassified native semantic ${key}`);
    return entry.native[key].supported;
  }
  requireThat(kind === "capability", `unknown requirement ${requirement}`);
  const claim = target.capabilities[key] ?? entry.capabilityEvidence?.[key];
  requireThat(statuses.has(claim?.status), `${target.id}: missing capability classification ${key}`);
  return claim.status !== "unsupported";
}
function exclusionReason(entry, target, requirement) {
  const [kind, key] = requirement.split(":");
  return kind === "native"
    ? entry.native[key].reason
    : (entry.capabilityEvidence?.[key]?.reason ?? `${key} is unsupported by canonical support target ${target.id}.`);
}

/** Native facts fill gaps in support capabilities, never override an advertised capability. */
export function validateMatrix({ catalog, matrix, targets, profiles, registry, capabilityIds }) {
  requireThat(catalog?.version === 1 && matrix?.version === 1, "unsupported catalog or matrix version");
  requireThat(Array.isArray(catalog.scenarios) && catalog.scenarios.length > 0, "empty scenario catalog");
  const scenarios = new Map(catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  requireThat(scenarios.size === catalog.scenarios.length, "duplicate scenario ID");
  sameKeys(matrix.scenarioIds, [...scenarios.keys()], "scenario catalog mapping");
  const nativeKeys = new Set();
  for (const scenario of scenarios.values()) {
    requireThat(/^[a-z]+\.[a-z-]+$/u.test(scenario.id), `invalid scenario ID ${scenario.id}`);
    requireThat(
      [
        "transaction-outcome",
        "transaction-savepoint",
        "transaction-options",
        "pool-ownership",
        "resource-lifecycle",
        "cancellation",
        "command-metadata",
      ].includes(scenario.family),
      `${scenario.id}: unknown family`,
    );
    requireThat(
      typeof scenario.description === "string" && scenario.description.length > 0,
      `${scenario.id}: missing description`,
    );
    requireThat(["each", "pooled", "any"].includes(scenario.ownership), `${scenario.id}: invalid ownership`);
    requireThat(
      Array.isArray(scenario.evidence) &&
        scenario.evidence.length > 0 &&
        new Set(scenario.evidence).size === scenario.evidence.length &&
        scenario.evidence.every((layer) => layers.includes(layer)),
      `${scenario.id}: invalid evidence layer`,
    );
    requireThat(Array.isArray(scenario.requires), `${scenario.id}: missing requirements`);
    for (const requirement of scenario.requires) {
      const [kind, key, extra] = requirement.split(":");
      requireThat(
        extra === undefined && key && ["capability", "native"].includes(kind),
        `${scenario.id}: malformed requirement`,
      );
      if (kind === "native") nativeKeys.add(key);
      else requireThat(capabilityIds.includes(key), `${scenario.id}: unknown support capability ${key}`);
    }
  }
  const targetMap = new Map(targets.map((target) => [target.id, target]));
  requireThat(targetMap.size === targets.length, "duplicate support target ID");
  const groups = new Map();
  for (const target of targets) {
    requireThat(
      profiles.profiles[target.driver.profile]?.driverId === target.driver.id,
      `${target.id}: unknown or contradictory support profile ${target.driver.profile}`,
    );
    const key = groupId(target);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(target);
  }
  const classified = new Set();
  const cells = [];
  const exclusions = [];
  for (const [transport, entry] of Object.entries(matrix.transports ?? {})) {
    const target = targetMap.get(entry.target);
    requireThat(target, `${transport}: unknown canonical target ${entry.target}`);
    requireThat(transportId(target) === transport, `${transport}: canonical target transport mismatch`);
    const group = groupId(target);
    requireThat(!classified.has(group), `${group}: duplicate transport/profile classification`);
    classified.add(group);
    const siblings = groups.get(group);
    const releaseBlocking = siblings.some((sibling) => sibling.ci.releaseBlocking === true);
    requireThat(
      !releaseBlocking || target.ci.releaseBlocking === true,
      `${transport}: nonblocking canonical target hides a blocking tuple`,
    );
    sameKeys(Object.keys(entry.native ?? {}), [...nativeKeys], `${transport} native semantics`);
    for (const [name, fact] of Object.entries(entry.native)) {
      requireThat(
        typeof fact.supported === "boolean" &&
          typeof fact.reason === "string" &&
          fact.reason.trim().length > 0 &&
          typeof fact.source === "string" &&
          fact.source.startsWith("packages/"),
        `${transport}: unchecked native semantic ${name}`,
      );
    }
    const pool = entry.native.pool.supported;
    requireThat(
      Array.isArray(entry.ownership) &&
        entry.ownership.length > 0 &&
        new Set(entry.ownership).size === entry.ownership.length &&
        entry.ownership.every((owner) => owner === "direct" || owner === "pooled") &&
        entry.ownership.includes("pooled") === pool,
      `${transport}: contradictory ownership classification`,
    );
    // Bun network clients enter through a reserve provider; the public factory has no direct path.
    const expectedOwnership =
      target.driver.id === "bun-sql" && pool ? ["pooled"] : pool ? ["direct", "pooled"] : ["direct"];
    sameKeys(entry.ownership, expectedOwnership, `${transport} ownership`);
    for (const [capability, fact] of Object.entries(entry.capabilityEvidence ?? {})) {
      requireThat(
        capabilityIds.includes(capability) && statuses.has(fact.status) && fact.reason?.trim() && fact.source,
        `${transport}: invalid supplemental capability ${capability}`,
      );
      requireThat(
        target.capabilities[capability] === undefined,
        `${transport}: supplemental capability contradicts or duplicates support ${capability}`,
      );
    }
    for (const claim of Object.values(target.capabilities)) {
      for (const testId of claim.testIds ?? [])
        requireThat(registry[testId], `${target.id}: unknown support test ${testId}`);
    }
    sameKeys(Object.keys(entry.scenarios ?? {}), [...scenarios.keys()], `${transport} scenarios`);
    for (const scenario of scenarios.values()) {
      const mapping = entry.scenarios[scenario.id];
      for (const requirement of scenario.requires) {
        const [kind, capability] = requirement.split(":");
        if (
          kind === "capability" &&
          siblings.some((sibling) => ["guaranteed", "guarded"].includes(sibling.capabilities[capability]?.status))
        ) {
          requireThat(
            supported(entry, target, requirement),
            `${transport}: canonical target excludes an advertised ${capability} capability`,
          );
        }
      }
      const missing = scenario.requires.filter((requirement) => !supported(entry, target, requirement));
      if (missing.length > 0) {
        const exclusion = mapping.notApplicable;
        requireThat(
          Object.keys(mapping).length === 1 &&
            exclusion &&
            missing.includes(exclusion.requirement) &&
            exclusion.reason === exclusionReason(entry, target, exclusion.requirement),
          `${transport}:${scenario.id}: missing or contradictory N/A reason`,
        );
        exclusions.push({ transport, scenario: scenario.id, ...exclusion });
        continue;
      }
      requireThat(
        Object.keys(mapping).length === 1 && equal(mapping.evidence, scenario.evidence),
        `${transport}:${scenario.id}: required evidence omitted, wrong layer or contradictory N/A`,
      );
      const owners =
        scenario.ownership === "each" ? entry.ownership : scenario.ownership === "pooled" ? ["pooled"] : ["any"];
      for (const layer of scenario.evidence) {
        for (const ownership of owners) {
          cells.push({
            transport,
            scenario: scenario.id,
            layer,
            ownership,
            target: target.id,
            profile: target.driver.profile,
            releaseBlocking,
            key: cellKey(transport, scenario.id, layer, ownership),
          });
        }
      }
    }
  }
  sameKeys([...classified], [...groups.keys()], "first-party transport/profile roster");
  return { catalog, matrix, targets: targetMap, cells, exclusions };
}

export async function loadContractMatrix(directory = root) {
  const json = async (file) => JSON.parse(await readFile(join(directory, file), "utf8"));
  const [catalog, matrix, profiles, registry, capabilities, targetFiles] = await Promise.all([
    json("tests/contracts/catalog.json"),
    json("tests/contracts/matrix.json"),
    json("support/profiles.json"),
    json("support/test-registry.json"),
    json("support/capabilities.json"),
    readdir(join(directory, "support/targets")),
  ]);
  const targets = await Promise.all(
    targetFiles
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => json(`support/targets/${file}`)),
  );
  const input = {
    catalog,
    matrix,
    targets,
    profiles,
    registry,
    capabilityIds: capabilities.capabilities.map((capability) => capability.id),
  };
  const model = validateMatrix(input);
  const sources = new Set(
    Object.values(matrix.transports).flatMap((entry) =>
      [...Object.values(entry.native), ...Object.values(entry.capabilityEvidence ?? {})].map((fact) => fact.source),
    ),
  );
  for (const source of sources) {
    requireThat(!isAbsolute(source) && !source.split(/[\\/]/u).includes(".."), `invalid evidence source ${source}`);
    requireThat((await stat(join(directory, source))).isFile(), `missing semantic source ${source}`);
  }
  return { ...model, input };
}

/** Only assertion titles count; suite names, fullName and hand-authored scenario arrays do not. */
export function reportEvidence(report, manifest, model, sourceSha) {
  requireThat(shaPattern.test(sourceSha), "--source-sha must be a full lowercase commit SHA");
  requireThat(manifest?.format === manifestFormat && manifest.version === 1, "unknown report provenance format");
  requireThat(manifest.sourceSha === sourceSha, "stale report source SHA");
  requireThat(
    Array.isArray(manifest.allowedLayers) &&
      manifest.allowedLayers.length > 0 &&
      new Set(manifest.allowedLayers).size === manifest.allowedLayers.length &&
      manifest.allowedLayers.every((layer) => layers.includes(layer)),
    "invalid report layer provenance",
  );
  requireThat(
    typeof manifest.producer?.node === "string" &&
      typeof manifest.producer?.platform === "string" &&
      typeof manifest.producer?.arch === "string",
    "missing observed producer runtime",
  );
  requireThat(
    Array.isArray(manifest.expectedTargets) && manifest.expectedTargets.length > 0,
    "missing expected target bindings",
  );
  const bindings = new Map();
  for (const binding of manifest.expectedTargets) {
    const target = model.targets.get(binding.target);
    requireThat(target && equal(binding, tuple(target)), `forged or stale target/profile binding ${binding.target}`);
    requireThat(!bindings.has(binding.target), `duplicate target binding ${binding.target}`);
    bindings.set(binding.target, target);
  }
  requireThat(
    report?.success === true && Array.isArray(report.testResults) && report.testResults.length > 0,
    "report is not a successful Vitest JSON execution",
  );
  requireThat(
    report.numFailedTests === 0 && report.numFailedTestSuites === 0 && report.wasInterrupted !== true,
    "failed or interrupted Vitest report",
  );
  const cells = new Map(model.cells.map((cell) => [cell.key, cell]));
  const evidence = new Set();
  let assertionCount = 0;
  let passedCount = 0;
  for (const suite of report.testResults) {
    requireThat(suite.status !== "failed" && Array.isArray(suite.assertionResults), "invalid or failed Vitest suite");
    for (const assertion of suite.assertionResults) {
      assertionCount += 1;
      if (assertion.status === "passed") passedCount += 1;
      requireThat(
        ["passed", "pending", "skipped", "todo", "disabled"].includes(assertion.status),
        "failed or invalid individual assertion in successful report",
      );
      if (typeof assertion.title !== "string" || !assertion.title.includes("[contract:")) continue;
      const matches = [...assertion.title.matchAll(markerPattern)];
      requireThat(
        matches.length > 0 &&
          assertion.title.startsWith(matches[0][0]) &&
          matches.length === assertion.title.split("[contract:").length - 1,
        `malformed contract prefix: ${assertion.title}`,
      );
      let prefixEnd = 0;
      for (const match of matches) {
        requireThat(
          assertion.title.slice(prefixEnd, match.index).trim() === "",
          `contract tags must be leading prefixes: ${assertion.title}`,
        );
        prefixEnd = match.index + match[0].length;
      }
      requireThat(
        assertion.status === "passed" && (assertion.failureMessages?.length ?? 0) === 0,
        `contract assertion did not pass: ${assertion.title}`,
      );
      const owners = [...assertion.title.matchAll(ownershipPattern)].map((match) => match[1]);
      requireThat(owners.length <= 1, `ambiguous ownership evidence: ${assertion.title}`);
      for (const [, transport, scenario, layer] of matches) {
        const entry = model.matrix.transports[transport];
        requireThat(entry, `unknown contract transport ${transport}`);
        requireThat(
          model.catalog.scenarios.some((item) => item.id === scenario),
          `unknown contract scenario ${scenario}`,
        );
        requireThat(manifest.allowedLayers.includes(layer), `wrong provenance layer ${layer}: ${assertion.title}`);
        requireThat(
          entry.scenarios[scenario]?.evidence?.includes(layer),
          `N/A or wrong evidence layer ${transport}:${scenario}:${layer}`,
        );
        const matchingBindings = [...bindings.values()].filter((target) => transportId(target) === transport);
        requireThat(matchingBindings.length > 0, `unbound transport ${transport}`);
        // Version/runtime breadth reports are supplementary, never canonical evidence by inference.
        const canonical = matchingBindings.find((target) => target.id === entry.target);
        if (!canonical) continue;
        if (layer === "integration" && canonical.runtime.id === "node") {
          requireThat(
            manifest.producer.node === `v${canonical.runtime.version}`,
            `${transport}: observed Node ${manifest.producer.node} does not match canonical ${canonical.runtime.version}`,
          );
        }
        const scenarioCells = model.cells.filter(
          (cell) => cell.transport === transport && cell.scenario === scenario && cell.layer === layer,
        );
        if (scenarioCells.some((cell) => cell.ownership !== "any")) {
          requireThat(owners.length > 0, `missing ownership evidence: ${assertion.title}`);
          for (const owner of owners) {
            const key = cellKey(transport, scenario, layer, owner);
            requireThat(cells.has(key), `unsupported ownership ${key}`);
            evidence.add(key);
          }
        } else evidence.add(cellKey(transport, scenario, layer, "any"));
      }
    }
  }
  requireThat(
    report.numTotalTests === assertionCount && report.numPassedTests === passedCount,
    "incomplete or contradictory Vitest assertion totals",
  );
  return evidence;
}

async function reportFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await reportFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".contract.json")) files.push(path);
  }
  return files.sort();
}

export async function validateReports(directory, sourceSha, model) {
  const manifests = await reportFiles(directory);
  requireThat(manifests.length > 0, "no execution report provenance found");
  const passed = new Set();
  for (const file of manifests) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    const reportFile = file.slice(0, -".contract.json".length);
    const bytes = await readFile(reportFile);
    requireThat(
      manifest.report === basename(reportFile) && manifest.reportSha256 === digest(bytes),
      `report digest/name mismatch: ${file}`,
    );
    const report = JSON.parse(bytes.toString("utf8"));
    for (const key of reportEvidence(report, manifest, model, sourceSha)) passed.add(key);
  }
  const missing = model.cells.filter((cell) => cell.releaseBlocking && !passed.has(cell.key));
  requireThat(
    missing.length === 0,
    `missing passed execution evidence (${missing.length} cells):\n${missing.map((cell) => cell.key).join("\n")}`,
  );
  return {
    required: model.cells.filter((cell) => cell.releaseBlocking).length,
    passed: passed.size,
    reports: manifests.length,
  };
}

export async function recordReport(file, sourceSha, layer, targetIds, model, directory = root) {
  requireThat(shaPattern.test(sourceSha), "--source-sha must be a full lowercase commit SHA");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  requireThat(head === sourceSha, "recorded source SHA is not checkout HEAD");
  requireThat([...layers, "mixed"].includes(layer), "--layer must be integration, boundary or mixed");
  const selected =
    targetIds === "all" ? Object.values(model.matrix.transports).map((entry) => entry.target) : targetIds?.split(",");
  requireThat(
    selected?.length > 0,
    "--targets must name the exact support targets executed (or all for shared boundary reports)",
  );
  const expectedTargets = selected.map((id) => {
    const target = model.targets.get(id);
    requireThat(target, `unknown report target ${id}`);
    return tuple(target);
  });
  const bytes = await readFile(file);
  const manifest = {
    format: manifestFormat,
    version: 1,
    sourceSha,
    report: basename(file),
    reportSha256: digest(bytes),
    allowedLayers: layer === "mixed" ? layers : [layer],
    producer: { node: process.version, platform: process.platform, arch: process.arch },
    // These are expected bindings, not measurements of driver or database versions.
    // Existing same-SHA release/certification gates retain responsibility for measured tuples.
    expectedTargets,
  };
  reportEvidence(JSON.parse(bytes.toString("utf8")), manifest, model, sourceSha);
  await writeFile(`${file}.contract.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return `${file}.contract.json`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    requireThat(
      ["--reports", "--source-sha", "--record-report", "--layer", "--targets", "--list"].includes(name) &&
        !options.has(name),
      `unknown or duplicate option ${name}`,
    );
    if (name === "--list") options.set(name, true);
    else {
      const value = args[++index];
      requireThat(typeof value === "string" && !value.startsWith("--"), `missing value for ${name}`);
      options.set(name, value);
    }
  }
  requireThat(!(options.has("--reports") && options.has("--record-report")), "choose --reports or --record-report");
  const model = await loadContractMatrix();
  if (options.has("--record-report")) {
    console.log(
      await recordReport(
        resolve(options.get("--record-report")),
        options.get("--source-sha"),
        options.get("--layer"),
        options.get("--targets"),
        model,
      ),
    );
  } else if (options.has("--reports")) {
    console.log(
      JSON.stringify(await validateReports(resolve(options.get("--reports")), options.get("--source-sha"), model)),
    );
  } else if (options.has("--list")) {
    console.log(
      JSON.stringify(
        {
          canonicalTargets: Object.fromEntries(
            Object.entries(model.matrix.transports).map(([id, entry]) => [id, entry.target]),
          ),
          cells: model.cells,
          notApplicable: model.exclusions,
        },
        null,
        2,
      ),
    );
  } else {
    requireThat(options.size === 0, "evidence options require --reports or --record-report");
    console.log(
      `Contract matrix valid: ${model.catalog.scenarios.length} scenarios, ${Object.keys(model.matrix.transports).length} transport/profiles, ${model.cells.filter((cell) => cell.releaseBlocking).length} required evidence cells. Execution evidence was not checked.`,
    );
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
