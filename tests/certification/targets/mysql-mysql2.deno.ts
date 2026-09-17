import { loadDenoDriverVersion, runDenoCertification } from "../run-deno.ts";
import { createMysql2DenoTarget } from "./mysql-mysql2.ts";
import type { CertificationFixture } from "../types.ts";

declare const Deno: {
  readonly env: { get(name: string): string | undefined };
};

const connectionUri = Deno.env.get("SQLBRAID_MYSQL_URL");
if (!connectionUri) throw new Error("SQLBRAID_MYSQL_URL is required for MySQL Deno certification.");
const measuredDriverVersion = await loadDenoDriverVersion("mysql2");

await runDenoCertification({
  "mysql-mysql2-deno-2-9-3": async (sourceSha) => {
    const target = createMysql2DenoTarget(connectionUri, sourceSha, measuredDriverVersion);
    let active: CertificationFixture | undefined;
    const createFixture = target.createFixture;
    return {
      target: {
        ...target,
        createFixture: async () => {
          const fixture = await createFixture();
          active = fixture;
          return {
            ...fixture,
            close: async () => {
              if (active === fixture) active = undefined;
              await fixture.close?.();
            },
          };
        },
      },
      dispose: async () => {
        await active?.close?.();
      },
    };
  },
}, "mysql-mysql2-deno-2-9-3");
