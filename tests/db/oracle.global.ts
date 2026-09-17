import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";
import { readSupportImage } from "./support-target.js";

const ORACLE_IMAGE = readSupportImage("oracle");
export const ORACLE_VERSION = "23.9";
const DEFAULT_USER = "sqlbraid";
const DEFAULT_PASSWORD = "SqlbraidTest13";
const DEFAULT_SERVICE = "FREEPDB1";

function overrideConnection(): string | undefined {
  return process.env.SQLBRAID_ORACLE_URL ?? process.env.SQLBRAID_ORACLE_CONNECTION_STRING ?? process.env.ORACLE_URL;
}

export default async function setup(project: TestProject) {
  const connectionUri = overrideConnection();
  const user = process.env.SQLBRAID_ORACLE_USER ?? DEFAULT_USER;
  const password = process.env.SQLBRAID_ORACLE_PASSWORD ?? DEFAULT_PASSWORD;
  if (connectionUri) {
    project.provide("oracle", {
      connectionUri,
      image: "external",
      version: process.env.SQLBRAID_ORACLE_VERSION ?? "external",
    });
    console.info("[db-oracle] external connection enabled");
    return async () => undefined;
  }
  const container = await new GenericContainer(ORACLE_IMAGE)
    .withEnvironment({ ORACLE_PASSWORD: password, APP_USER: user, APP_USER_PASSWORD: password })
    .withExposedPorts(1521)
    .withWaitStrategy(Wait.forLogMessage(/DATABASE IS READY TO USE/iu))
    .start();
  const port = container.getMappedPort(1521);
  project.provide("oracle", {
    connectionUri: `127.0.0.1:${port}/${DEFAULT_SERVICE}`,
    image: ORACLE_IMAGE,
    version: ORACLE_VERSION,
  });
  console.info(`[db-oracle] image=${ORACLE_IMAGE} version=${ORACLE_VERSION} service=${DEFAULT_SERVICE}`);
  return async () => {
    await container.stop();
  };
}
