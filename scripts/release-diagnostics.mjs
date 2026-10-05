const REDACTED = "[REDACTED]";
const SECRET_KEY =
  /token|secret|password|passwd|credential|authorization|(?:^|[_-])(?:auth|key|sig)(?:$|[_-])|api[_-]?key|private[_-]?key|signature/iu;
const ASSIGNMENT =
  /(^|[^\w.-])([\w.-]+)(["']?\s*[:=]\s*)(\[REDACTED\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]"']+)/gmu;

function bounded(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 15)}... [truncated]` : text;
}

function property(value, key) {
  try {
    return value?.[key];
  } catch {
    return "[unreadable property]";
  }
}

/** Format only diagnostic fields; never serialize an error's environment or request objects. */
export function formatReleaseError(error, env = process.env) {
  const secrets = [
    ...new Set(
      Object.entries(env)
        .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === "string" && value.length > 0)
        .flatMap(([, value]) => [
          value,
          encodeURIComponent(value),
          Buffer.from(value).toString("base64"),
          Buffer.from(value).toString("base64url"),
        ]),
    ),
  ].toSorted((left, right) => right.length - left.length);

  function text(value) {
    if (Buffer.isBuffer(value)) value = value.toString("utf8");
    if (typeof value !== "string") {
      return value === null || ["number", "boolean", "bigint", "undefined"].includes(typeof value)
        ? String(value)
        : "[non-text value]";
    }
    // Redact before truncation so a credential crossing the limit cannot leak a prefix.
    for (const secret of secrets) value = value.replaceAll(secret, REDACTED);
    value = value
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"';]+/giu, (match) => `${match.split(/\s/u)[0]} ${REDACTED}`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/giu, `$1${REDACTED}@`)
      .replace(/([?&])([^=\s&#]+)=([^&#\s]*)/gu, (match, separator, key) => {
        try {
          return SECRET_KEY.test(decodeURIComponent(key)) ? `${separator}${key}=${REDACTED}` : match;
        } catch {
          return `${separator}${key}=${REDACTED}`;
        }
      })
      .replace(ASSIGNMENT, (match, prefix, key, separator) =>
        SECRET_KEY.test(key) ? `${prefix}${key}${separator}${REDACTED}` : match,
      )
      .replace(/\b(?:npm_[a-zA-Z0-9]+|gh[pousr]_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+)\b/gu, REDACTED);
    // JSON quoting keeps subprocess newlines and terminal controls from injecting log records.
    return JSON.stringify(bounded(value, 2048)).replace(
      /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }

  const lines = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) {
      lines.push("Caused by: [circular cause]");
      break;
    }
    seen.add(current);
    const prefix = depth === 0 ? "Error:" : "Caused by:";
    const message = property(current, "message");
    lines.push(`${prefix} ${text(message ?? current)}`);
    for (const key of ["name", "code", "signal", "status", "statusCode", "stdout", "stderr"]) {
      const value = property(current, key);
      if (value !== undefined && value !== null && value !== "") lines.push(`  ${key}: ${text(value)}`);
    }
    current = property(current, "cause");
    if (current === undefined || current === null) break;
    if (depth === 7) lines.push("Caused by: [cause chain truncated]");
  }
  return bounded(lines.join("\n"), 16_384);
}
