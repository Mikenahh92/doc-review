// End-to-end test — full loop WITHOUT a model server:
//   fixtures → pre-pass → plan → orchestrator → pi agent sessions (faux provider, scripted)
//   → agent calls backend tools (getDiff/writeResult/completeTask) → guards → report.
// The scripted "oracle" plays the model: it follows the system prompt's workflow by emitting
// tool calls and computing verdicts from the SAME data the real model would see via getDiff.

import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { buildRun } from "../src/prepass/index.js";
import { executeRun } from "../src/orchestrator.js";
import { fauxHandle, type RuntimeConfig } from "../src/agent/runtime.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildVerifierTools } from "../src/agent/tools.js";
import type { Run, Task } from "../src/types.js";

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

  // ---- pre-pass + plan ----
  const { run, warnings } = buildRun(
    fs.readFileSync(path.join(FIX, "before.docx")),
    fs.readFileSync(path.join(FIX, "after.docx")),
    fs.readFileSync(path.join(FIX, "comments.xlsx")),
    { before: "before.docx", after: "after.docx", register: "comments.xlsx" }
  );
  const store = new Store(path.join(process.cwd(), "runs-test"));
  store.save(run);
  console.log(`run ${run.runId}: ${run.summary.commentCount} comments, ${run.summary.hunkCount} hunks, ${run.summary.anchoredCount} anchored, ${warnings.length} warnings`);
  if (run.summary.hunkCount !== 3) fail(`expected 3 diff hunks, got ${run.summary.hunkCount}`);
  if (run.summary.anchoredCount !== 4) fail(`expected 4 anchored comments, got ${run.summary.anchoredCount}`);

  // ---- guard unit test: completeTask must reject when results are missing ----
  // (seed a temp task — the real tasks are created later by the planner agent)
  run.tasks.push({
    taskId: "Tguard", type: "verify_comments", title: "guard test",
    commentNumbers: [1, 2], status: "todo", results: [], findings: [],
  });
  const t0 = run.tasks[0] as Task;
  const tools = buildVerifierTools({ store, run, task: t0 });
  const complete = tools.find((t) => t.name === "completeTask")!;
  const guardRes = await complete.execute("test-id", { note: "premature" });
  const guardText = JSON.stringify(guardRes.content);
  if (!guardText.includes("Guard")) fail("guard did not reject premature completeTask");
  console.log("✓ guard rejects completeTask before all writeResults");
  run.tasks = []; // reset — the planner agent creates the real plan
  store.save(run);

  // ---- script the oracle model (faux provider) ----
  const faux = fauxHandle(config);
  if (!faux) fail("no faux handle");
  let currentTaskId = "";
  const oracle = (context: any) => {
    // ---- distinct PLANNER session: group comments into 2 tasks ----
    if (currentTaskId === "PLAN") {
      const fresh = store.get(run.runId) as Run;
      if (fresh.tasks.length === 0) {
        return fauxAssistantMessage(
          [fauxToolCall("writeTaskPlan", {
            tasks: [
              { title: "Verify comments 1-2", commentNumbers: [1, 2] },
              { title: "Verify comments 3-4", commentNumbers: [3, 4] },
            ],
          })],
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage(
        [fauxToolCall("completePlanning", { rationale: "two balanced tasks" })],
        { stopReason: "toolUse" }
      );
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
      return fauxAssistantMessage(
        [fauxToolCall("completeRun", {})],
        { stopReason: "toolUse" }
      );
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
        const hunk =
          anchor.anchorIndex === null
            ? undefined
            : fresh.diff.find(
                (h) => h.beforeIndex === anchor.anchorIndex || h.afterIndex === anchor.anchorIndex
              );
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
  faux.setResponses(Array.from({ length: 30 }, () => oracle));

  // ---- execute the run ----
  let totalToolCalls = 0;
  const done = await executeRun(store, run, config, {
    onPlanStart: () => { currentTaskId = "PLAN"; console.log("→ PLAN started (planner agent)"); },
    onPlanDone: (n, tc, by) => { totalToolCalls += tc; console.log(`✓ plan done (${by}): ${n} tasks (${tc} tool calls through pi)`); },
    onCompleteStart: () => { currentTaskId = "DONE"; console.log("→ DONE started (completion agent — after ALL tasks)"); },
    onCompleteDone: (tc, by) => { totalToolCalls += tc; console.log(`✓ completion done (${by}) (${tc} tool calls through pi)`); },
    onTaskStart: (id) => { currentTaskId = id; console.log(`→ ${id} started`); },
    onTaskDone: (id, tc) => { totalToolCalls += tc; console.log(`✓ ${id} done (${tc} tool calls through pi)`); },
    onTaskRetry: (id, reason) => console.log(`↻ ${id} retry: ${reason.slice(0, 100)}`),
  });

  // ---- assertions ----
  if (done.status !== "done") fail(`run status ${done.status}`);
  // planner agent created the tasks (2 grouped tasks — the deterministic fallback would make 1)
  if (done.tasks.length !== 2) fail(`expected 2 planner-created tasks, got ${done.tasks.length}`);
  console.log("✓ planner agent created 2 tasks (distinct planning session)");
  const results = done.tasks.flatMap((t) => t.results);
  if (results.length !== 4) fail(`expected 4 verdicts, got ${results.length}`);
  const expected: Record<number, string> = {
    1: "correctly_applied",
    2: "missing",       // fixture: comment 2 was NEVER applied by the humans
    3: "correctly_applied",
    4: "correctly_applied",
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

  const reportJson = path.join(process.cwd(), "runs-test", `${done.runId}.report.json`);
  const reportHtml = path.join(process.cwd(), "runs-test", `${done.runId}.report.html`);
  if (!fs.existsSync(reportJson) || !fs.existsSync(reportHtml)) fail("report files missing");
  const json: any = JSON.parse(fs.readFileSync(reportJson, "utf8"));
  if (json.verdict !== "needs_changes") fail("report verdict mismatch");
  console.log(`✓ reports written: ${path.basename(reportJson)}, ${path.basename(reportHtml)}`);

  const transcript = store.transcriptPath(done.runId, done.tasks[0].taskId);
  if (!fs.existsSync(transcript)) fail("transcript JSONL missing");
  console.log(`✓ audit transcript: ${path.basename(transcript)}`);

  console.log(`\nE2E PASS — ${totalToolCalls} agent tool calls flowed through pi into the backend API`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
