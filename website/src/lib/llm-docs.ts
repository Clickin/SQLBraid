import type { CollectionEntry } from "astro:content";
import { loadSupportMatrix, type SupportTarget } from "./support-matrix";

const projectRoot = "/SQLBraid/";

export function docsBasePath() {
  return import.meta.env.BASE_URL.replace(/\/+$/u, "");
}

export function rawMarkdownPath(id: string, base = docsBasePath()) {
  return `${base}/${id}.md`;
}

export function rawMarkdownUrl(id: string, base = docsBasePath()) {
  return `https://clickin.github.io${rawMarkdownPath(id, base)}`;
}

function supportTargetMarkdown(target: SupportTarget, conditionLabels: ReadonlyMap<string, string>) {
  const capabilityRows = Object.entries(target.capabilities).map(([id, claim]) => {
    const details = [
      claim.status,
      claim.conditionCode && `${claim.conditionCode}: ${conditionLabels.get(claim.conditionCode) ?? "condition details unavailable"}`,
      claim.semantics,
      claim.representation,
      claim.fidelity,
      claim.binaryPrecision === undefined ? undefined : `binaryPrecision=${claim.binaryPrecision}`,
      claim.driverRawRepresentations?.length ? `raw=${claim.driverRawRepresentations.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    return `| \`${id}\` | ${details || "—"} |`;
  }).join("\n");
  const numericRows = Object.entries(target.numeric)
    .map(([kind, contract]) => `| ${kind} | ${contract.representation} | ${contract.fidelity} | ${contract.profile ?? "—"} |`)
    .join("\n");
  const containerRows = Object.entries(target.containers)
    .map(([name, status]) => `| ${name} | ${status} |`)
    .join("\n");
  const exclusions = target.driver.exclusions?.length
    ? `\nExclusions: ${target.driver.exclusions.join(" ")}` : "";
  return [
    `### ${target.id}`,
    "",
    `- Status: **${target.status}**`,
    `- Database: ${[target.database.product, target.database.version, target.database.edition].filter(Boolean).join(" ") || "—"}`,
    `- Driver: ${[target.driver.id, target.driver.version && `@${target.driver.version}`, target.driver.profile].filter(Boolean).join(" ") || "—"}`,
    `- Runtime: ${[target.runtime.id, target.runtime.version && `@${target.runtime.version}`].filter(Boolean).join(" ") || "—"}`,
    `- Evidence: ${target.evidence?.status ?? "—"}${target.evidence?.commit ? ` (${target.evidence.commit})` : ""}`,
    `- Transport: ${target.driver.transport ?? "—"}; stream: ${target.driver.stream ?? "—"}; routine: ${target.driver.routine ?? "—"}; bulk: ${target.driver.bulk ?? "—"}${exclusions}`,
    "",
    "| Numeric contract | Representation | Fidelity | Profile |",
    "| --- | --- | --- | --- |",
    numericRows || "| — | — | — | — |",
    "",
    "| Container | Status |",
    "| --- | --- |",
    containerRows || "| — | — |",
    "",
    "| Capability | Claim |",
    "| --- | --- |",
    capabilityRows || "| — | — |",
  ].join("\n");
}

function supportMatrixMarkdown(id: string) {
  const locale = id.startsWith("ko/") ? "ko" : "en";
  const data = loadSupportMatrix();
  const conditionLabels = new Map(data.conditions.map((condition) => [condition.code, condition.labels[locale]]));
  const heading = locale === "ko" ? "### 정적 지원 매트릭스" : "### Static support matrix";
  return [heading, "", ...data.targets.map((target) => supportTargetMarkdown(target, conditionLabels))].join("\n\n");
}

function rewriteDestination(destination: string, base: string) {
  if (!destination.startsWith(projectRoot)) return destination;

  const rest = destination.slice(projectRoot.length);
  if (rest.startsWith("latest/") || rest.startsWith("v/")) return destination;

  const match = /^([^?#]*)([?#].*)?$/u.exec(rest);
  if (!match) return destination;
  const route = match[1].replace(/\/+$/u, "");
  const suffix = match[2] ?? "";

  if (!route) return `${base}/index.md${suffix}`;
  if (/\.[^/]+$/u.test(route)) return `${base}/${route}${suffix}`;
  return `${base}/${route}.md${suffix}`;
}

export function rewriteMarkdownDocLinks(source: string, base = docsBasePath()) {
  let fence: "```" | "~~~" | undefined;
  return source.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (!fence && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      return line;
    }
    if (fence && trimmed.startsWith(fence)) {
      fence = undefined;
      return line;
    }
    if (fence) return line;

    return line.replace(/(\]\()([^\s)]+)([^)]*\))/gu, (_match, open, destination, close) => {
      return `${open}${rewriteDestination(destination, base)}${close}`;
    });
  }).join("\n");
}

export function renderRawMarkdown(entry: CollectionEntry<"docs">, base = docsBasePath()) {
  const description = typeof entry.data.description === "string" && entry.data.description.trim()
    ? `\n> ${entry.data.description.trim()}\n`
    : "";
  let source = entry.body ?? "";
  if (entry.id === "interactive-preview" || entry.id === "ko/interactive-preview") {
    const renderedPreviewUrl = `https://clickin.github.io${base}/${entry.id}/`;
    source = source
      .replace(/^import InteractivePreview from "[^"]+";\n*/u, "")
      .replace("<InteractivePreview />", entry.id.startsWith("ko/")
        ? `문서 사이트에서 렌더링된 [인터랙티브 미리보기](${renderedPreviewUrl})를 사용할 수 있습니다.`
        : `The rendered [interactive preview](${renderedPreviewUrl}) is available on the documentation site.`);
  }
  if (entry.id === "reference/support" || entry.id === "ko/reference/support") {
    source = source
      .replace(/^import SupportMatrix from "[^"]+";\n*/u, "")
      .replace("<SupportMatrix />", supportMatrixMarkdown(entry.id));
  }
  const body = rewriteMarkdownDocLinks(source, base).trimStart();
  return `# ${entry.data.title}\n${description}\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}
