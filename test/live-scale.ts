// Live scale test (DR-28): run the FULL loop against a REAL model on the
// ~100-page / 60-comment scale fixtures and grade every comment against the
// known-answer ledger. Exercises: anchor cascade (section / content / diff /
// LLM resolver / unresolvable), deterministic split (6 tasks), verifier
// sessions with a real LLM, guarded completion, deterministic rollup.
//
// Usage:
//   MODEL_MODE=remote MODEL_BASE_URL=... MODEL_ID=glm-5.3-flash MODEL_API_KEY=... \
//   CONCURRENCY=3 node dist/test/live-scale.js
//
// Grading: strict for groups A–F (deterministic anchors, exact verdict),
// tolerant for G (LLM-anchored: expected verdict OR needs_user) and H
// (nonsense: needs_user).

import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { buildRun } from "../src/prepass/index.js";
import { executeRun } from "../src/orchestrator.js";
import type { RuntimeConfig } from "../src/agent/runtime.js";

const FIX = path.join(process.cwd(), "test", "fixtures-scale");
const RUNS = path.join(process.cwd(), "runs-scale");
fs.mkdirSync(RUNS, { recursive: true });

const config: RuntimeConfig = {
  mode: (process.env.MODEL_MODE as any) ?? "remote",
  modelId: process.env.MODEL_ID ?? "",
  baseUrl: process.env.MODEL_BASE_URL ?? "",
  apiKey: process.env.MODEL_API_KEY ?? "",
  concurrency: Math.max(1, Number(process.env.CONCURRENCY ?? 3)),
  maxAttempts: Math.max(1, Number(process.env.MAX_ATTEMPTS ?? 2)),
};

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main() {
  const t0 = Date.now();
  const ledger = JSON.parse(fs.readFileSync(path.join(FIX, "ledger.json"), "utf8"));
  log(`config: mode=${config.mode} model=${config.modelId || "(default)"} baseUrl=${(config.baseUrl || "(default)").replace(/\/api.*$/, "/…")} concurrency=${config.concurrency}`);

  // ---- pre-pass ----
  const { run, warnings } = await buildRun(
    fs.readFileSync(path.join(FIX, "before.docx")),
    fs.readFileSync(path.join(FIX, "after.docx")),
    fs.readFileSync(path.join(FIX, "comments.xlsx")),
    { before: "before.docx", after: "after.docx", register: "comments.xlsx" }
  );
  const store = new Store(RUNS);
  store.save(run);
  log(`run ${run.runId}: ${run.before.blocks.length} blocks (~${Math.floor(run.before.blocks.length / 45)} pages), ${run.comments.length} comments, ${run.diff.length} hunks, headings=${Object.keys(run.headingMap).length}, warnings=${warnings.length}`);
  log(`anchorMethods (pre-resolver): ${JSON.stringify(run.summary.anchorMethods)}`);
  if (warnings.length) log(`warnings: ${warnings.join(" | ")}`);

  // ---- execute (resolver + 6 verify tasks + completer, real model) ----
  const events: any = {
    onAnchorStart: (p: number) => log(`→ ANCHOR resolver (${p} unresolved)`),
    onAnchorDone: (l: number, tc: number) => log(`✓ anchor resolver done (${l} llm-anchored, ${tc} tool calls)`),
    onSplit: (n: number) => log(`✓ split: ${n} verify tasks`),
    onTaskStart: (id: string) => log(`→ ${id} started`),
    onTaskDone: (id: string, tc: number) => log(`✓ ${id} done (${tc} tool calls)`),
    onTaskRetry: (id: string, reason: string) => log(`↻ ${id} retry: ${reason.slice(0, 120)}`),
    onCompleteStart: () => log(`→ completion started`),
    onCompleteDone: (tc: number, by: string) => log(`✓ completion done (${by}, ${tc} tool calls)`),
  };
  const done = await executeRun(store, run, config, events);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  log(`run finished in ${mins} min: status=${done.status} verdict=${done.verdict}`);
  log(`anchorMethods (final): ${JSON.stringify(done.summary.anchorMethods)}`);

  // ---- grade against ledger ----
  const results = done.tasks.flatMap((t) => t.results);
  const anchors = new Map(done.anchors.map((a) => [a.commentNumber, a]));
  let strictPass = 0, strictTotal = 0, tolPass = 0, tolTotal = 0;
  const byGroup: Record<string, { pass: number; total: number; anchorPass: number }> = {};
  const mismatches: any[] = [];

  for (const c of ledger.comments) {
    const r = results.find((x) => x.commentNumber === c.n);
    const a = anchors.get(c.n);
    const g = byGroup[c.group] ?? (byGroup[c.group] = { pass: 0, total: 0, anchorPass: 0 });
    g.total++;
    if (!r) {
      mismatches.push({ n: c.n, group: c.group, expected: c.expectVerdict, got: "NO VERDICT" });
      continue;
    }
    const verdictOk = c.strict
      ? r.verdict === c.expectVerdict
      : r.verdict === c.expectVerdict || r.verdict === "needs_user";
    // anchor-tier check (informational for tolerant groups)
    const anchorOk =
      c.expectAnchor === "llm" ? (a?.method === "llm" || a?.method === "content" || a?.method === "failed")
      : c.expectAnchor === "failed" ? a?.method === "failed"
      : a?.method === c.expectAnchor;
    if (anchorOk) g.anchorPass++;
    if (verdictOk) g.pass++;
    else mismatches.push({
      n: c.n, group: c.group, expected: c.expectVerdict, got: r.verdict,
      anchor: a?.method, note: a?.note?.slice(0, 80),
    });
    if (c.strict) { strictTotal++; if (verdictOk) strictPass++; }
    else { tolTotal++; if (verdictOk) tolPass++; }
  }

  console.log("\n===== GRADE =====");
  for (const [g, s] of Object.entries(byGroup)) {
    console.log(`  ${g}: verdicts ${s.pass}/${s.total} · anchor-tier ${s.anchorPass}/${s.total}`);
  }
  console.log(`  STRICT (A–F): ${strictPass}/${strictTotal}`);
  console.log(`  TOLERANT (G–H): ${tolPass}/${tolTotal}`);
  console.log(`  run verdict: ${done.verdict} · rollup expectation: needs_changes`);
  if (mismatches.length) {
    console.log("\n  mismatches:");
    for (const m of mismatches) console.log(`   #${m.n} [${m.group}] expected=${m.expected} got=${m.got} anchor=${m.anchor ?? "?"}${m.note ? ` (${m.note})` : ""}`);
  }
  fs.writeFileSync(
    path.join(RUNS, `${done.runId}.grade.json`),
    JSON.stringify({ mins, verdict: done.verdict, anchorMethods: done.summary.anchorMethods, byGroup, strict: [strictPass, strictTotal], tolerant: [tolPass, tolTotal], mismatches }, null, 2)
  );
  console.log(`\ngrade written: ${path.join(RUNS, done.runId + ".grade.json")}`);
  console.log(mismatches.length === 0 ? "\nLIVE SCALE PASS" : `\nLIVE SCALE DONE — ${mismatches.length} mismatch(es), see grade.json`);
}

main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
