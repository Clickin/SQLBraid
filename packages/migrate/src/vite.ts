import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "@sqlbraid/core";
import type { Plugin, ViteDevServer } from "vite";
import { createMigrator } from "./index.js";
import { generateManifestModule, type LoadMigrationsOptions } from "./sources.js";
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

function within(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Server-only manifest generation and optional read-only development startup reporting.
 * The SQL text goes into server chunks as string literals. It is never an emitted asset, and the
 * plugin refuses client imports and development-server requests for files in the migrations directory.
 */
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
      // Vite copies publicDir into the client output and serves it as-is.
      if (config.publicDir && within(resolve(config.publicDir), directory))
        throw new Error(
          `[sqlbraid-migrations] The migrations directory ${directory} is inside publicDir; move it out of ${config.publicDir}.`,
        );
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id, context) {
      // Vite environments name the consumer; the ssr flag is only a fallback for hosts without them.
      const serverSide = this.environment
        ? this.environment.config.consumer === "server"
        : Boolean(context?.ssr) || serverBuild;
      if (id !== RESOLVED_ID) {
        // Blocks client `?raw` and `?url` imports of migration files, in development and in client builds.
        const file = id.split("?", 1)[0]!;
        if (!serverSide && !file.startsWith("\0") && isAbsolute(file) && within(directory, resolve(file)))
          this.error(`Migration SQL is server-only; a client module cannot import ${relative(directory, file)}.`);
        return null;
      }
      if (!serverSide) this.error(`${VIRTUAL_ID} is server-only; do not import migrations into a browser entry point.`);
      this.addWatchFile(directory);
      return generateManifestModule(directory, {
        dialects: options.dialects ?? (options.dev ? [options.dev.migrator.dialect.id] : undefined),
      });
    },
    configureServer(devServer) {
      server = devServer;
      // Registered before Vite's own middlewares, so its static file serving never reaches migration files.
      devServer.middlewares.use((request, response, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(new URL(request.url ?? "/", "http://vite.invalid").pathname);
        } catch {
          next();
          return;
        }
        const base = devServer.config.base;
        if (base.startsWith("/") && pathname.startsWith(base)) pathname = `/${pathname.slice(base.length)}`;
        const file = pathname.startsWith("/@fs/")
          ? pathname.slice(4).replace(/^\/(?=[A-Za-z]:)/u, "")
          : resolve(devServer.config.root, `.${pathname}`);
        if (!within(directory, resolve(file))) {
          next();
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      server.watcher.add(directory);
      const changed = (file: string): void => {
        const path = relative(directory, resolve(file));
        // Any file can change the manifest: a misnamed script file must surface its loader error too.
        if (path === ".." || path.startsWith(`..${sep}`)) return;
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
