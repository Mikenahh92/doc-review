// Tool bridge: pi AgentTool definitions whose execute() calls straight into the backend app API.
// Tools are thin and dumb on purpose; validation and state writes live in the app (guards).

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Store } from "../store.js";
import type { Run, Task, TaskResult, Verdict } from "../types.js";
import { GuardError, VERDICTS } from "../types.js";

const text = (obj: unknown) => [{ type: "text" as const, text: JSON.stringify(obj, null, 1) }];
const xml = (s: string) => [{ type: "text" as const, text: s }];

/** XML attribute escaping + single-line flattening for prose bodies. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** Progress hint block appended to getOverview (spec §7). No planning phase — tasks always exist at session time. */
function nextBlock(run: Run): string {
  const open = run.tasks.filter((t) => t.status !== "done");
  const phase = open.length > 0 ? "tasks" : "completion";
  const perTask = open.map((t) => {
    const rem = t.commentNumbers.filter((n) => !t.results.some((r) => r.commentNumber === n)).length;
    return `${t.taskId}: ${rem === 0 ? "ready to complete" : `${rem} of ${t.commentNumbers.length} comments left`}`;
  });
  return `<next phase="${phase}" openTasks="${open.length}">${esc(perTask.join(" · ") || "all tasks done")}</next>`;
}

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
      const payload = {
          before: run.summary.docSummaryBefore,
          after: run.summary.docSummaryAfter,
          diffHunks: run.summary.hunkCount,
          comments: run.comments.map((c) => ({ number: c.number, page: c.page, location: c.locationType, locationNumber: c.locationNumber })),
          anchors: run.anchors,
      };
      return { content: xml(JSON.stringify(payload, null, 1) + "\n" + nextBlock(run)), details: {} };
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
      const a = anchor
        ? ` anchor="${anchor.anchorIndex ?? "none"}" method="${anchor.method}"`
        : "";
      if (!hunks.length) {
        return {
          content: xml(`<diff comment="${p.commentNumber}" hunks="0"${a}>no diff hunks near this anchor</diff>`),
          details: { hunkCount: 0 },
        };
      }
      const body = hunks
        .map((h) => {
          const b = h.beforeIndex !== undefined ? ` before="${h.beforeIndex}"` : "";
          const f = h.afterIndex !== undefined ? ` after="${h.afterIndex}"` : "";
          return `  <hunk id="${esc(h.id)}" kind="${h.kind}"${b}${f}>\n    BEFORE: ${one(h.beforeText ?? "—")}\n    AFTER:  ${one(h.afterText ?? "—")}\n  </hunk>`;
        })
        .join("\n");
      return {
        content: xml(`<diff comment="${p.commentNumber}" hunks="${hunks.length}"${a}>\n${body}\n</diff>`),
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
          content: xml(`<excerpt comment="${p.commentNumber}">anchoring failed — return needs_user for this comment</excerpt>`),
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
      const rows = excerpt(blocks, center, p.radius ?? 2)
        .map((b) => `  [block ${b.index} | ${b.type}] ${one(b.text)}`)
        .join("\n");
      return {
        content: xml(`<excerpt comment="${p.commentNumber}" doc="${which}" radius="${p.radius ?? 2}" center="${center}">\n${rows}\n</excerpt>`),
        details: {},
      };
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
      const matches = [...hits("before", run.before.blocks), ...hits("after", run.after.blocks)];
      const rows = matches.map((m) => `  [${m.doc} #${m.index} | ${m.type}] ${one(m.text)}`).join("\n");
      return {
        content: xml(`<search query="${esc(p.query)}" matches="${matches.length}">\n${rows}\n</search>`),
        details: {},
      };
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
      // progress hint (spec §7): what remains in this task's scope
      const missing = task.commentNumbers.filter((n) => !task.results.some((r) => r.commentNumber === n));
      return {
        content: text({
          ok: true, commentNumber: p.commentNumber, verdict: p.verdict,
          progress: { task: task.taskId, recorded: task.results.length, remaining: missing.length, missing },
        }),
        details: {},
      };
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
      const missing = task.commentNumbers.filter((n) => !task.results.some((r) => r.commentNumber === n));
      if (missing.length > 0) {
        const msg = `Guard: task ${task.taskId} cannot complete — comments without verdict: ${missing.join(", ")}. Call writeResult for each.`;
        ctx.store.logToolCall(run.runId, task.taskId, { tool: "completeTask", rejected: msg });
        // error + next action (spec §7)
        return { content: text({ ok: false, error: msg, next: `call writeResult for #${missing[0]} next` }), details: {}, };
      }
      task.status = "done";
      task.note = p.note;
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, task.taskId, { tool: "completeTask", accepted: true });
      return { content: text({ ok: true, taskDone: task.taskId }), details: {}, terminate: true };
    },
  };
}

/** Completion agent — runs ONCE after all task sessions (strictly sequential: split → N tasks → completion). */
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
      return { content: text({ ok: true, next: "call completeRun to finish" }), details: {} };
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

