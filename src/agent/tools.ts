// Tool bridge: pi AgentTool definitions whose execute() calls straight into the backend app API.
// Tools are thin and dumb on purpose; validation and state writes live in the app (guards).

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Store } from "../store.js";
import type { Run, Task, TaskResult, Verdict } from "../types.js";
import { GuardError, VERDICTS } from "../types.js";

const text = (obj: unknown) => [{ type: "text" as const, text: JSON.stringify(obj, null, 1) }];

interface Ctx {
  store: Store;
  run: Run;
  task: Task;
}

function getRun(ctx: Ctx): Run {
  const fresh = ctx.store.get(ctx.run.runId);
  if (!fresh) throw new Error("run disappeared");
  return fresh;
}

function commentByNumber(ctx: Ctx, n: number) {
  const c = getRun(ctx).comments.find((x) => x.number === n);
  if (!c) throw new GuardError(`No comment #${n} exists in this run`);
  return c;
}

function anchorOf(ctx: Ctx, n: number) {
  return getRun(ctx).anchors.find((a) => a.commentNumber === n);
}

/** Diff hunks near a comment's anchor (before-index within ±3), or hunks mentioning anchor text. */
function hunksNear(ctx: Ctx, n: number) {
  const run = getRun(ctx);
  const anchor = run.anchors.find((a) => a.commentNumber === n);
  if (!anchor || anchor.anchorIndex === null) return { anchor, hunks: [] };
  const near = run.diff.filter(
    (h) => h.beforeIndex === anchor.anchorIndex || h.afterIndex === anchor.anchorIndex
  );
  return { anchor, hunks: near };
}

function excerpt(blocks: Run["before"]["blocks"], center: number | null, radius = 2) {
  if (center === null) return [];
  return blocks
    .filter((b) => b.index >= center - radius && b.index <= center + radius)
    .map((b) => ({ index: b.index, type: b.type, text: b.text.slice(0, 400) }));
}

function getOverview(ctx: Ctx): AgentTool<any> {
  return {
    name: "getOverview",
    label: "Run overview",
    description: "Summary of the run: both documents, diff size, comment list, anchor status.",
    parameters: Type.Object({}),
    execute: async () => {
      const run = getRun(ctx);
      return {
        content: text({
          before: run.summary.docSummaryBefore,
          after: run.summary.docSummaryAfter,
          diffHunks: run.summary.hunkCount,
          comments: run.comments.map((c) => ({ number: c.number, page: c.page, location: c.locationType, locationNumber: c.locationNumber })),
          anchors: run.anchors,
        }),
        details: {},
      };
    },
  };
}

function getDiff(ctx: Ctx): AgentTool<any> {
  return {
    name: "getDiff",
    label: "Diff near comment",
    description: "Aligned diff hunks between the before-review and after-review document near a comment's anchor.",
    parameters: Type.Object({ commentNumber: Type.Integer({ description: "Comment number from the register" }) }),
    execute: async (_id, p: any) => {
      commentByNumber(ctx, p.commentNumber);
      const { anchor, hunks } = hunksNear(ctx, p.commentNumber);
      return {
        content: text({
          commentNumber: p.commentNumber,
          anchor,
          hunks: hunks.length ? hunks : "(no diff hunks near this anchor)",
        }),
        details: { hunkCount: hunks.length },
      };
    },
  };
}

function excerptTool(ctx: Ctx, which: "before" | "after"): AgentTool<any> {
  return {
    name: which === "before" ? "getOriginalExcerpt" : "getReviewedExcerpt",
    label: which === "before" ? "Before-review excerpt" : "After-review excerpt",
    description: `Blocks around the comment's anchor in the ${which}-review document.`,
    parameters: Type.Object({
      commentNumber: Type.Integer(),
      radius: Type.Optional(Type.Integer({ default: 2, minimum: 0, maximum: 6 })),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      commentByNumber(ctx, p.commentNumber);
      const anchor = anchorOf(ctx, p.commentNumber);
      if (!anchor || anchor.anchorIndex === null) {
        return {
          content: text({ commentNumber: p.commentNumber, error: "anchoring failed — return needs_user for this comment" }),
          details: {},
        };
      }
      const blocks = which === "before" ? run.before.blocks : run.after.blocks;
      // after-doc: if a hunk replaced this anchor, show around the hunk's after-index instead
      let center = anchor.anchorIndex;
      if (which === "after") {
        const { hunks } = hunksNear(ctx, p.commentNumber);
        const h = hunks.find((x) => x.afterIndex !== undefined);
        if (h && h.afterIndex !== undefined) center = h.afterIndex;
      }
      return { content: text({ commentNumber: p.commentNumber, blocks: excerpt(blocks, center, p.radius ?? 2) }), details: {} };
    },
  };
}

function searchGlobal(ctx: Ctx): AgentTool<any> {
  return {
    name: "searchGlobal",
    label: "Search both documents",
    description: "Search a text fragment across BOTH documents; returns matches with block index and document.",
    parameters: Type.Object({ query: Type.String({ minLength: 3 }) }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const q = p.query.toLowerCase();
      const hits = (doc: string, blocks: Run["before"]["blocks"]) =>
        blocks.filter((b) => b.text.toLowerCase().includes(q)).slice(0, 5)
          .map((b) => ({ doc, index: b.index, type: b.type, text: b.text.slice(0, 200) }));
      return { content: text({ query: p.query, matches: [...hits("before", run.before.blocks), ...hits("after", run.after.blocks)] }), details: {} };
    },
  };
}

function writeResult(ctx: Ctx): AgentTool<any> {
  return {
    name: "writeResult",
    label: "Record comment verdict",
    description: "Record the verification verdict for one comment (upsert by comment number).",
    parameters: Type.Object({
      commentNumber: Type.Integer(),
      verdict: Type.Union(VERDICTS.map((v) => Type.Literal(v))),
      evidence: Type.String({ minLength: 3, description: "Factual: quote the diff hunk or document text" }),
      note: Type.Optional(Type.String()),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const task = run.tasks.find((t) => t.taskId === ctx.task.taskId)!;
      if (!task.commentNumbers.includes(p.commentNumber)) {
        throw new GuardError(`Comment #${p.commentNumber} is not in scope of task ${task.taskId} (scope: ${task.commentNumbers.join(", ")})`);
      }
      const result: TaskResult = {
        commentNumber: p.commentNumber,
        verdict: p.verdict as Verdict,
        evidence: p.evidence,
        note: p.note,
        confidence: p.confidence,
      };
      const i = task.results.findIndex((r) => r.commentNumber === p.commentNumber);
      if (i >= 0) task.results[i] = result; else task.results.push(result);
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, task.taskId, { tool: "writeResult", accepted: result });
      return { content: text({ ok: true, commentNumber: p.commentNumber, verdict: p.verdict }), details: {} };
    },
  };
}

function writeValidation(ctx: Ctx): AgentTool<any> {
  return {
    name: "writeValidation",
    label: "Record layout finding",
    description: "Upsert a styling validation finding (id upsert).",
    parameters: Type.Object({
      id: Type.String(),
      ruleId: Type.String(),
      severity: Type.Union([Type.Literal("pass"), Type.Literal("warning"), Type.Literal("violation"), Type.Literal("not_applicable")]),
      location: Type.Optional(Type.String()),
      evidence: Type.String(),
      verdictReason: Type.String(),
      suggestedFix: Type.Optional(Type.String()),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const task = run.tasks.find((t) => t.taskId === ctx.task.taskId)!;
      const i = task.findings.findIndex((f) => f.id === p.id);
      if (i >= 0) task.findings[i] = p; else task.findings.push(p);
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, task.taskId, { tool: "writeValidation", accepted: p });
      return { content: text({ ok: true, findingId: p.id }), details: {} };
    },
  };
}

function completeTask(ctx: Ctx): AgentTool<any> {
  return {
    name: "completeTask",
    label: "Complete task (guarded)",
    description: "Mark the task complete. REJECTED unless every comment in scope has a writeResult.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const task = run.tasks.find((t) => t.taskId === ctx.task.taskId)!;
      const missing = task.commentNumbers.filter(
        (n) => !task.results.some((r) => r.commentNumber === n)
      );
      if (missing.length > 0) {
        const msg = `Guard: task ${task.taskId} cannot complete — comments without verdict: ${missing.join(", ")}. Call writeResult for each.`;
        ctx.store.logToolCall(run.runId, task.taskId, { tool: "completeTask", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {}, };
      }
      task.status = "done";
      task.note = p.note;
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, task.taskId, { tool: "completeTask", accepted: true });
      return { content: text({ ok: true, taskDone: task.taskId }), details: {}, terminate: true };
    },
  };
}

export function buildPlannerTools(ctx: Ctx): AgentTool<any>[] {
  const planTool: AgentTool<any> = {
    name: "writeTaskPlan",
    label: "Write task plan",
    description: "Create the complete task list for the run (one call, batched). Every comment number must appear in exactly one verify_comments task.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        title: Type.String(),
        commentNumbers: Type.Array(Type.Integer()),
      })),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const all = p.tasks.flatMap((t: any) => t.commentNumbers);
      const expected = run.comments.map((c) => c.number).sort((a, b) => a - b);
      const got = [...all].sort((a, b) => a - b);
      const valid =
        expected.length === got.length && expected.every((n, i) => n === got[i]) &&
        p.tasks.every((t: any) => t.commentNumbers.length <= 10);
      if (!valid) {
        const msg = `Guard: invalid plan — expected exactly the comment numbers [${expected.join(",")}] each in exactly one task, ≤10 per task; got [${got.join(",")}]`;
        ctx.store.logToolCall(run.runId, "PLAN", { tool: "writeTaskPlan", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {} };
      }
      run.tasks = p.tasks.map((t: any, i: number) => ({
        taskId: `T${i + 1}`,
        type: "verify_comments",
        title: t.title,
        commentNumbers: t.commentNumbers,
        status: "todo",
        results: [],
        findings: [],
      }));
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, "PLAN", { tool: "writeTaskPlan", accepted: p.tasks.length + " tasks" });
      return { content: text({ ok: true, tasksCreated: run.tasks.length }), details: {} };
    },
  };
  const complete: AgentTool<any> = {
    name: "completePlanning",
    label: "Complete planning (guarded)",
    description: "End the planning session. REJECTED unless the plan covers every comment exactly once.",
    parameters: Type.Object({ rationale: Type.Optional(Type.String()) }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const covered = run.tasks.flatMap((t) => t.commentNumbers).sort((a, b) => a - b);
      const expected = run.comments.map((c) => c.number).sort((a, b) => a - b);
      if (covered.length !== expected.length || covered.some((n, i) => n !== expected[i])) {
        const msg = "Guard: planning incomplete — call writeTaskPlan with a plan covering every comment exactly once.";
        ctx.store.logToolCall(run.runId, "PLAN", { tool: "completePlanning", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {} };
      }
      ctx.store.logToolCall(run.runId, "PLAN", { tool: "completePlanning", accepted: p.rationale ?? "" });
      return { content: text({ ok: true }), details: {}, terminate: true };
    },
  };
  return [planTool, complete];
}

/** Completion agent — runs ONCE after all task sessions (strictly sequential: plan → N tasks → completion). */
export function buildCompleterTools(ctx: Ctx): AgentTool<any>[] {
  const writeSummary: AgentTool<any> = {
    name: "writeRunSummary",
    label: "Write run summary",
    description: "Write the run summary for the QAM (a few sentences + attention list). Required before completeRun.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 10 }),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const open = run.tasks.filter((t) => t.status !== "done");
      if (open.length > 0) {
        const msg = `Guard: cannot summarize — tasks not done: ${open.map((t: any) => t.taskId).join(",")}`;
        ctx.store.logToolCall(run.runId, "DONE", { tool: "writeRunSummary", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {} };
      }
      run.completionSummary = p.summary;
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, "DONE", { tool: "writeRunSummary", accepted: p.summary });
      return { content: text({ ok: true }), details: {} };
    },
  };
  const completeRun: AgentTool<any> = {
    name: "completeRun",
    label: "Complete the run (guarded)",
    description: "End the completion session. REJECTED unless writeRunSummary was called first.",
    parameters: Type.Object({}),
    execute: async () => {
      const run = getRun(ctx);
      if (!run.completionSummary) {
        const msg = "Guard: no run summary yet — call writeRunSummary first.";
        ctx.store.logToolCall(run.runId, "DONE", { tool: "completeRun", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {} };
      }
      ctx.store.logToolCall(run.runId, "DONE", { tool: "completeRun", accepted: "" });
      return { content: text({ ok: true }), details: {}, terminate: true };
    },
  };
  return [writeSummary, completeRun];
}

export function buildVerifierTools(ctx: Ctx): AgentTool<any>[] {
  return [
    getOverview(ctx),
    getDiff(ctx),
    excerptTool(ctx, "before"),
    excerptTool(ctx, "after"),
    searchGlobal(ctx),
    writeResult(ctx),
    completeTask(ctx),
  ];
}

export function buildLayoutTools(ctx: Ctx): AgentTool<any>[] {
  return [getOverview(ctx), excerptTool(ctx, "after"), searchGlobal(ctx), writeValidation(ctx), completeTask(ctx)];
}
