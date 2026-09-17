#!/usr/bin/env node
import { resolve } from "node:path";
import { startStdioLanguageServer, type StdioLanguageServerOptions } from "./server.js";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configAssignment = args.find((argument) => argument.startsWith("--config="));
const configPath = configAssignment?.slice("--config=".length)
  || (configIndex >= 0 && typeof args[configIndex + 1] === "string" ? args[configIndex + 1] : undefined);
const options: StdioLanguageServerOptions = configPath === undefined ? {} : { configPath: resolve(configPath) };

startStdioLanguageServer(options);
