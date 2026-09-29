// End-to-end test — full loop WITHOUT a model server:
//   fixtures → pre-pass (+ ruleset snapshot) → deterministic split → orchestrator
//   → pi agent sessions (faux provider, scripted) → tools → guards → report.
// Covers BOTH roles: comment verification AND layout validation against a ruleset.
// The scripted "oracle" plays the model: it follows the system prompts' workflows.

import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store.js";
import { buildRun } from "../src/prepass/index.js";
import { executeRun } from "../src/orchestrator.js";
import { parseRuleset } from "../src/ruleset.js";
import { fauxHandle, type RuntimeConfig } from "../src/agent/runtime.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildVerifierTools, buildLayoutTools } from "../src/agent/tools.js";
import type { Run, Task } from "../src/types.js";

const FIX = path.join(process.cwd(), "test", "fixtures");
const config: RuntimeConfig = { mode: "faux" };

/** Inline ruleset: 3 agent-judged rules + 1 [auto] rule (must be excluded from layout tasks). */
const RULESET_MD = `# Ruleset: E2E Test Ruleset (v9.9)

## DOC-1: auto rule that the pre-pass owns [auto]

Deterministic — the layout agent never judges this one.

## HDG-1: Headings use the document's defined heading styles

Body text with guidance.

## TBL-1: Tables use the document's defined table style

Body text with guidance.

## TXT-1: No TODO or placeholder text remains

Body text with guidance.
`;

function fail(msg: string): never {
  console.error("❌ " + msg);
  process.exit(1);
}

async function main() {
  // ---- fixtures exist? ----
  for (const f of ["before.docx", "after.docx", "comments.xlsx"]) {
    if (!fs.existsSync(path.join(FIX, f))) fail(`missing fixture ${f} — run: npm run fixtures`);
  }

  // ---- ruleset parser unit checks ----
  {
    const { ruleset, errors } = parseRuleset(RULESET_MD);
    if (!ruleset || errors.length) fail(`ruleset parse failed: ${errors.join("; ")}`);
    if (ruleset.name !== "E2E Test Ruleset") fail(`ruleset name: ${ruleset.name}`);
    if (ruleset.version !== "v9.9") fail(`ruleset version: ${ruleset.version}`);
    if (ruleset.rules.length !== 4) fail(`expected 4 rules, got ${ruleset.rules.length}`);
    if (ruleset.rules.filter((r) => r.auto).length !== 1) fail("expected exactly 1 [auto] rule");
    const bad = parseRuleset("no headers here");
    if (bad.ruleset || !bad.errors.length) fail("malformed ruleset must be rejected");
    console.log("✓ ruleset parser: 4 rules parsed, [auto] flagged, malformed rejected");
  }

  // ---- pre-pass + ruleset snapshot ----
  const { run, warnings } = await buildRun(
    fs.readFileSync(path.join(FIX, "before.docx")),
    fs.readFileSync(path.join(FIX, "after.docx")),
    fs.readFileSync(path.join(FIX, "comments.xlsx")),
    { before: "before.docx", after: "after.docx", register: "comments.xlsx" },
    RULESET_MD
  );
  const store = new Store(path.join(process.cwd(), "runs-test"));
  store.save(run);
  console.log(`run ${run.runId}: ${run.summary.commentCount} comments, ${run.summary.hunkCount} hunks, ${run.summary.anchoredCount} anchored, ${warnings.length} warnings`);
  if (run.summary.hunkCount !== 3) fail(`expected 3 diff hunks, got ${run.summary.hunkCount}`);
  if (run.summary.anchoredCount !== 4) fail(`expected 4 anchored comments, got ${run.summary.anchoredCount}`);
  if (!run.ruleset || run.ruleset.rules.length !== 4) fail("ruleset not snapshotted into run");
  console.log(`✓ ruleset snapshotted: ${run.ruleset.name} ${run.ruleset.version} (${run.ruleset.rules.length} rules)`);

  // ---- guard unit tests: premature completeTask rejected for BOTH task types ----
  run.tasks.push({
    taskId: "Tguard", type: "verify_comments", title: "guard test",
    commentNumbers: [1, 2], status: "todo", results: [], findings: [],
  });
  run.tasks.push({
    taskId: "Lguard", type: "validate_layout", title: "guard test layout",
    commentNumbers: [], ruleIds: ["HDG-1"], status: "todo", results: [], findings: [],
  });
  store.save(run);
  const tguard = run.tasks[0] as Task;
  const lguard = run.tasks[1] as Task;
  const vComplete = buildVerifierTools({ store, run, task: tguard }).find((t) => t.name === "completeTask")!;
  const guardRes = await vComplete.execute("test-id", { note: "premature" });
  if (!JSON.stringify(guardRes.content).includes("Guard")) fail("verify guard did not reject");
  console.log("✓ guard rejects completeTask before all writeResults");
  const lTools = buildLayoutTools({ store, run, task: lguard });
  const lComplete = lTools.find((t) => t.name === "completeTask")!;
  const lGuardRes = await lComplete.execute("test-id", { note: "premature" });
  if (!JSON.stringify(lGuardRes.content).includes("Guard")) fail("layout guard did not reject");
  const wv = lTools.find((t) => t.name === "writeValidation")!;
  let wvErr = "";
  try { await wv.execute("test-id", { id: "X", ruleId: "TBL-9", severity: "pass", evidence: "x", verdictReason: "y", confidence: "high" }); }
  catch (e) { wvErr = String((e as Error).message); }
  if (!wvErr.includes("not in scope")) fail(`writeValidation did not reject out-of-scope rule (got: ${wvErr})`);
  console.log("✓ guard rejects layout completeTask + out-of-scope ruleId");
  run.tasks = []; // reset — the deterministic split creates the real tasks
  store.save(run);

  // ---- script the oracle model (faux provider) ----
  const faux = fauxHandle(config);
  if (!faux) fail("no faux handle");
  let currentTaskId = "";
  const oracle = (context: any) => {
    // ---- distinct COMPLETION session: writeRunSummary then completeRun ----
    if (currentTaskId === "DONE") {
      const fresh = store.get(run.runId) as Run;
      if (!fresh.completionSummary) {
        return fauxAssistantMessage(
          [fauxToolCall("writeRunSummary", {
            summary: "4 comments verified: 3 correctly applied, 1 missing. 3 layout rules judged. Comment #2 needs attention.",
          })],
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage([fauxToolCall("completeRun", {})]);
    }
    // ---- execution session (per task — verify or layout) ----
    const fresh = store.get(run.runId) as Run;
    const task = fresh.tasks.find((t) => t.taskId === currentTaskId)!;
    const toolResults = (context.messages ?? []).filter((m: any) => m.role === "toolResult");

    if (task.type === "validate_layout") {
      const ruleIds = task.ruleIds ?? [];
      const allWritten = ruleIds.every((r) => task.findings.some((f) => f.ruleId === r));
      if (toolResults.length === 0) {
        return fauxAssistantMessage([fauxToolCall("getWindow", { doc: "after", center: 0, radius: 8 })], { stopReason: "toolUse" });
      }
      if (!allWritten) {
        return fauxAssistantMessage(
          ruleIds.map((id) => fauxToolCall("writeValidation", {
            id: `F-${id}`, ruleId: id,
            severity: id === "TXT-1" ? "warning" : "pass",
            evidence: "inspected window blocks 0-8 of after.docx",
            verdictReason: "scripted finding for e2e",
            confidence: "high",
          })),
          { stopReason: "toolUse" }
        );
      }
      return fauxAssistantMessage([fauxToolCall("completeTask", { note: "rules judged" })]);
    }

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
  faux.setResponses(Array.from({ length: 40 }, () => oracle));

  // ---- execute the run ----
  let totalToolCalls = 0;
  let splitSeen = { verify: -1, layout: -1 };
  const done = await executeRun(store, run, config, {
    onSplit: (v, l) => { splitSeen = { verify: v, layout: l }; console.log(`✓ deterministic split: ${v} verify + ${l} layout tasks (no planner session)`); },
    onCompleteStart: () => { currentTaskId = "DONE"; console.log("→ DONE started (completion agent — after ALL tasks)"); },
    onCompleteDone: (tc, by) => { totalToolCalls += tc; console.log(`✓ completion done (${by}) (${tc} tool calls through pi)`); },
    onTaskStart: (id) => { currentTaskId = id; console.log(`→ ${id} started`); },
    onTaskDone: (id, tc) => { totalToolCalls += tc; console.log(`✓ ${id} done (${tc} tool calls through pi)`); },
    onTaskRetry: (id, reason) => console.log(`↻ ${id} retry: ${reason.slice(0, 100)}`),
  });

  // ---- assertions ----
  if (done.status !== "done") fail(`run status ${done.status}`);
  // deterministic split: 4 comments → 1 verify task; 3 non-auto rules → 1 layout task
  if (splitSeen.verify !== 1 || splitSeen.layout !== 1)
    fail(`expected split 1 verify + 1 layout, got ${splitSeen.verify}+${splitSeen.layout}`);
  const verifyTasks = done.tasks.filter((t) => t.type === "verify_comments");
  const layoutTasks = done.tasks.filter((t) => t.type === "validate_layout");
  if (verifyTasks.length !== 1) fail(`expected 1 verify task, got ${verifyTasks.length}`);
  if (verifyTasks[0].commentNumbers.length !== 4) fail("verify task must hold all 4 comments");
  if (layoutTasks.length !== 1) fail(`expected 1 layout task, got ${layoutTasks.length}`);
  const lRuleIds = layoutTasks[0].ruleIds ?? [];
  if (lRuleIds.length !== 3 || lRuleIds.includes("DOC-1"))
    fail(`layout task must hold the 3 non-auto rules (no [auto] DOC-1), got ${lRuleIds.join(",")}`);
  console.log(`✓ deterministic split: T1 (4 comments) + L1 (${lRuleIds.join(", ")}) — [auto] DOC-1 excluded`);

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
  const findings = layoutTasks.flatMap((t) => t.findings);
  if (findings.length !== 3) fail(`expected 3 layout findings, got ${findings.length}`);
  console.log(`✓ layout findings: ${findings.map((f) => `${f.ruleId}=${f.severity}`).join(", ")}`);

  if (done.verdict !== "needs_changes") fail(`expected verdict needs_changes, got ${done.verdict}`);
  console.log(`✓ deterministic rollup: ${done.verdict}`);
  if (totalToolCalls === 0) fail("pi made zero tool calls — tool bridge broken");

  const reportJsonPath = path.join(process.cwd(), "runs-test", `${done.runId}.report.json`);
  const reportHtmlPath = path.join(process.cwd(), "runs-test", `${done.runId}.report.html`);
  if (!fs.existsSync(reportJsonPath) || !fs.existsSync(reportHtmlPath)) fail("report files missing");
  const json: any = JSON.parse(fs.readFileSync(reportJsonPath, "utf8"));
  if (json.verdict !== "needs_changes") fail("report verdict mismatch");
  if ((json.layout_findings ?? []).length !== 3) fail("report layout_findings missing");
  if (!json.summary.ruleset?.name) fail("report ruleset meta missing");
  if (json.tasks.some((t: any) => t.type === undefined)) fail("report tasks must carry type");
  console.log(`✓ reports written (layout_findings + ruleset meta included): ${path.basename(reportJsonPath)}`);

  const transcript = store.transcriptPath(done.runId, verifyTasks[0].taskId);
  if (!fs.existsSync(transcript)) fail("transcript JSONL missing");
  console.log(`✓ audit transcript: ${path.basename(transcript)}`);

  // ---- no-ruleset run: layout tasks absent, run still succeeds ----
  {
    const bare = await buildRun(
      fs.readFileSync(path.join(FIX, "before.docx")),
      fs.readFileSync(path.join(FIX, "after.docx")),
      fs.readFileSync(path.join(FIX, "comments.xlsx")),
      { before: "before.docx", after: "after.docx", register: "comments.xlsx" }
    );
    if (bare.run.ruleset !== null) fail("ruleset must be null when none supplied");
    console.log("✓ no-ruleset run accepted (ruleset optional)");
  }

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
