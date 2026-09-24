// HTTP API + UI. The backend owns everything; agent sessions are spawned per task.
// DR-9: runtime settings (settings.json) editable via /api/settings — model, base URL,
// API key, parallel tasks, attempts. Env vars remain the air-gapped-friendly defaults.

import express from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store.js";
import { buildRun } from "./prepass/index.js";
import { executeRun } from "./orchestrator.js";
import { reportHtml, rollupVerdict } from "./report.js";
import { readSettings, writeSettings, maskKey } from "./settings.js";
import type { RuntimeConfig } from "./agent/runtime.js";

const ROOT = process.cwd();
const RUNS_DIR = process.env.RUNS_DIR ?? path.join(ROOT, "runs");
const UPLOADS = path.join(ROOT, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

const store = new Store(RUNS_DIR);
const recovered = store.load();
if (recovered) console.log(`boot: ${recovered} persisted run(s) reloaded`);

const app = express();
app.use(express.json({ limit: "128mb" }));

/** Effective agent runtime config = env defaults overlaid by saved settings. */
function effectiveConfig(): RuntimeConfig {
  const s = readSettings(ROOT);
  return {
    mode: s.mode ?? "faux",
    modelId: s.model || undefined,
    baseUrl: s.baseUrl || undefined,
    apiKey: s.apiKey || undefined,
    concurrency: s.concurrency ?? 1,
    maxAttempts: s.maxAttempts ?? 3,
  };
}

// ---- UI ----
app.get("/", (_req, res) => {
  res.type("html").send(fs.readFileSync(path.join(ROOT, "src", "server", "ui", "index.html")));
});

// ---- settings (DR-9) ----
app.get("/api/config", (_req, res) => {
  const s = readSettings(ROOT);
  res.json({
    mode: s.mode ?? "faux",
    model: s.model ?? "",
    baseUrl: (s.baseUrl ?? "").replace(/\/\/[^@]*@/, "//"),
    concurrency: Math.max(1, s.concurrency ?? 1),
    maxAttempts: s.maxAttempts ?? 3,
    settingsCustomized: fs.existsSync(path.join(ROOT, "settings.json")),
  });
});

app.get("/api/settings", (_req, res) => {
  const s = readSettings(ROOT);
  const { apiKey, ...rest } = s;
  res.json({ ...rest, hasApiKey: !!apiKey, apiKeyMasked: maskKey(apiKey) });
});

app.put("/api/settings", (req, res) => {
  const b = req.body ?? {};
  const patch: any = {};
  if (b.mode === "faux" || b.mode === "ollama" || b.mode === "remote") patch.mode = b.mode;
  for (const k of ["model", "baseUrl"]) if (typeof b[k] === "string") patch[k] = b[k];
  if (typeof b.apiKey === "string" && b.apiKey && !b.apiKey.includes("•")) patch.apiKey = b.apiKey;
  for (const k of ["concurrency", "maxAttempts"])
    if (b[k] !== undefined && Number.isFinite(Number(b[k]))) patch[k] = Number(b[k]);
  const s = writeSettings(ROOT, patch);
  const { apiKey, ...rest } = s;
  res.json({ ...rest, hasApiKey: !!apiKey, apiKeyMasked: maskKey(apiKey) });
});

app.get("/api/settings/models", async (_req, res) => {
  const s = readSettings(ROOT);
  const base = (s.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) return res.status(400).json({ error: "no baseUrl configured" });
  try {
    const key = s.apiKey || process.env.MODEL_API_KEY || "";
    const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!r.ok) return res.status(502).json({ error: `provider ${r.status}` });
    const j: any = await r.json();
    const ids: string[] = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name ?? m).filter((x: any) => typeof x === "string");
    res.json({ models: ids.sort() });
  } catch (e: any) {
    res.status(502).json({ error: String(e.message ?? e) });
  }
});

// ---- runs ----
app.post("/api/runs", async (req, res) => {
  const b = req.body ?? {};
  const dec = (f: any, fallbackName: string): string => {
    if (!f?.contentB64) throw new Error(`${fallbackName}: contentB64 required`);
    const name = typeof f.filename === "string" && /^[\w.\- ]+$/.test(f.filename) ? f.filename : fallbackName;
    const p = path.join(UPLOADS, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${name}`);
    fs.writeFileSync(p, Buffer.from(f.contentB64, "base64"));
    return p;
  };
  try {
    const beforePath = dec(b.before, "before.docx");
    const afterPath = dec(b.after, "after.docx");
    const registerPath = dec(b.register, "comments.xlsx");
    const { run, warnings } = await buildRun(
      fs.readFileSync(beforePath),
      fs.readFileSync(afterPath),
      fs.readFileSync(registerPath),
      {
        before: path.basename(beforePath),
        after: path.basename(afterPath),
        register: path.basename(registerPath),
      }
    );
    store.save(run);
    executeRun(store, run, effectiveConfig()); // fire and forget; poll via GET
    res.json({ runId: run.runId, warnings });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(
    store.list().map((r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      status: r.status,
      verdict: r.verdict ?? rollupVerdictSafe(r),
      comments: r.summary.commentCount,
      tasksDone: `${r.tasks.filter((t) => t.status === "done").length}/${r.tasks.length}`,
    }))
  );
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  res.json({
    runId: run.runId,
    createdAt: run.createdAt,
    status: run.status,
    verdict: run.verdict ?? rollupVerdictSafe(run),
    summary: run.summary,
    autoChecks: run.autoChecks,
    completionSummary: run.completionSummary ?? null,
    tasks: run.tasks.map((t) => ({
      id: t.taskId,
      type: t.type,
      title: t.title,
      status: t.status,
      scope: t.commentNumbers,
      results: t.results,
      findings: t.findings,
      note: t.note ?? null,
    })),
  });
});

app.get("/api/runs/:id/report.html", (req, res) => {
  const run = store.get(req.params.id);
  if (!run) return res.status(404).send("unknown run");
  res.type("html").send(reportHtml(run));
});


// ---- comment detail (wireframe screen 3): register row + anchor + before/after excerpts ----
app.get("/api/runs/:id/comments/:num", (req, res) => {
  const run = store.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  const num = parseInt(req.params.num, 10);
  const comment = run.comments.find((c) => c.number === num);
  if (!comment) return res.status(404).json({ error: "unknown comment" });
  const anchor = run.anchors.find((a) => a.commentNumber === num);
  const ai = anchor?.anchorIndex ?? null;
  const hunks = run.diff
    .filter((h) => (ai !== null && h.beforeIndex !== undefined ? Math.abs(h.beforeIndex - ai) <= 1 : false))
    .map((h) => ({ id: h.id, kind: h.kind, beforeText: h.beforeText ?? "", afterText: h.afterText ?? "" }));
  const beforeText = ai !== null ? run.before.blocks[ai]?.text ?? "" : "";
  // best-effort counterpart block: nearest hunk's afterIndex, else same index
  let afterIndex: number | null = null;
  const near = hunks[0];
  if (near) {
    const h = run.diff.find((x) => x.id === near.id);
    afterIndex = h?.afterIndex ?? null;
  }
  const afterText =
    afterIndex !== null
      ? run.after.blocks[afterIndex]?.text ?? ""
      : ai !== null
        ? run.after.blocks[ai]?.text ?? ""
        : "";
  res.json({
    comment,
    anchor: anchor ? { index: ai, method: anchor.method } : null,
    hunks,
    beforeText,
    afterText,
    result: run.tasks.flatMap((t) => t.results).find((r) => r.commentNumber === num) ?? null,
  });
});

// ---- export (wireframe screen 5) ----
app.get("/api/runs/:id/export.json", (req, res) => {
  const run = store.get(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown run" });
  res.setHeader("Content-Disposition", `attachment; filename="${run.runId}-report.json"`);
  const { before, after, ...rest } = run;
  res.json({ ...rest, documents: { before: before.fileName, after: after.fileName } });
});

app.get("/api/runs/:id/transcript/:taskId", (req, res) => {
  const p = store.transcriptPath(req.params.id, req.params.taskId);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "no transcript" });
  res.type("text/plain").send(fs.readFileSync(p, "utf8"));
});

function rollupVerdictSafe(run: NonNullable<ReturnType<Store["get"]>>): string | null {
  try {
    return rollupVerdict(run as any);
  } catch {
    return null;
  }
}

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  const c = effectiveConfig();
  console.log(`ReWork check backend on http://localhost:${port} (model mode: ${c.mode}${c.modelId ? ` ${c.modelId}` : ""}, concurrency: ${c.concurrency})`);
});
