import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("every facade export has an API audit classification", () => {
  const manifest = JSON.parse(readFileSync(new URL("../packages/sqlbraid/package.json", import.meta.url), "utf8"));
  const audit = readFileSync(new URL("../docs/public-api-audit.md", import.meta.url), "utf8");
  const blocks = [
    ...audit.matchAll(
      /<!-- sqlbraid-facade-exports -->\s*```json\n([\s\S]*?)\n```\s*<!-- \/sqlbraid-facade-exports -->/gu,
    ),
  ];
  assert.equal(blocks.length, 1, "The API audit must contain one marked facade export inventory.");
  const inventory: Record<string, unknown> = JSON.parse(blocks[0]![1]!);
  assert.deepEqual(
    // oxlint-disable-next-line no-array-sort -- Object.keys returns an owned comparison array.
    Object.keys(inventory).sort(),
    // oxlint-disable-next-line no-array-sort -- Sorting these temporary keys cannot mutate package exports.
    Object.keys(manifest.exports).sort(),
    "Update the facade API audit whenever package exports change.",
  );
  for (const [subpath, classification] of Object.entries(inventory)) {
    assert.ok(
      classification === "Application" || classification === "SPI" || classification === "Advanced",
      `${subpath} requires an Application, SPI, or Advanced classification.`,
    );
  }
});
