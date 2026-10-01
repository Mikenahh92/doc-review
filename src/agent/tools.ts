// Tool bridge: pi AgentTool definitions whose execute() calls straight into the backend app API.
// Tools are thin and dumb on purpose; validation and state writes live in the app (guards).

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Store } from "../store.js";
import { anchorMethodCounts } from "../prepass/anchor.js";
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

function getChunk(ctx: Ctx): AgentTool<any> {
  return {
    name: "getChunk",
    label: "Read document blocks by page",
    description: `Read blocks of the before- or after-review document on a given PAGE. Pages are the stable identity: PDF parsing stamps real page numbers, and markdown converted from PDF keeps page markers. start/count select consecutive blocks WITHIN that page (start is an offset in the page, 0-based). The comment's anchor/register page is a hint where to start — a comment may apply to other pages too.`,
    parameters: Type.Object({
      doc: Type.Union([Type.Literal("before"), Type.Literal("after")], { description: "Which document to read" }),
      page: Type.Integer({ minimum: 1, description: "Page number" }),
      start: Type.Optional(Type.Integer({ default: 0, minimum: 0, description: "Offset of the first block within the page" })),
      count: Type.Optional(Type.Integer({ default: 10, minimum: 1, maximum: 30 })),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const blocks = p.doc === "before" ? run.before.blocks : run.after.blocks;
      const onPage = blocks.filter((b) => b.pageEstimate === p.page);
      const totalPages = Math.max(...blocks.map((b) => b.pageEstimate));
      if (!onPage.length) {
        return {
          content: xml(`<chunk doc="${p.doc}" page="${p.page}" blocks="0" pages="${totalPages}">no blocks on this page — valid pages are 1..${totalPages}</chunk>`),
          details: {},
        };
      }
      const slice = onPage.slice(p.start ?? 0, (p.start ?? 0) + (p.count ?? 10));
      const rows = slice
        .map((b) => `  [block ${b.index} | ${b.type}] ${one(b.text)}`)
        .join("\n");
      return {
        content: xml(`<chunk doc="${p.doc}" page="${p.page}" pageBlocks="${onPage.length}" offset="${p.start ?? 0}" pages="${totalPages}">\n${rows}\n</chunk>`),
        details: {},
      };
    },
  };
}

function searchGlobal(ctx: Ctx): AgentTool<any> {
  return {
    name: "searchGlobal",
    label: "Search both documents",
    description: "Search a text fragment across BOTH documents; returns matches with document, page, and block index — use the page with getChunk.",
    parameters: Type.Object({ query: Type.String({ minLength: 3 }) }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const q = p.query.toLowerCase();
      const hits = (doc: string, blocks: Run["before"]["blocks"]) =>
        blocks.filter((b) => b.text.toLowerCase().includes(q)).slice(0, 5)
          .map((b) => ({ doc, index: b.index, page: b.pageEstimate, type: b.type, text: b.text.slice(0, 200) }));
      const matches = [...hits("before", run.before.blocks), ...hits("after", run.after.blocks)];
      const rows = matches.map((m) => `  [${m.doc} p.${m.page} #${m.index} | ${m.type}] ${one(m.text)}`).join("\n");
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
    getChunk(ctx),
    searchGlobal(ctx),
    writeResult(ctx),
    completeTask(ctx),
  ];
}


// ---- Anchor resolver tools (DR-27) ----
// One bounded session BEFORE the task split, for comments the deterministic
// cascade could not anchor. pickAnchor validates and persists; completeAnchoring
// is guarded. Anchor provenance rides into the run (method "llm").

function pickAnchor(ctx: Ctx): AgentTool<any> {
  return {
    name: "pickAnchor",
    label: "Anchor a comment",
    description: "Record which block of the BEFORE document an unresolved comment refers to (or mark it unresolvable).",
    parameters: Type.Object({
      commentNumber: Type.Integer({ description: "Comment number from the register" }),
      blockIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Block index in the before document" })),
      unresolvable: Type.Optional(Type.Boolean({ description: "True when the location cannot be determined — the comment becomes needs_user" })),
      evidence: Type.String({ description: "The matching text (or why it is unresolvable)" }),
    }),
    execute: async (_id, p: any) => {
      const run = getRun(ctx);
      const anchor = run.anchors.find((a) => a.commentNumber === p.commentNumber);
      if (!anchor) throw new GuardError(`comment #${p.commentNumber} has no anchor record`);
      if (anchor.anchorIndex !== null || anchor.note) {
        return { content: text({ ok: false, error: `comment #${p.commentNumber} is already resolved (${anchor.method})` }), details: {} };
      }
      if (p.unresolvable) {
        anchor.method = "failed";
        anchor.note = `llm-unresolvable: ${p.evidence}`;
        run.summary.anchoredCount = run.anchors.filter((a) => a.anchorIndex !== null).length;
        run.summary.anchorMethods = anchorMethodCounts(run.anchors);
        ctx.store.save(run);
        ctx.store.logToolCall(run.runId, "ANCHOR", { tool: "pickAnchor", comment: p.commentNumber, unresolvable: p.evidence });
        return { content: text({ ok: true, comment: p.commentNumber, resolved: "unresolvable" }), details: {} };
      }
      const block = run.before.blocks.find((b) => b.index === p.blockIndex);
      if (!block) {
        return { content: text({ ok: false, error: `blockIndex ${p.blockIndex} out of range (0..${run.before.blocks.length - 1})` }), details: {} };
      }
      anchor.anchorIndex = block.index;
      anchor.method = "llm";
      anchor.note = p.evidence;
      run.summary.anchoredCount = run.anchors.filter((a) => a.anchorIndex !== null).length;
      run.summary.anchorMethods = anchorMethodCounts(run.anchors);
      ctx.store.save(run);
      ctx.store.logToolCall(run.runId, "ANCHOR", { tool: "pickAnchor", comment: p.commentNumber, block: block.index, evidence: p.evidence });
      return { content: text({ ok: true, comment: p.commentNumber, anchoredAt: block.index }), details: {} };
    },
  };
}

function completeAnchoring(ctx: Ctx): AgentTool<any> {
  return {
    name: "completeAnchoring",
    label: "Complete anchoring (guarded)",
    description: "End the resolver session. REJECTED while unresolved comments remain.",
    parameters: Type.Object({}),
    execute: async () => {
      const run = getRun(ctx);
      const pending = run.anchors.filter((a) => a.anchorIndex === null && !a.note);
      if (pending.length > 0) {
        const msg = `Guard: ${pending.length} comment(s) still unresolved: ${pending.map((a) => `#${a.commentNumber}`).join(", ")}. Call pickAnchor (or unresolvable) for each.`;
        ctx.store.logToolCall(run.runId, "ANCHOR", { tool: "completeAnchoring", rejected: msg });
        return { content: text({ ok: false, error: msg }), details: {} };
      }
      return { content: text({ ok: true }), details: {}, terminate: true };
    },
  };
}

export function buildAnchorTools(ctx: Ctx): AgentTool<any>[] {
  return [searchGlobal(ctx), pickAnchor(ctx), completeAnchoring(ctx)];
}
