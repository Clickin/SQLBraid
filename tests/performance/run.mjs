import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { measure, summarize } from "./harness.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "micro" },
    profile: { type: "string", default: "full" },
    rounds: { type: "string", default: "5" },
    time: { type: "string", default: "100" },
    warmup: { type: "string", default: "100" },
    seed: { type: "string", default: "2119" },
    filter: { type: "string", default: "" },
    out: { type: "string", default: "docs/performance/results/local" },
    round: { type: "string" },
    list: { type: "boolean", default: false },
  },
});
if (!["micro", "postgres"].includes(values.suite)) throw new Error("--suite must be micro or postgres");
if (!["smoke", "full"].includes(values.profile)) throw new Error("--profile must be smoke or full");
for (const key of ["rounds", "time", "warmup", "seed"]) {
  if (!Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1) throw new Error(`Invalid --${key}`);
}
const out = resolve(root, values.out);
await mkdir(out, { recursive: true });
const buildOverrides = {
  core: process.env.SQLBRAID_PERF_CORE,
  runtime: process.env.SQLBRAID_PERF_RUNTIME,
  postgres: process.env.SQLBRAID_PERF_POSTGRES,
};
if (Object.values(buildOverrides).some(Boolean)) {
  const { registerHooks } = await import("node:module");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const [name, directory] of Object.entries(buildOverrides)) {
        const prefix = `@sqlbraid/${name}`;
        if (directory && (specifier === prefix || specifier.startsWith(`${prefix}/`))) {
          const entry = specifier === prefix ? "index" : specifier.slice(prefix.length + 1);
          return { url: pathToFileURL(resolve(directory, `dist/${entry}.js`)).href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
  });
}
const command = (name, args) => {
  try {
    return execFileSync(name, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};
async function buildHashes() {
  const hashes = {};
  for (const pkg of ["core", "template", "runtime", "postgres", "compiler"]) {
    const hash = createHash("sha256");
    const directory = buildOverrides[pkg] ? resolve(buildOverrides[pkg], "dist") : join(root, "packages", pkg, "dist");
    for (const file of (await readdir(directory)).filter((name) => name.endsWith(".js")).toSorted()) {
      hash.update(file).update(await readFile(join(directory, file)));
    }
    hashes[pkg] = hash.digest("hex");
  }
  return hashes;
}
async function environment() {
  const versions = {};
  for (const name of [
    "pg",
    "pg-cursor",
    "pg-query-stream",
    "uql-orm",
    "kysely",
    "drizzle-orm",
    "tinybench",
    "typescript",
  ]) {
    versions[name] = JSON.parse(await readFile(join(root, "tests/node_modules", name, "package.json"), "utf8")).version;
  }
  return {
    timestamp: new Date().toISOString(),
    os: {
      platform: os.platform(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      product: command("sw_vers", ["-productVersion"]),
    },
    cpu: {
      model: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      availableParallelism: os.availableParallelism(),
    },
    ramBytes: os.totalmem(),
    runtime: {
      node: process.version,
      bun: process.versions.bun ?? command("bun", ["--version"]),
      v8: process.versions.v8,
      executable: process.execPath,
      execArgv: process.execArgv,
    },
    packages: versions,
    commit: command("git", ["rev-parse", "HEAD"]),
    productionSourceDiffSha256: createHash("sha256")
      .update(command("git", ["diff", "HEAD", "--", "packages"]) ?? "unavailable")
      .digest("hex"),
    builtJavaScriptSha256: await buildHashes(),
    buildOverrides,
    build:
      "pnpm run build:packages; tsdown ESM production artifacts; no development transpiler; repository minify:false",
  };
}

if (values.round !== undefined || values.list) {
  const { createSuite } = await import(`./${values.suite}.mjs`);
  const suite = await createSuite({ connectionString: process.env.SQLBRAID_PERF_URL, profile: values.profile });
  try {
    const cases = suite.cases.filter((entry) => new RegExp(values.filter).test(entry.name));
    if (cases.length === 0) throw new Error(`No cases match ${values.filter}`);
    if (values.list) {
      for (const entry of cases) console.log(`${entry.name}\t${entry.category}\t${entry.implementation}`);
    } else {
      const round = Number(values.round);
      const payload = {
        format: "sqlbraid-performance-v1",
        environment: await environment(),
        suite: values.suite,
        suiteMetadata: suite.metadata,
        methodology: {
          round,
          seed: Number(values.seed) + round,
          targetTimeMs: Number(values.time),
          warmupMs: Number(values.warmup),
          minimumIterations: 16,
          maximumIterations: 8192,
          calibration: "16 untimed pilot invocations select a fixed sample count before Tinybench warmup",
          gc: "natural; no explicit collections",
          concurrency: "one invocation; explicit concurrent cases identify fanout",
          samples: "all Tinybench latency samples, sorted, milliseconds",
          freshProcessPerRound: true,
        },
        results: await measure(cases, {
          time: Number(values.time),
          warmup: Number(values.warmup),
          seed: Number(values.seed) + round,
        }),
      };
      await writeFile(join(out, `${values.suite}-${round}.json.gz`), gzipSync(JSON.stringify(payload)));
    }
  } finally {
    await suite.close?.();
  }
} else {
  const rounds = [];
  for (let round = 0; round < Number(values.rounds); round += 1) {
    const args = [fileURLToPath(import.meta.url), ...process.argv.slice(2), "--round", String(round)];
    const child = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
    if (child.status !== 0) throw new Error(`Benchmark round ${round} failed (${child.status ?? child.signal})`);
    const measured = JSON.parse(gunzipSync(await readFile(join(out, `${values.suite}-${round}.json.gz`))));
    for (const entry of measured.results) delete entry.latencyMs.samples;
    rounds.push(measured);
  }
  const summary = {
    format: "sqlbraid-performance-summary-v1",
    environment: rounds[0].environment,
    suiteMetadata: rounds[0].suiteMetadata,
    methodology: {
      ...rounds[0].methodology,
      rounds: rounds.length,
      dispersion: "sample SD of independent round means; median of per-round mean/P50/P95; not pooled quantiles",
    },
    results: summarize(rounds),
  };
  await writeFile(join(out, `${values.suite}-summary.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `${summary.results.length} cases, ${rounds.length} fresh-process rounds: ${join(out, `${values.suite}-summary.json`)}`,
  );
}
