import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";
import { readSupportImage } from "./support-target.js";

const MARIADB_IMAGE = readSupportImage("mariadb");
export const MARIADB_VERSION = "11.8.9";
const DEFAULT_USER = "sqlbraid";
const DEFAULT_PASSWORD = "sqlbraid";
const DEFAULT_DATABASE = "sqlbraid";

function overrideConnection(): string | undefined {
  return process.env.SQLBRAID_MARIADB_URL ?? process.env.MARIADB_URL;
}

export default async function setup(project: TestProject) {
  const connectionUri = overrideConnection();
  if (connectionUri) {
    project.provide("mariadb", {
      connectionUri,
      image: "external",
      version: process.env.SQLBRAID_MARIADB_VERSION ?? "external",
    });
    console.info("[db-mariadb] external connection enabled");
    return async () => undefined;
  }

  const container = await new GenericContainer(MARIADB_IMAGE)
    .withEnvironment({
      MARIADB_DATABASE: DEFAULT_DATABASE,
      MARIADB_USER: DEFAULT_USER,
      MARIADB_PASSWORD: DEFAULT_PASSWORD,
      MARIADB_ROOT_PASSWORD: "root-sqlbraid",
    })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forSuccessfulCommand("healthcheck.sh --connect --innodb_initialized"))
    .start();
  const port = container.getMappedPort(3306);
  const uri = `mariadb://${DEFAULT_USER}:${DEFAULT_PASSWORD}@127.0.0.1:${port}/${DEFAULT_DATABASE}`;
  project.provide("mariadb", { connectionUri: uri, image: MARIADB_IMAGE, version: MARIADB_VERSION });
  console.info(`[db-mariadb] image=${MARIADB_IMAGE} version=${MARIADB_VERSION}`);
  return async () => {
    await container.stop();
  };
}
