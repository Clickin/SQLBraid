export const QUALIFIED_IDENTITY_ENCODING = "escaped-qualified-v1" as const;

function escapeQualifiedPart(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(".", "\\.")
    .replaceAll(":", "\\:")
    .replaceAll("#", "\\#");
}

/**
 * Builds the canonical identity used by metadata producers for one or more
 * namespace-qualified database object segments.
 */
function encodeQualifiedIdentity(segments: readonly string[]): string {
  return segments.map(escapeQualifiedPart).join(".");
}

export function qualifiedIdentity(namespace: string, name: string, ...segments: readonly string[]): string {
  return encodeQualifiedIdentity([namespace, name, ...segments]);
}

export function qualifiedIdentitySegments(segments: readonly string[]): string {
  return encodeQualifiedIdentity(segments);
}

export function qualifiedIdentityWithSuffix(namespace: string, name: string, suffix: string): string {
  return `${qualifiedIdentity(namespace, name)}:${escapeQualifiedPart(suffix)}`;
}

export function qualifiedIdentitySegmentsWithSuffix(segments: readonly string[], suffix: string): string {
  return `${qualifiedIdentitySegments(segments)}:${escapeQualifiedPart(suffix)}`;
}

/**
 * Checks the escaped-qualified-v1 wire representation without interpreting
 * database names. Legacy unmarked identities are intentionally not checked.
 */
export function isQualifiedIdentity(value: string): boolean {
  if (!value) return false;
  let escaped = false;
  let suffix = false;
  let hasContent = false;
  let segmentCount = 1;
  for (const character of value) {
    if (escaped) {
      if (!"\\.:#".includes(character)) return false;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === ":") {
      if (suffix) return false;
      suffix = true;
      hasContent = false;
      continue;
    }
    if (character === "#") return false;
    if (character === ".") {
      if (suffix) return false;
      if (!hasContent) return false;
      hasContent = false;
      segmentCount += 1;
      continue;
    }
    hasContent = true;
  }
  return !escaped && hasContent && segmentCount >= 2;
}
