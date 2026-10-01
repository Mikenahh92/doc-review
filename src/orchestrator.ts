// Run orchestrator: deterministic task split (no planner agent), execution via agent
// sessions (one pi session per task), guards, auto-resume failed tasks, deterministic
// verdict rollup.
//
// DR-26: planning is deterministic code only — verify_comments tasks of ≤10 comments
// in register order. No planner agent, no styling/layout validation (out of scope).

import type { Store } from "./store.js";
import type { Run, Task } from "./types.js";
import { buildCompleterTools, buildVerifierTools, buildAnchorTools } from "./agent/tools.js";
import {
  COMPLETER_SYSTEM_PROMPT,
  completerUserPrompt,
  VERIFIER_SYSTEM_PROMPT,
  verifierUserPrompt,
  ANCHOR_RESOLVER_SYSTEM_PROMPT,
  resolverUserPrompt,
} from "./agent/prompts.js";
import { spawnAgent, type RuntimeConfig } from "./agent/runtime.js";
import { renderReport, rollupVerdict } from "./report.js";

const MAX_COMMENTS_PER_TASK = 10;
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MAX_RETRIES = 1;

/**
 * Deterministic split: verify tasks = consecutive chunks of ≤10 comments in
 * document (register) order. Task ids: T1..Tn.
 */
export function planTasksDeterministic(run: Run): void {
  const tasks: Task[] = [];
  const comments = [...run.comments].sort((a, b) => a.number - b.number);
  for (let i = 0; i < comments.length; i += MAX_COMMENTS_PER_TASK) {
    const nums = comments.slice(i, i + MAX_COMMENTS_PER_TASK).map((c) => c.number);
    tasks.push({
      taskId: `T${tasks.length + 1}`,
      title: `Verify comments ${nums[0]}–${nums[nums.length - 1]}`,
      commentNumbers: nums,
      status: "todo",
      results: [],
    });
  }
  run.tasks = tasks;
  run.status = "planned";
}

/** Compact per-page index of one document: "p.N (blocks X–Y, count) · first heading or preview". */
function docPageIndex(label: string, blocks: Run["before"]["blocks"]): string {
  const byPage = new Map<number, Run["before"]["blocks"]>();
  for (const b of blocks) {
    const list = byPage.get(b.pageEstimate) ?? ([] as any);
    list.push(b);
    byPage.set(b.pageEstimate, list as any);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const lines = pages.map((p) => {
    const list = byPage.get(p)!;
    const heading = list.find((b) => b.type === "heading");
    const preview = heading
      ? `H: ${heading.text.slice(0, 70)}`
      : list[0].text.slice(0, 70);
    return `p.${p} (${list.length} blk, #${list[0].index}–#${list[list.length - 1].index}): ${preview}`;
  });
  return `<index doc="${label}" pages="${pages.length}" blocks="${blocks.length}">\n${lines.join("\n")}\n</index>`;
}

function commentsBlock(run: Run, task: Task): string {
  return task.commentNumbers
    .map((n) => {
      const c = run.comments.find((x) => x.number === n)!;
      const a = run.anchors.find((x) => x.commentNumber === n)!;
      return [
        `<comment number="${c.number}" page="${c.page}" location="${c.locationType}" location_number="${c.locationNumber}" type="${c.commentType}" status="${c.status}" processed="${c.processed}">`,
        `  <text>${c.comment}</text>`,
        `  <reply_by_author>${c.replyByAuthor || "(blank — deduce intent from comment)"}</reply_by_author>`,
        `  <anchor method="${a.method}" block_index="${a.anchorIndex ?? "null"}"${a.sectionEnd !== undefined ? ` section_end="${a.sectionEnd}"` : ""}${a.note ? ` note="${esc(a.note)}"` : ""}/>`,
        `</comment>`,
      ].join("\n");
    })
    .join("\n");
}

export interface RunEvents {
  onAnchorStart?: (pending: number) => void;
  onAnchorDone?: (llmAnchored: number, toolCalls: number) => void;
  onSplit?: (verifyTasks: number) => void;
  onTaskStart?: (taskId: string) => void;
  onTaskDone?: (taskId: string, toolCalls: number) => void;
  onTaskRetry?: (taskId: string, reason: string) => void;
  onCompleteStart?: () => void;
  onCompleteDone?: (toolCalls: number, by: "completer" | "fallback") => void;
}

export async function executeRun(
  store: Store,
  run: Run,
  config: RuntimeConfig,
  events: RunEvents = {}
): Promise<Run> {
  run.status = "running";
  store.save(run);

  // ---- ANCHOR RESOLUTION (DR-27): bounded LLM fallback for comments the
  // deterministic cascade (heading map / TOC / content / diff match) could not
  // anchor. Runs ONCE, before the split; pickAnchor is validated + persisted. ----
  const pendingAnchors = run.anchors.filter((a) => a.anchorIndex === null && !a.note);
  if (pendingAnchors.length > 0) {
    events.onAnchorStart?.(pendingAnchors.length);
    const unresolvedBlock = pendingAnchors
      .map((a) => {
        const c = run.comments.find((x) => x.number === a.commentNumber)!;
        return [
          `<comment number="${c.number}" page="${c.page}" location="${c.locationType}" location_number="${c.locationNumber || "(none)"}">`,
          `  <text>${c.comment}</text>`,
          `  <reply_by_author>${c.replyByAuthor || "(blank — deduce intent from comment)"}</reply_by_author>`,
          `</comment>`,
        ].join("\n");
      })
      .join("\n");
    const anchorOutcome = await spawnAgent({
      systemPrompt: ANCHOR_RESOLVER_SYSTEM_PROMPT,
      userPrompt: resolverUserPrompt({
        runSummary: `${run.summary.docSummaryBefore} · ${run.before.blocks.length} blocks · ${run.summary.hunkCount} diff hunks vs after`,
        unresolvedBlock,
      }),
      tools: buildAnchorTools({ store, run, task: null as any }),
      config,
      onToolCall: (name, args) => store.logToolCall(run.runId, "ANCHOR", { tool: name, args }),
    });
    events.onAnchorDone?.(
      run.anchors.filter((a) => a.method === "llm").length,
      anchorOutcome.toolCallsMade
    );
    store.save(run);
  }

  // ---- DETERMINISTIC SPLIT (verify chunks of ≤10 comments, constructed,
  // never negotiated). Idempotent: fills an empty task list only. ----
  if (run.tasks.length === 0) {
    planTasksDeterministic(run);
    store.save(run);
    events.onSplit?.(run.tasks.length);
  }

  // ---- TASK parts (parallel worker pool — one FRESH session per task) ----
  const concurrency = Math.max(1, config.concurrency ?? 1);
  const maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  const queue = [...run.tasks];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (;;) {
        const task = queue.shift();
        if (!task) return;
        let attempts = 0;
        while (task.status !== "done" && attempts < maxAttempts) {
          attempts++;
          task.status = "in_progress";
          store.save(run);
          events.onTaskStart?.(task.taskId);
          const tools = buildVerifierTools({ store, run, task });
          const userPrompt = verifierUserPrompt({
            runSummary: `${run.summary.docSummaryBefore} → ${run.summary.docSummaryAfter}; ${run.summary.hunkCount} diff hunks`,
            taskTitle: `${task.title} (${task.taskId})`,
            docIndexes: `${docPageIndex("before", run.before.blocks)}\n${docPageIndex("after", run.after.blocks)}`,
            commentsBlock: commentsBlock(run, task),
          });
          const outcome = await spawnAgent({
            systemPrompt: VERIFIER_SYSTEM_PROMPT,
            userPrompt,
            tools,
            config,
            onToolCall: (name, args) =>
              store.logToolCall(run.runId, task.taskId, { tool: name, args }),
          });
          if ((task.status as string) === "done") {
            events.onTaskDone?.(task.taskId, outcome.toolCallsMade);
            break;
          }
          if (attempts >= maxAttempts) {
            const reason = outcome.error ?? `task not completed (last text: ${outcome.lastText.slice(0, 120)})`;
            store.logToolCall(run.runId, task.taskId, { tool: "__exhausted", reason });
            task.status = "blocked";
            task.note = reason;
            store.save(run);
          } else {
            const reason = outcome.error ?? `task not completed (last text: ${outcome.lastText.slice(0, 120)})`;
            events.onTaskRetry?.(task.taskId, reason);
            task.status = "todo";
            store.save(run);
          }
        }
      }
    })
  );
  if (run.tasks.some((t) => t.status === "blocked")) {
    run.status = "failed";
    store.save(run);
    return run;
  }

  // ---- COMPLETION part (completer system prompt — runs once after all tasks) ----
  events.onCompleteStart?.();
  const completerTools = buildCompleterTools({ store, run, task: null as any });
  const verdictLines = run.tasks.flatMap((t) =>
    t.results.map((r) => `#${r.commentNumber} ${r.verdict}${r.confidence ? ` (${r.confidence})` : ""}`)
  );
  const completionOutcome = await spawnAgent({
    systemPrompt: COMPLETER_SYSTEM_PROMPT,
    userPrompt: completerUserPrompt({ verdictsBlock: verdictLines.join("\n") }),
    tools: completerTools,
    config,
    onToolCall: (name, args) => store.logToolCall(run.runId, "DONE", { tool: name, args }),
  });
  if (run.completionSummary) {
    events.onCompleteDone?.(completionOutcome.toolCallsMade, "completer");
  } else {
    run.completionSummary = `Fallback summary: ${run.tasks.flatMap((t) => t.results).length} verdicts collected; see report for details.`;
    store.save(run);
    events.onCompleteDone?.(0, "fallback");
  }

  run.verdict = rollupVerdict(run);
  run.status = "done";
  store.save(run);
  renderReport(store, run);
  return run;
}
