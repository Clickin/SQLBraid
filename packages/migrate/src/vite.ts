import { relative, resolve, sep } from "node:path";
import type { Database } from "@sqlbraid/core";
import type { Plugin, ViteDevServer } from "vite";
import { createMigrator } from "./index.js";
import { generateManifestModule } from "./node.js";
import type { LoadMigrationsOptions } from "./node.js";
import type { MigrationManifest, MigrationReport, MigratorOptions, StartupOptions } from "./types.js";

const VIRTUAL_ID = "virtual:sqlbraid-migrations";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

export interface MigrationViteOptions extends LoadMigrationsOptions {
  readonly directory?: string;
  /** Development checks are explicit: the plugin does not create or own a database. */
  readonly dev?: {
    readonly db: Database;
    readonly migrator: Omit<MigratorOptions, "manifest">;
    readonly startup?: Omit<StartupOptions, "mode">;
  };
}

/** Server-only manifest generation and optional read-only development startup reporting. */
export default function migrations(options: MigrationViteOptions = {}): Plugin {
  let directory = resolve(options.directory ?? "migrations");
  let serverBuild = false;
  let server: ViteDevServer | undefined;
  let queue = Promise.resolve();
  let overlay: { message: string; stack: string; plugin: string } | undefined;

  async function report(): Promise<void> {
    if (!server || !options.dev) return;
    try {
      const module = (await server.ssrLoadModule(VIRTUAL_ID)) as { default: MigrationManifest };
      const migrator = createMigrator({ ...options.dev.migrator, manifest: module.default });
      const result: MigrationReport = await migrator.startup(options.dev.db, {
        ...options.dev.startup,
        mode: "report",
      });
      const message = `[sqlbraid-migrations] ${result.summary}`;
      server.config.logger.info(message);
      if (
        result.status !== "current" &&
        result.status !== "off" &&
        (result.status !== "ahead" || options.dev.startup?.ahead === "error")
      ) {
        const details = result.differences
          .map(
            (difference) => `${difference.kind}: ${difference.source ?? difference.path ?? difference.version ?? ""}`,
          )
          .join("\n");
        overlay = { message: `${message}${details ? `\n${details}` : ""}`, stack: "", plugin: "sqlbraid-migrations" };
        server.ws.send({ type: "error", err: overlay });
      } else {
        const hadOverlay = overlay !== undefined;
        overlay = undefined;
        if (hadOverlay) server.ws.send({ type: "full-reload" });
      }
    } catch (error) {
      const message = `[sqlbraid-migrations] ${error instanceof Error ? error.message : String(error)}`;
      server.config.logger.error(message);
      overlay = { message, stack: error instanceof Error ? (error.stack ?? "") : "", plugin: "sqlbraid-migrations" };
      server.ws.send({ type: "error", err: overlay });
    }
  }

  return {
    name: "sqlbraid-migrations",
    enforce: "pre",
    configResolved(config) {
      directory = resolve(config.root, options.directory ?? "migrations");
      serverBuild = Boolean(config.build.ssr);
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id, context) {
      if (id !== RESOLVED_ID) return null;
      if (!context?.ssr && !serverBuild)
        this.error(`${VIRTUAL_ID} is server-only; do not import migrations into a browser entry point.`);
      this.addWatchFile(directory);
      return generateManifestModule(directory, {
        dialects: options.dialects ?? (options.dev ? [options.dev.migrator.dialect.id] : undefined),
        compile: true,
      });
    },
    configureServer(devServer) {
      server = devServer;
      server.watcher.add(directory);
      const changed = (file: string): void => {
        const path = relative(directory, resolve(file));
        if (path === ".." || path.startsWith(`..${sep}`) || !/\.(?:sql|[cm]?[jt]sx?)$/u.test(path)) return;
        const module = devServer.moduleGraph.getModuleById(RESOLVED_ID);
        if (module) devServer.moduleGraph.invalidateModule(module);
        queue = queue.then(report);
      };
      server.watcher.on("add", changed).on("change", changed).on("unlink", changed);
      const connected = (): void => {
        if (overlay) devServer.ws.send({ type: "error", err: overlay });
      };
      server.ws.on("connection", connected);
      server.httpServer?.once("close", () => {
        devServer.watcher.off("add", changed).off("change", changed).off("unlink", changed);
        devServer.ws.off("connection", connected);
      });
      return async () => {
        queue = queue.then(report);
        await queue;
      };
    },
  };
}
