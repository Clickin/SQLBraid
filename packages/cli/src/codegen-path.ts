export function codegenOutputCollisionKey(outputPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? outputPath.toLowerCase() : outputPath;
}
