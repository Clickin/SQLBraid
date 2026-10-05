import { describe, expect, it } from "vitest";
import { createSchemaDrift } from "@sqlbraid/migrate/drift";
import { hashSnapshot, type MetadataSnapshot } from "@sqlbraid/metadata";

const snapshot: MetadataSnapshot = {
  format: "sqlbraid-metadata",
  formatVersion: 1,
  dialect: "sqlite",
  dialectVersion: "3",
  server: {},
  namespaces: {},
  types: {},
  routines: {},
  relations: {
    users: {
      identity: "users",
      name: "users",
      kind: "table",
      columns: [{ name: "id", ordinal: 0, type: "INTEGER", nullable: false }],
    },
  },
  metadata: {},
};

describe("migration catalog drift", () => {
  it("reports changed paths and ignores volatile inspection timestamps", async () => {
    let current = { ...snapshot, metadata: { generatedAt: "2026-10-05T00:00:00Z" } };
    const drift = createSchemaDrift({
      inspector: { dialect: "sqlite", inspect: async () => current },
      snapshot,
    });
    expect(await drift.inspect()).toEqual({
      snapshot: current,
      hash: hashSnapshot(snapshot),
      differences: [],
    });
    current = {
      ...current,
      relations: {
        users: {
          ...snapshot.relations.users!,
          columns: [{ name: "id", ordinal: 0, type: "TEXT", nullable: false }],
        },
      },
    };
    const result = await drift.inspect();
    expect(result.hash).not.toBe(hashSnapshot(snapshot));
    expect(result.differences).toEqual(["relations.users.columns[0].type"]);
  });

  it("rejects catalog evidence from a different dialect", async () => {
    expect(() =>
      createSchemaDrift({
        inspector: { dialect: "postgres", inspect: async () => snapshot },
        snapshot,
      }),
    ).toThrow("same dialect");
    const drift = createSchemaDrift({ inspector: { dialect: "postgres", inspect: async () => snapshot } });
    await expect(drift.inspect()).rejects.toThrow("different dialect");
  });
});
