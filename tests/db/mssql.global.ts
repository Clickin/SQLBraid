import { GenericContainer, Wait } from "testcontainers";
import type { TestProject } from "vitest/node";

export const MSSQL_IMAGE = "mcr.microsoft.com/mssql/server:2022-CU18-ubuntu-22.04";
export const MSSQL_USER = "sa";
export const MSSQL_PASSWORD = "Sqlbraid_Test13!";
export const MSSQL_DATABASE = "master";

interface MssqlSettings {
  readonly connectionUri: string;
  readonly server: string;
  readonly port: number;
  readonly userName: string;
  readonly password: string;
  readonly database: string;
  readonly image: string;
  readonly version: string;
}

function fromEnvironment(): MssqlSettings | undefined {
  const uri = process.env.SQLBRAID_MSSQL_URL;
  if (uri) {
    const parsed = new URL(uri.includes("://") ? uri : `mssql://${uri}`);
    const server = parsed.hostname || "127.0.0.1";
    const port = Number(parsed.port || 1433);
    const userName = decodeURIComponent(parsed.username || MSSQL_USER);
    const password = decodeURIComponent(parsed.password || MSSQL_PASSWORD);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//u, "")) || MSSQL_DATABASE;
    return {
      connectionUri: uri,
      server,
      port,
      userName,
      password,
      database,
      image: process.env.SQLBRAID_MSSQL_IMAGE ?? "external",
      version: process.env.SQLBRAID_MSSQL_VERSION ?? "external",
    };
  }
  const server = process.env.SQLBRAID_MSSQL_SERVER;
  if (!server) return undefined;
  const port = Number(process.env.SQLBRAID_MSSQL_PORT ?? 1433);
  const userName = process.env.SQLBRAID_MSSQL_USER ?? MSSQL_USER;
  const password = process.env.SQLBRAID_MSSQL_PASSWORD ?? MSSQL_PASSWORD;
  const database = process.env.SQLBRAID_MSSQL_DATABASE ?? MSSQL_DATABASE;
  return {
    connectionUri: `mssql://${encodeURIComponent(userName)}:${encodeURIComponent(password)}@${server}:${port}/${database}`,
    server,
    port,
    userName,
    password,
    database,
    image: process.env.SQLBRAID_MSSQL_IMAGE ?? "external",
    version: process.env.SQLBRAID_MSSQL_VERSION ?? "external",
  };
}

export default async function setup(project: TestProject) {
  const external = fromEnvironment();
  if (external) {
    project.provide("mssql", external);
    console.info(`[db-mssql] external server=${external.server} port=${external.port} version=${external.version}`);
    return;
  }
  const container = await new GenericContainer(MSSQL_IMAGE)
    .withEnvironment({
      ACCEPT_EULA: "Y",
      MSSQL_SA_PASSWORD: MSSQL_PASSWORD,
      MSSQL_PID: "Developer",
    })
    .withExposedPorts(1433)
    .withWaitStrategy(Wait.forLogMessage("SQL Server is now ready for client connections."))
    .withStartupTimeout(180_000)
    .start();
  const server = container.getHost();
  const port = container.getMappedPort(1433);
  const settings: MssqlSettings = {
    connectionUri: `mssql://${MSSQL_USER}:${encodeURIComponent(MSSQL_PASSWORD)}@${server}:${port}/${MSSQL_DATABASE}`,
    server,
    port,
    userName: MSSQL_USER,
    password: MSSQL_PASSWORD,
    database: MSSQL_DATABASE,
    image: MSSQL_IMAGE,
    version: "2022-CU18",
  };
  project.provide("mssql", settings);
  console.info(`[db-mssql] image=${MSSQL_IMAGE} version=2022-CU18 server=${server} port=${port}`);
  return async () => { await container.stop(); };
}
