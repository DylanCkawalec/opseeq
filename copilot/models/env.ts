// models/env.ts — Loads provider credentials from QGoT/.env and local .env.
// Single source of truth for keys & URLs across all adapters.
import { config as dotenvConfig } from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  // Local .env first (so it can override).
  const localEnv = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(localEnv)) dotenvConfig({ path: localEnv });

  // Then the upstream QGoT/.env if present.
  const qgotEnvPath = process.env.QGOT_ENV_PATH
    ? path.resolve(process.cwd(), process.env.QGOT_ENV_PATH)
    : path.resolve(process.cwd(), "../../QGoT/.env");
  if (fs.existsSync(qgotEnvPath)) {
    dotenvConfig({ path: qgotEnvPath, override: false });
  }
  loaded = true;
}

export function env(name: string, fallback = ""): string {
  loadEnv();
  return process.env[name] ?? fallback;
}

export function envRequired(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}
