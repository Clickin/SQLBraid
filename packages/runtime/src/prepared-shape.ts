import type { QueryResultKind, RenderedStatement } from "@sqlbraid/core";

export function preparedShape(resultKind: QueryResultKind, rendered: RenderedStatement): string {
  return JSON.stringify({
    dialectId: rendered.dialectId,
    resultKind,
    segments: rendered.segments,
    variantFingerprint: rendered.variantFingerprint ?? null,
    parameters: rendered.parameters.map(({ hint, direction, outputName, interpolation }) => ({
      ...(interpolation === undefined ? {} : { interpolation }),
      hint:
        hint === undefined
          ? null
          : {
              databaseType: hint.databaseType,
              ...(hint.length === undefined ? {} : { length: hint.length }),
              ...(hint.precision === undefined ? {} : { precision: hint.precision }),
              ...(hint.scale === undefined ? {} : { scale: hint.scale }),
            },
      ...(direction === undefined ? {} : { direction }),
      ...(outputName === undefined ? {} : { outputName }),
    })),
    ...(rendered.routineProcedure === undefined ? {} : { routineProcedure: rendered.routineProcedure }),
  });
}
