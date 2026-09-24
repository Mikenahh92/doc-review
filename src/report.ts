// Report: deterministic verdict rollup + JSON + HTML rendering. Findings-first; the document
// is rendered FROM structured state, never composed by the agent.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "./store.js";
import type { Run, Verdict } from "./types.js";

export function rollupVerdict(run: Run): string {
  const bad = run.tasks
    .flatMap((t) => t.results)
    .some((r) => r.verdict === "missing" || r.verdict === "incorrectly_applied");
  const violation = run.autoChecks.some((f) => f.severity === "violation");
  if (bad || violation) return "needs_changes";
  const needsUser = run.tasks.some((t) => t.results.some((r) => r.verdict === "needs_user"));
  if (needsUser) return "needs_user_review";
  return "approved";
}

export function reportJson(run: Run): object {
  const results = run.tasks.flatMap((t) =>
    t.results.map((r) => ({
      ...r,
      task: t.taskId,
      comment: run.comments.find((c) => c.number === r.commentNumber)?.comment ?? "",
    }))
  );
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  return {
    run_id: run.runId,
    created_at: run.createdAt,
    summary: {
      before: run.summary.docSummaryBefore,
      after: run.summary.docSummaryAfter,
      diff_hunks: run.summary.hunkCount,
      comments: { total: run.comments.length, anchored: run.summary.anchoredCount, verdicts: counts },
    },
    verdict: rollupVerdict(run),
    comment_verdicts: results,
    auto_checks: run.autoChecks,
    tasks: run.tasks.map((t) => ({ id: t.taskId, title: t.title, status: t.status, note: t.note })),
  };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function reportHtml(run: Run): string {
  const results = run.tasks.flatMap((t) => t.results.map((r) => ({ ...r, task: t.taskId })));
  const cls = (v: Verdict) =>
    v === "correctly_applied" ? "ok" : v === "needs_user" ? "user" : "bad";
  const rows = results
    .map(
      (r) => `<tr><td>#${r.commentNumber}</td><td><span class="pill ${cls(r.verdict)}">${r.verdict}</span></td>` +
        `<td>${esc(r.evidence).slice(0, 300)}</td><td>${r.confidence}</td></tr>`
    )
    .join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ReWork check ${run.runId}</title>
<style>
body{font-family:Segoe UI,sans-serif;margin:24px;color:#223}
h1{font-size:20px}.verdict{font-size:16px;font-weight:700;padding:6px 14px;border-radius:8px;display:inline-block}
.needs_changes{background:#fde2e2;color:#b02020}.approved{background:#e2f4e4;color:#1e7a2e}
.needs_user_review{background:#e8e4f8;color:#5b34b0}
table{border-collapse:collapse;width:100%;margin-top:14px;font-size:13px}
td,th{border-bottom:1px solid #eef;padding:6px;text-align:left}
.pill{padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.ok{background:#e2f4e4;color:#1e7a2e}.bad{background:#fde2e2;color:#b02020}.user{background:#e8e4f8;color:#5b34b0}
.meta{color:#778;font-size:12px;margin-top:10px}
</style></head><body>
<h1>ReWork check — ${run.runId}</h1>
<div class="verdict ${rollupVerdict(run).startsWith("needs") ? rollupVerdict(run) === "needs_changes" ? "needs_changes" : "needs_user_review" : "approved"}">${rollupVerdict(run)}</div>
<p class="meta">${esc(run.summary.docSummaryBefore)} → ${esc(run.summary.docSummaryAfter)} · ${run.summary.hunkCount} diff hunks · ${run.comments.length} comments (${run.summary.anchoredCount} anchored)</p>
<table><tr><th>Comment</th><th>Verdict</th><th>Evidence</th><th>Confidence</th></tr>
${rows}
</table>
${run.autoChecks.length ? `<h3>[auto] document checks</h3><ul>${run.autoChecks.map((f) => `<li><b>${f.ruleId}</b> (${f.severity}): ${esc(f.evidence)}</li>`).join("")}</ul>` : ""}
<p class="meta">Verdict computed deterministically from findings — never by the agent. Audit trail: runs/*.jsonl</p>
</body></html>`;
}

export function renderReport(store: Store, run: Run): void {
  const dir = store.runsDir;
  fs.writeFileSync(path.join(dir, `${run.runId}.report.json`), JSON.stringify(reportJson(run), null, 2));
  fs.writeFileSync(path.join(dir, `${run.runId}.report.html`), reportHtml(run));
}
