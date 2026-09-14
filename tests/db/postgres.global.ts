import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { supportTarget } from "./support-target.js";

const POSTGRES_TARGET = supportTarget(process.env.SQLBRAID_POSTGRES_TARGET ?? "postgres");
const POSTGRES_VERSION = POSTGRES_TARGET.database.version;

export default async function setup(project: TestProject) {
  const image = POSTGRES_TARGET.reproducibility.image;
  if (!image) throw new Error("PostgreSQL support target has no reproducibility image.");
  const external = process.env.SQLBRAID_POSTGRES_URL;
  if (external) {
    const version = process.env.SQLBRAID_POSTGRES_VERSION ?? "external";
    project.provide("postgres", { connectionUri: external, image: "external", version });
    console.info(`[db-postgres] external version=${version}`);
    return;
  }
  const container = await new PostgreSqlContainer(image)
    .withDatabase("sqlbraid")
    .withUsername("sqlbraid")
    .withPassword("sqlbraid")
    .start();
  const connectionUri = container.getConnectionUri();
  project.provide("postgres", { connectionUri, image, version: POSTGRES_VERSION });
  console.info(`[db-postgres] image=${image} version=${POSTGRES_VERSION}`);
  return async () => { await container.stop(); };
}
