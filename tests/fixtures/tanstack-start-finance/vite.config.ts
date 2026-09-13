import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nitro } from "nitro/vite";
import sqlbraid from "@sqlbraid/vite";

export default defineConfig({
  plugins: [tanstackStart(), sqlbraid(), nitro(), react()],
});
