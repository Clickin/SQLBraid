import { createHash } from "node:crypto";
import {
  SQL_FRAGMENT,
  isBoundParameter,
  type Query,
  type QueryResultKind,
  type TemplateIr,
  type TemplateNode,
} from "@sqlbraid/core";

export interface QueryManifest {
  readonly fingerprint: string;
  readonly templateFamilyFingerprint: string;
  readonly variantFingerprint?: string;
  readonly resultKind: QueryResultKind;
  readonly source?: string;
  readonly resultType?: string;
}

export interface QueryManifestEvidence {
  readonly fingerprint: string;
  readonly templateFamilyFingerprint: string;
  readonly variantFingerprint?: string;
  readonly resultKind: QueryResultKind;
  readonly source?: string;
  readonly resultType?: string;
}

interface FragmentLike {
  readonly [SQL_FRAGMENT]: true;
  readonly ir: TemplateIr;
  readonly values: readonly unknown[];
  readonly dialectId: string;
}

function isFragmentLike(value: unknown): value is FragmentLike {
  if (!value || typeof value !== "object") return false;
  if (!(SQL_FRAGMENT in value) || !("ir" in value) || !("dialectId" in value)) return false;
  if (!("values" in value)) return false;
  const marker = value[SQL_FRAGMENT];
  const ir = value.ir;
  const values = value.values;
  const dialectId = value.dialectId;
  return (
    marker === true && Boolean(ir && typeof ir === "object") && Array.isArray(values) && typeof dialectId === "string"
  );
}

function parameterHint(value: unknown): string {
  if (!isBoundParameter(value)) return "";
  const { databaseType, length, precision, scale } = value.hint;
  return JSON.stringify([databaseType, length ?? null, precision ?? null, scale ?? null]);
}

function canonicalNode(node: TemplateNode, values: readonly unknown[]): string {
  if (node.kind === "text") return `text:${JSON.stringify(node.text)}`;
  if (node.kind === "bind") {
    const value = values[node.interpolation];
    return isFragmentLike(value)
      ? `structural:${canonicalIr(value.ir, value.values)}`
      : `bind:${node.interpolation}${parameterHint(value)}`;
  }
  if (node.kind === "fragment") return `fragment:${valueFragment(node.fragment)}`;
  if (node.kind === "identifier") return `identifier:${JSON.stringify(node.value)}`;
  if (node.kind === "raw") return `raw:${JSON.stringify(node.text)}`;
  if (node.kind === "list") {
    const hints = node.values.map(parameterHint);
    return `list:${node.values.length}${hints.some(Boolean) ? JSON.stringify(hints) : ""}`;
  }
  if (node.kind === "if")
    return `if:${node.condition}[${node.children.map((child) => canonicalNode(child, values)).join(",")}]`;
  if (node.kind === "choose")
    return `choose:${node.whens.map((when) => `${when.condition}[${when.children.map((child) => canonicalNode(child, values)).join(",")}]`).join("|")}|${node.otherwise?.map((child) => canonicalNode(child, values)).join(",") ?? ""}`;
  return `trim:${JSON.stringify(node.attributes)}[${node.children.map((child) => canonicalNode(child, values)).join(",")}]`;
}

function canonicalIr(ir: TemplateIr, values: readonly unknown[] = []): string {
  return `ir:${ir.version}:${ir.nodes.map((node) => canonicalNode(node, values)).join(";")}`;
}

function valueFragment(fragment: FragmentLike): string {
  return `${fragment.dialectId}:${canonicalIr(fragment.ir, fragment.values)}`;
}

export function templateFamilyFingerprint(query: Query<unknown, QueryResultKind>): string {
  return createHash("sha256").update(canonicalIr(query.ir)).digest("hex");
}

export function templateFamilyFingerprintOf(ir: TemplateIr): string {
  return createHash("sha256").update(canonicalIr(ir)).digest("hex");
}

export function fingerprintQuery(query: Query<unknown, QueryResultKind>): string {
  return createHash("sha256").update(canonicalIr(query.ir, query.values)).digest("hex");
}

export function fingerprintTemplate(ir: TemplateIr, values: readonly unknown[]): string {
  return createHash("sha256").update(canonicalIr(ir, values)).digest("hex");
}

function portableSource(source: string | undefined): string | undefined {
  if (!source || source.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(source)) return undefined;
  return source;
}

export function createManifest(
  query: Query<unknown, QueryResultKind>,
  options: { readonly source?: string; readonly resultType?: string } = {},
): QueryManifest {
  const rendered = query.render();
  return {
    fingerprint: fingerprintQuery(query),
    templateFamilyFingerprint: templateFamilyFingerprint(query),
    ...(rendered.variantFingerprint ? { variantFingerprint: rendered.variantFingerprint } : {}),
    resultKind: query.resultKind,
    ...(portableSource(options.source) ? { source: portableSource(options.source) } : {}),
    ...(options.resultType ? { resultType: options.resultType } : {}),
  };
}

export function createManifestFromEvidence(evidence: QueryManifestEvidence): QueryManifest {
  return {
    fingerprint: evidence.fingerprint,
    templateFamilyFingerprint: evidence.templateFamilyFingerprint,
    ...(evidence.variantFingerprint ? { variantFingerprint: evidence.variantFingerprint } : {}),
    resultKind: evidence.resultKind,
    ...(portableSource(evidence.source) ? { source: portableSource(evidence.source) } : {}),
    ...(evidence.resultType ? { resultType: evidence.resultType } : {}),
  };
}
