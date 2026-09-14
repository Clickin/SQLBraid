import { readFileSync } from "node:fs";

export interface SupportTarget {
  readonly database: {
    readonly version: string;
  };
  readonly reproducibility: {
    readonly image?: string;
  };
}

export function supportTarget(targetId: string): SupportTarget {
  const targetUrl = new URL(`../../support/targets/${targetId}.json`, import.meta.url);
  return JSON.parse(readFileSync(targetUrl, "utf8")) as SupportTarget;
}

export function readSupportImage(targetId: string): string {
  const image = supportTarget(targetId).reproducibility.image;
  if (!image) throw new Error(`Support target ${targetId} has no reproducibility image.`);
  return image;
}
