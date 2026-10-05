import assert from "node:assert/strict";
import { test } from "vitest";
import { formatReleaseError } from "../scripts/release-diagnostics.mjs";

test("release diagnostics retain nested causes and subprocess evidence", () => {
  const command = Object.assign(new Error("npm stage publish failed"), {
    code: "E403",
    signal: "SIGTERM",
    stdout: Buffer.from('{"@sqlbraid/mariadb":{"status":403}}'),
    stderr: "npm error E403 Forbidden: @sqlbraid/mariadb HTTP 403",
  });
  const error = new Error("Staging outcome unresolved for @sqlbraid/mariadb", {
    cause: new Error("Upload failed", { cause: command }),
  });
  const text = formatReleaseError(error, {});
  for (const evidence of [
    "Staging outcome unresolved",
    "Upload failed",
    "npm stage publish failed",
    "E403",
    "SIGTERM",
    "stdout:",
    "stderr:",
    "@sqlbraid/mariadb",
    "HTTP 403",
  ])
    assert.ok(text.includes(evidence), evidence);
  assert.equal(text.match(/Caused by:/gu)?.length, 2);
});

test("release diagnostics include parse failures and captured invalid output", () => {
  let cause: unknown;
  try {
    JSON.parse("not JSON: npm registry HTTP 502");
  } catch (error) {
    cause = error;
  }
  const error = Object.assign(new Error("Invalid stage response for @sqlbraid/core", { cause }), {
    stdout: "not JSON: npm registry HTTP 502",
  });
  const text = formatReleaseError(error, {});
  assert.match(text, /SyntaxError/u);
  assert.match(text, /Invalid stage response for @sqlbraid\/core/u);
  assert.match(text, /not JSON: npm registry HTTP 502/u);
});

test("release diagnostics redact environment credentials and their common encodings", () => {
  const env = {
    NPM_TOKEN: "npm-fixture+/secret",
    NODE_AUTH_TOKEN: "node-fixture-secret",
    GITHUB_TOKEN: "github-fixture-secret",
    GH_TOKEN: "gh-fixture-secret",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-fixture-secret",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request?audience=npm&opaque=private",
    PUBLIC_PACKAGE: "@sqlbraid/core",
    UNUSED_PASSWORD: "never-print-the-env",
  };
  const secrets = Object.entries(env)
    .filter(([key]) => key !== "PUBLIC_PACKAGE" && key !== "UNUSED_PASSWORD")
    .flatMap(([, value]) => [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
    ]);
  const text = formatReleaseError(new Error(`${secrets.join("\n")} @sqlbraid/core HTTP 401`), env);
  for (const secret of secrets) assert.ok(!text.includes(secret), "Credential must be absent");
  assert.ok(!text.includes(env.UNUSED_PASSWORD));
  assert.match(text, /@sqlbraid\/core HTTP 401/u);
  assert.match(text, /\[REDACTED\]/u);
});

test("release diagnostics redact authorization, assignments and URL credentials without environment values", () => {
  const credentials = [
    ["Authorization: Bearer bearer-fixture", "bearer-fixture"],
    ["authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['{"password":"quoted secret", "api_key":"key-fixture"}', "quoted secret", "key-fixture"],
    [
      "NPM_TOKEN=assignment-fixture _auth=auth-fixture --password=cli-fixture",
      "assignment-fixture",
      "auth-fixture",
      "cli-fixture",
    ],
    [
      "https://user-fixture:password-fixture@registry.npmjs.org/@sqlbraid/core?token=query-fixture&status=403",
      "user-fixture",
      "password-fixture",
      "query-fixture",
    ],
    [
      "https://registry.npmjs.org/?%74oken=encoded-key-fixture&X-Amz-Signature=signature-fixture",
      "encoded-key-fixture",
      "signature-fixture",
    ],
    [
      "npm_0123456789abcdefghijklmnopqrstuv ghp_0123456789abcdefghijklmnopqrstuv",
      "npm_0123456789abcdefghijklmnopqrstuv",
      "ghp_0123456789abcdefghijklmnopqrstuv",
    ],
  ];
  for (const [message, ...secrets] of credentials) {
    const text = formatReleaseError(new Error(message), {});
    for (const secret of secrets) assert.ok(!text.includes(secret), "Credential must be absent");
  }
  const text = formatReleaseError(new Error(credentials[4]![0]), {});
  assert.match(text, /@sqlbraid\/core/u);
  assert.match(text, /status=403/u);
});

test("release diagnostics bound cyclic errors and escape untrusted control characters", () => {
  const error = Object.assign(new Error("npm\n::error::injected\r\u001b[31m"), {
    code: 1,
    stdout: "x".repeat(100_000),
    stderr: "y".repeat(100_000),
  });
  error.cause = error;
  const text = formatReleaseError(error, {});
  assert.ok(text.length <= 16_384);
  assert.match(text, /\[truncated\]/u);
  assert.match(text, /\[circular cause\]/u);
  assert.match(text, /code: 1/u);
  assert.ok(!text.includes("\n::error::"));
  assert.ok(!text.includes("\r"));
  assert.ok(!text.includes("\u001b"));
  assert.match(text, /\\n::error::/u);
  assert.match(formatReleaseError("plain thrown value", {}), /plain thrown value/u);
  assert.match(formatReleaseError(null, {}), /null/u);
});

test("release diagnostics bound deep causes and tolerate inaccessible properties", () => {
  let error = new Error("original");
  for (let index = 0; index < 100; index++) error = new Error(`wrapper ${index}`, { cause: error });
  assert.match(formatReleaseError(error, {}), /\[cause chain truncated\]/u);
  assert.doesNotThrow(() =>
    formatReleaseError(
      Object.defineProperty({}, "message", {
        get() {
          throw new Error("unreadable property");
        },
      }),
      {},
    ),
  );
});
