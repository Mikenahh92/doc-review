// Run orchestrator: plan tasks deterministically, execute via agent sessions (one pi session
// per task), enforce guards, auto-resume failed tasks once, deterministic verdict rollup.

import type { Store } from "./store.js";
import type { Run, Task } from "./types.js";
import { buildCompleterTools, buildPlannerTools, buildVerifierTools } from "./agent/tools.js";
import {
  COMPLETER_SYSTEM_PROMPT,
  completerUserPrompt,
  PLANNER_SYSTEM_PROMPT,
  plannerUserPrompt,
  VERIFIER_SYSTEM_PROMPT,
  verifierUserPrompt,
} from "./agent/prompts.js";
import { spawnAgent, type RuntimeConfig } from "./agent/runtime.js";
import { renderReport, rollupVerdict } from "./report.js";

const MAX_COMMENTS_PER_TASK = 10;
const MAX_RETRIES = 1;

/** Deterministic fallback if the planner agent fails to produce a valid plan. */
export function planTasksDeterministic(run: Run): void {
  const groups: number[][] = [];
  for (let i = 0; i < run.comments.length; i += MAX_COMMENTS_PER_TASK) {
    groups.push(run.comments.slice(i, i + MAX_COMMENTS_PER_TASK).map((c) => c.number));
  }
  run.tasks = groups.map((nums, i) => ({
    taskId: `T${i + 1}`,
    type: "verify_comments",
    title: `Verify comments ${nums[0]}–${nums[nums.length - 1]}`,
    commentNumbers: nums,
    status: "todo",
    results: [],
    findings: [],
  }));
  run.status = "planned";
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
        `  <anchor method="${a.method}" block_index="${a.anchorIndex ?? "null"}"/>`,
        `</comment>`,
      ].join("\n");
    })
    .join("\n");
}

export interface RunEvents {
  onPlanStart?: () => void;
  onPlanDone?: (taskCount: number, toolCalls: number, by: "planner" | "fallback") => void;
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

  // DR-10: sessions are per-part now (planner / each verify task / completer) so that
  // verify tasks can run in parallel without sharing mutable transcript state.

  // ---- PLANNING part (planner system prompt) ----
  if (run.tasks.length === 0) {
    events.onPlanStart?.();
    const plannerTools = buildPlannerTools({ store, run, task: null as any });
    const cBlock = run.comments
      .map((c) => {
        const a = run.anchors.find((x) => x.commentNumber === c.number)!;
        return `#${c.number} page ${c.page} ${c.locationType}#${c.locationNumber}: ${c.comment.slice(0, 80)}`;
      })
      .join("\n");
    const planOutcome = await spawnAgent({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: plannerUserPrompt({
        runSummary: `${run.summary.docSummaryBefore} → ${run.summary.docSummaryAfter}; ${run.summary.hunkCount} diff hunks; ${run.comments.length} comments`,
        commentsBlock: cBlock,
      }),
      tools: plannerTools,
      config,
      onToolCall: (name, args) => store.logToolCall(run.runId, "PLAN", { tool: name, args }),
    });
    if (run.tasks.length > 0) {
      events.onPlanDone?.(run.tasks.length, planOutcome.toolCallsMade, "planner");
    } else {
      // auto-resume the plan: deterministic fallback, logged loudly
      planTasksDeterministic(run);
      store.save(run);
      events.onPlanDone?.(run.tasks.length, 0, "fallback");
    }
  }

  // ---- TASK parts (DR-10: parallel worker pool — one FRESH session per task) ----
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

  // ---- COMPLETION part (completer system prompt — same session resumed one last time) ----
  events.onCompleteStart?.();
  const completerTools = buildCompleterTools({ store, run, task: null as any });
  const verdictsBlock = run.tasks
    .flatMap((t) => t.results)
    .map((r) => `#${r.commentNumber} ${r.verdict}${r.confidence ? " (" + r.confidence + ")" : ""}`)
    .join("\n");
  const completionOutcome = await spawnAgent({
    systemPrompt: COMPLETER_SYSTEM_PROMPT,
    userPrompt: completerUserPrompt({ verdictsBlock }),
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
