import {
  diffSnapshots,
  hashSnapshot,
  validateSnapshot,
  type MetadataInspector,
  type MetadataSnapshot,
} from "@sqlbraid/metadata";
import type { MigrationDrift } from "./types.js";

/** Optional catalog inspection. The caller owns the inspector and its connection. */
export function createSchemaDrift(options: {
  readonly inspector: MetadataInspector;
  readonly snapshot?: MetadataSnapshot;
}): MigrationDrift {
  const { inspector, snapshot: expected } = options;
  if (expected) {
    validateSnapshot(expected);
    if (expected.dialect !== inspector.dialect) {
      throw new TypeError("Migration snapshot and inspector must use the same dialect.");
    }
  }
  return {
    dialect: inspector.dialect,
    async inspect() {
      const snapshot = await inspector.inspect();
      validateSnapshot(snapshot);
      if (snapshot.dialect !== inspector.dialect) {
        throw new TypeError("Migration inspector returned a different dialect.");
      }
      return {
        hash: hashSnapshot(snapshot),
        snapshot,
        differences: expected ? diffSnapshots(expected, snapshot).map((difference) => difference.path) : [],
      };
    },
  };
}
