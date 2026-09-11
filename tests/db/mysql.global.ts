import { MySqlContainer } from "@testcontainers/mysql";
import type { TestProject } from "vitest/node";

export const MYSQL_IMAGE = "mysql:8.4.2";

export default async function setup(project: TestProject) {
  const container = await new MySqlContainer(MYSQL_IMAGE)
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withUserPassword("sqlbraid")
    .withRootPassword("root-sqlbraid")
    .start();
  const connectionUri = container.getConnectionUri();
  project.provide("mysql", { connectionUri, image: MYSQL_IMAGE, version: "8.4.2" });
  console.info(`[db-mysql] image=${MYSQL_IMAGE} version=8.4.2 product=Oracle MySQL`);
  return async () => { await container.stop(); };
}
