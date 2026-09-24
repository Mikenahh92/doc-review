/**
 * DR-9: persistent runtime settings (settings.json in the data root), UI-editable.
 * Effective value = saved override > env default. Air-gapped friendly: env-only
 * deployments work unchanged; the settings UI is a pure convenience layer.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeSettings {
  mode?: "faux" | "ollama" | "remote";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  concurrency?: number;
  maxAttempts?: number;
}

const NUM_KEYS: (keyof RuntimeSettings)[] = ["concurrency", "maxAttempts"];

export function defaultsFromEnv(): RuntimeSettings {
  const mode = (process.env.MODEL_MODE as RuntimeSettings["mode"]) ?? "faux";
  return {
    mode,
    model: process.env.MODEL_ID ?? "",
    baseUrl: process.env.MODEL_BASE_URL ?? "",
    concurrency: Math.max(1, Number(process.env.CONCURRENCY ?? 1)),
    maxAttempts: Math.max(1, Number(process.env.MAX_ATTEMPTS ?? 3)),
  };
}

export function readSettings(root: string): RuntimeSettings {
  const p = join(root, "settings.json");
  let saved: RuntimeSettings = {};
  if (existsSync(p)) {
    try { saved = JSON.parse(readFileSync(p, "utf8")); } catch { saved = {}; }
  }
  const out: RuntimeSettings = { ...defaultsFromEnv() };
  if (saved.mode === "faux" || saved.mode === "ollama" || saved.mode === "remote") out.mode = saved.mode;
  for (const k of ["model", "baseUrl", "apiKey"] as const) {
    const v = saved[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  for (const k of NUM_KEYS) {
    if (Number.isFinite(saved[k] as number)) (out as any)[k] = Math.max(0, Number(saved[k] as number));
  }
  return out;
}

export function writeSettings(root: string, patch: RuntimeSettings): RuntimeSettings {
  const prev = readSettings(root);
  const next: RuntimeSettings = { ...prev };
  if (patch.mode === "faux" || patch.mode === "ollama" || patch.mode === "remote") next.mode = patch.mode;
  for (const k of ["model", "baseUrl", "apiKey"] as const) {
    const v = patch[k];
    if (k === "apiKey" && (v === undefined || v === "")) { /* keep existing */ }
    else if (typeof v === "string" && v.trim() && !v.includes("•")) next[k] = v.trim();
  }
  for (const k of NUM_KEYS) {
    if (Number.isFinite(patch[k] as number)) (next as any)[k] = Math.max(0, Number(patch[k] as number));
  }
  writeFileSync(join(root, "settings.json"), JSON.stringify(next, null, 2));
  return next;
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 5)}••••${key.slice(-4)}`;
}
