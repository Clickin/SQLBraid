#!/usr/bin/env node
import { startStdioLanguageServer } from "./server.js";

startStdioLanguageServer({ moduleSpecifier: "@sqlbraid/template" });
