import { ResultExactnessError } from "@sqlbraid/core";
import type { PgJsonProfile, PgRepresentationProfile, PgTemporalProfile } from "../type-policy.js";
import type { PgParserProfile } from "../pg/types.js";

const defaultParserProfile: Required<Pick<PgParserProfile, "json" | "temporal">> = Object.freeze({
  json: "text",
  temporal: "text",
});

export function resolveParserProfile(
  options: PgParserProfile | undefined,
  descriptor?: PgRepresentationProfile,
): { readonly json: PgJsonProfile; readonly temporal: PgTemporalProfile } {
  const requestedJson = options?.json;
  const requestedTemporal = options?.temporal;
  if (descriptor && requestedJson !== undefined && requestedJson !== descriptor.json) {
    throw new ResultExactnessError(
      "PostgreSQL parserProfile JSON setting contradicts the selected representation profile.",
    );
  }
  if (descriptor && requestedTemporal !== undefined && requestedTemporal !== descriptor.temporal) {
    throw new ResultExactnessError(
      "PostgreSQL parserProfile temporal setting contradicts the selected representation profile.",
    );
  }
  const profile = {
    json: descriptor?.json ?? requestedJson ?? defaultParserProfile.json,
    temporal: descriptor?.temporal ?? requestedTemporal ?? defaultParserProfile.temporal,
  };
  if (profile.json !== "text" && profile.json !== "native")
    throw new RangeError(`Unsupported PostgreSQL JSON parser profile: ${String(profile.json)}`);
  if (profile.temporal !== "text" && profile.temporal !== "native")
    throw new RangeError(`Unsupported PostgreSQL temporal parser profile: ${String(profile.temporal)}`);
  return profile;
}
