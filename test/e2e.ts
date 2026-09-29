// End-to-end test — full loop WITHOUT a model server:
//   fixtures → pre-pass (heading map + TOC + anchor cascade) → LLM anchor resolver
//   (only for comments with no location data) → deterministic split → orchestrator
//   → pi agent sessions (faux provider, scripted) → tools → guards → report.
// No planner, no layout validation (out of scope). The scripted "oracle" plays
// the model: resolver + verifier + completer workflows.

import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { buildRun } from "../src/prepass/index.js";
import { executeRun } from "../src/orchestrator.js";
import { fauxHandle, type RuntimeConfig } from "../src/agent/runtime.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildVerifierTools } from "../src/agent/tools.js";
import type { Run } from "../src/types.js";

const FIX = path.join(process.cwd(), "test", "fixtures");
const config: RuntimeConfig = { mode: "faux" };

function fail(msg: string): never {
  console.error("❌ " + msg);
  process.exit(1);
}

async function main() {
  // ---- fixtures exist? ----
  for (const f of ["before.docx", "after.docx", "comments.xlsx"]) {
    if (!fs.existsSync(path.join(FIX, f))) fail(`missing fixture ${f} — run: npm run fixtures`);
  }

  // ---- pre-pass ----
  const { run, warnings } = await buildRun(
    fs.readFileSync(path.join(FIX, "before.docx")),
    fs.readFileSync(path.join(FIX, "after.docx")),
    fs.readFileSync(path.join(FIX, "comments.xlsx")),
    { before: "before.docx", after: "after.docx", register: "comments.xlsx" }
  );
  const store = new Store(path.join(process.cwd(), "runs-test"));
  store.save(run);
  console.log(`run ${run.runId}: ${run.summary.commentCount} comments, ${run.summary.hunkCount} hunks, ${run.summary.anchoredCount} anchored (pre-resolver), ${warnings.length} warnings`);
  if (run.summary.commentCount !== 5) fail(`expected 5 comments, got ${run.summary.commentCount}`);
  if (run.summary.hunkCount !== 3) fail(`expected 3 diff hunks, got ${run.summary.hunkCount}`);
  if (run.summary.anchoredCount !== 4) fail(`expected 4 deterministic anchors (comment 5 unresolved), got ${run.summary.anchoredCount}`);
  if (warnings.length !== 0) fail(`expected 0 warnings (complete TOC), got ${warnings.join(" | ")}`);
  for (const key of ["1", "6", "6.2", "6.3", "7", "7.1"]) {
    if (run.headingMap[key] === undefined) fail(`heading map missing section ${key}`);
  }
  if (run.summary.anchorMethods.section !== 4 || run.summary.anchorMethods.failed !== 1)
    fail(`expected anchorMethods {section:4, failed:1}, got ${JSON.stringify(run.summary.anchorMethods)}`);
  console.log(`✓ heading map: ${Object.keys(run.headingMap).join(", ")} · anchorMethods ${JSON.stringify(run.summary.anchorMethods)}`);

  // ---- guard unit test: premature completeTask rejected ----
  run.tasks.push({
    taskId: "Tguard", title: "guard test",
    commentNumbers: [1, 2], status: "todo", results: [],
  });
  store.save(run);
  const tguard = run.tasks[0];
  const vComplete = buildVerifierTools({ store, run, task: tguard }).find((t) => t.name === "completeTask")!;
  const guardRes = await vComplete.execute("test-id", { note: "premature" });
  if (!JSON.stringify(guardRes.content).includes("Guard")) fail("verify guard did not reject");
  console.log("✓ guard rejects completeTask before all writeResults");
  run.tasks = []; // reset — the deterministic split creates the real tasks
  store.save(run);

  // ---- script the oracle model (faux provider) ----
  const faux = fauxHandle(config);
  if (!faux) fail("no faux handle");
  let currentTaskId = "";
  let mode: "anchor" | "tasks" | "done" = "tasks";
  const oracle = (context: any) => {
    // ---- ANCHOR RESOLVER session: pickAnchor per pending comment, then guarded close ----
    if (mode === "anchor") {
      const fresh = store.get(run.runId) as Run;
      const pending = fresh.anchors.filter((a: any) => a.anchorIndex === null && !a.note);
      if (pending.length) {
        const pin = fresh.before.blocks.find((b: any) => b.type === "table" && b.text.includes("Pin"));
        return fauxAssistantMessage(
          [fauxToolCall("pickAnchor", {
            commentNumber: pending[0].commentNumber,
            blockIndex: pin ? pin.index : 0,
            evidence: "baud rate belongs to the wiring pin table (scripted resolver)",
          })],
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage([fauxToolCall("completeAnchoring", {})], { stopReason: "toolUse" });
    }
    // ---- distinct COMPLETION session: writeRunSummary then completeRun ----
    if (currentTaskId === "DONE") {
      const fresh = store.get(run.runId) as Run;
      if (!fresh.completionSummary) {
        return fauxAssistantMessage(
          [fauxToolCall("writeRunSummary", {
            summary: "4 comments verified: 3 correctly applied, 1 missing. Comment #2 needs attention.",
          })],
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage([fauxToolCall("completeRun", {})]);
    }
    // ---- execution session (per task) ----
    const fresh = store.get(run.runId) as Run;
    const task = fresh.tasks.find((t) => t.taskId === currentTaskId)!;
    const toolResults = (context.messages ?? []).filter((m: any) => m.role === "toolResult");
    const allWritten = task.commentNumbers.every((n) =>
      task.results.some((r) => r.commentNumber === n)
    );
    if (toolResults.length === 0) {
      // step 1: inspect the diff for every comment in scope (parallel tool calls)
      return fauxAssistantMessage(
        task.commentNumbers.map((n) => fauxToolCall("getDiff", { commentNumber: n })),
        { stopReason: "toolUse" }
      );
    }
    if (!allWritten) {
      // step 2: write verdicts from the evidence the agent collected
      const calls = task.commentNumbers.map((n) => {
        const anchor = fresh.anchors.find((a) => a.commentNumber === n)!;
        const end = anchor.sectionEnd ?? anchor.anchorIndex ?? 0;
        const hunk =
          anchor.anchorIndex === null
            ? undefined
            : fresh.diff.find((h) => {
                const bi = h.beforeIndex ?? h.afterIndex;
                return bi !== undefined && bi >= anchor.anchorIndex! && bi <= end;
              });
        const verdict = !anchor || anchor.anchorIndex === null ? "needs_user"
          : hunk ? "correctly_applied" : "missing";
        return fauxToolCall("writeResult", {
          commentNumber: n,
          verdict,
          evidence: hunk
            ? `diff ${hunk.id}: "${(hunk.beforeText ?? "").slice(0, 60)}" → "${(hunk.afterText ?? "").slice(0, 60)}"`
            : anchor.anchorIndex === null
              ? "anchoring failed"
              : `no diff hunk at anchor block ${anchor.anchorIndex} (register says processed=yes)`,
          confidence: "high",
        });
      });
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }
    // step 3: guarded completion
    return fauxAssistantMessage(
      [fauxToolCall("completeTask", { note: "all comments verified" })],
      { stopReason: "toolUse" }
    );
  };
  faux.setResponses(Array.from({ length: 40 }, () => oracle));

  // ---- execute the run ----
  let totalToolCalls = 0;
  let splitSeen = -1;
  let anchorStart = -1;
  let anchorLlm = -1;
  const done = await executeRun(store, run, config, {
    onAnchorStart: (pending) => { mode = "anchor"; anchorStart = pending; console.log(`→ ANCHOR resolver started (${pending} unresolved)`); },
    onAnchorDone: (llm, tc) => { anchorLlm = llm; totalToolCalls += tc; console.log(`✓ anchor resolver done (${llm} LLM-anchored, ${tc} tool calls through pi)`); },
    onSplit: (n) => { mode = "tasks"; splitSeen = n; console.log(`✓ deterministic split: ${n} verify tasks (no planner session, no layout tasks)`); },
    onCompleteStart: () => { currentTaskId = "DONE"; console.log("→ DONE started (completion agent — after ALL tasks)"); },
    onCompleteDone: (tc, by) => { totalToolCalls += tc; console.log(`✓ completion done (${by}) (${tc} tool calls through pi)`); },
    onTaskStart: (id) => { currentTaskId = id; console.log(`→ ${id} started`); },
    onTaskDone: (id, tc) => { totalToolCalls += tc; console.log(`✓ ${id} done (${tc} tool calls through pi)`); },
    onTaskRetry: (id, reason) => console.log(`↻ ${id} retry: ${reason.slice(0, 100)}`),
  });

  // ---- assertions ----
  if (done.status !== "done") fail(`run status ${done.status}`);
  // deterministic split: 4 comments → exactly 1 task holding all 4
  if (splitSeen !== 1) fail(`expected split 1 verify task, got ${splitSeen}`);
  if (done.tasks.length !== 1) fail(`expected 1 task, got ${done.tasks.length}`);
  if (done.tasks[0].commentNumbers.length !== 5) fail("task must hold all 5 comments");
  if (anchorStart !== 1) fail(`expected 1 pending anchor for the resolver, got ${anchorStart}`);
  if (anchorLlm !== 1) fail(`expected 1 LLM anchor, got ${anchorLlm}`);
  if (done.summary.anchoredCount !== 5) fail(`expected 5 anchored after resolver, got ${done.summary.anchoredCount}`);
  if (done.summary.anchorMethods.llm !== 1 || done.summary.anchorMethods.section !== 4)
    fail(`expected anchorMethods {section:4, llm:1}, got ${JSON.stringify(done.summary.anchorMethods)}`);
  console.log(`✓ deterministic split: T1 = comments [${done.tasks[0].commentNumbers.join(",")}] · anchorMethods ${JSON.stringify(done.summary.anchorMethods)}`);

  const results = done.tasks[0].results;
  if (results.length !== 5) fail(`expected 5 verdicts, got ${results.length}`);
  const expected: Record<number, string> = {
    1: "correctly_applied",  // section "1" anchor, edit inside section window
    2: "missing",            // section 6.3, NO edit in window
    3: "correctly_applied",  // table in 6.2, exact block anchor
    4: "correctly_applied",  // section 7.1, edit inside window
    5: "missing",            // LLM anchor (pin table), no edit — provenance rides along
  };
  for (const [n, v] of Object.entries(expected)) {
    const r = results.find((x) => x.commentNumber === Number(n));
    if (!r) fail(`comment #${n} has no result`);
    if (r.verdict !== v) fail(`comment #${n}: expected ${v}, got ${r.verdict}`);
    console.log(`✓ comment #${n} → ${r.verdict}`);
  }

  if (done.verdict !== "needs_changes") fail(`expected verdict needs_changes, got ${done.verdict}`);
  console.log(`✓ deterministic rollup: ${done.verdict}`);
  if (totalToolCalls === 0) fail("pi made zero tool calls — tool bridge broken");

  const reportJsonPath = path.join(process.cwd(), "runs-test", `${done.runId}.report.json`);
  const reportHtmlPath = path.join(process.cwd(), "runs-test", `${done.runId}.report.html`);
  if (!fs.existsSync(reportJsonPath) || !fs.existsSync(reportHtmlPath)) fail("report files missing");
  const json: any = JSON.parse(fs.readFileSync(reportJsonPath, "utf8"));
  if (json.verdict !== "needs_changes") fail("report verdict mismatch");
  if (json.layout_findings !== undefined || json.summary.ruleset !== undefined)
    fail("layout/ruleset must be fully gone from the report");
  console.log(`✓ reports written (comment-only, no layout remnants): ${path.basename(reportJsonPath)}`);

  const transcript = store.transcriptPath(done.runId, done.tasks[0].taskId);
  if (!fs.existsSync(transcript)) fail("transcript JSONL missing");
  console.log(`✓ audit transcript: ${path.basename(transcript)}`);

  // ---- format coverage: markdown pair + pdf parse ----
  {
    const mdRun = await buildRun(
      fs.readFileSync(path.join(FIX, "before.md")),
      fs.readFileSync(path.join(FIX, "after.md")),
      fs.readFileSync(path.join(FIX, "comments-plain.xlsx")),
      { before: "before.md", after: "after.md", register: "comments-plain.xlsx" }
    );
    if (mdRun.run.summary.commentCount !== 4) fail(`md run expected 4 comments, got ${mdRun.run.summary.commentCount}`);
    if (mdRun.run.summary.hunkCount < 2) fail(`md run expected >=2 hunks, got ${mdRun.run.summary.hunkCount}`);
    console.log("✓ markdown pair: 4 comments, " + mdRun.run.summary.hunkCount + " hunks");
    const { parsePdf } = await import("../src/prepass/pdf.js");
    const pAfter = await parsePdf("after.pdf", fs.readFileSync(path.join(FIX, "after.pdf")));
    if (!pAfter.blocks.some((b) => b.text.includes("IP67"))) fail("pdf parse missed IP67 text");
    console.log("✓ pdf pair: parsed " + pAfter.blocks.length + " blocks, found IP67");
  }

  console.log(`\nE2E PASS — ${totalToolCalls} agent tool calls flowed through pi into the backend API`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
