import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

export const POSTGRES_IMAGE = "postgres:16.4-alpine";

export default async function setup(project: TestProject) {
  const external = process.env.SQLBRAID_POSTGRES_URL;
  if (external) {
    const version = process.env.SQLBRAID_POSTGRES_VERSION ?? "external";
    project.provide("postgres", { connectionUri: external, image: "external", version });
    console.info(`[db-postgres] external version=${version}`);
    return;
  }
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withPassword("sqlbraid")
    .start();
  const connectionUri = container.getConnectionUri();
  project.provide("postgres", { connectionUri, image: POSTGRES_IMAGE, version: "16.4" });
  console.info(`[db-postgres] image=${POSTGRES_IMAGE} version=16.4`);
  return async () => { await container.stop(); };
}
