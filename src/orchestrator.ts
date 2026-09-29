// Run orchestrator: deterministic task split (no planner agent), execution via agent
// sessions (one pi session per task), guards, auto-resume failed tasks, deterministic
// verdict rollup.
//
// DR-25: planning is no longer an agent job. Comments are chunked deterministically
// into verify_comments tasks of ≤10 comments (document order), and — when a ruleset
// was supplied at run start — validate_layout tasks are chunked deterministically
// from the non-[auto] rules. Identical inputs ⇒ identical task list, every time.

import type { Store } from "./store.js";
import type { Run, Task } from "./types.js";
import { buildCompleterTools, buildVerifierTools, buildLayoutTools } from "./agent/tools.js";
import {
  COMPLETER_SYSTEM_PROMPT,
  completerUserPrompt,
  VERIFIER_SYSTEM_PROMPT,
  verifierUserPrompt,
  LAYOUT_SYSTEM_PROMPT,
  layoutUserPrompt,
} from "./agent/prompts.js";
import { agentRules } from "./ruleset.js";
import { spawnAgent, type RuntimeConfig } from "./agent/runtime.js";
import { renderReport, rollupVerdict } from "./report.js";

const MAX_COMMENTS_PER_TASK = 10;
const MAX_RULES_PER_TASK = 6;
const MAX_RETRIES = 1;

/**
 * Deterministic split (DR-25): verify tasks = consecutive chunks of ≤10 comments in
 * document (register) order; layout tasks = consecutive chunks of ≤6 non-auto rules
 * from the snapshotted ruleset. Task ids: T1..Tn (verify), L1..Ln (layout).
 */
export function planTasksDeterministic(run: Run): void {
  const tasks: Task[] = [];
  const comments = [...run.comments].sort((a, b) => a.number - b.number);
  for (let i = 0; i < comments.length; i += MAX_COMMENTS_PER_TASK) {
    const nums = comments.slice(i, i + MAX_COMMENTS_PER_TASK).map((c) => c.number);
    tasks.push({
      taskId: `T${tasks.length + 1}`,
      type: "verify_comments",
      title: `Verify comments ${nums[0]}–${nums[nums.length - 1]}`,
      commentNumbers: nums,
      status: "todo",
      results: [],
      findings: [],
    });
  }
  if (run.ruleset) {
    const rules = agentRules(run.ruleset);
    for (let i = 0; i < rules.length; i += MAX_RULES_PER_TASK) {
      const chunk = rules.slice(i, i + MAX_RULES_PER_TASK);
      tasks.push({
        taskId: `L${tasks.filter((t) => t.type === "validate_layout").length + 1}`,
        type: "validate_layout",
        title: `Validate layout rules ${chunk[0].id}–${chunk[chunk.length - 1].id}`,
        commentNumbers: [],
        ruleIds: chunk.map((r) => r.id),
        status: "todo",
        results: [],
        findings: [],
      });
    }
  }
  run.tasks = tasks;
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

/** Rules in a layout task's scope, rendered XML (full body = authoring guidance). */
function rulesBlock(run: Run, task: Task): string {
  return (task.ruleIds ?? [])
    .map((id) => {
      const r = run.ruleset?.rules.find((x) => x.id === id);
      if (!r) return `<!-- rule ${id} missing from snapshot -->`;
      return [
        `<rule id="${r.id}">`,
        `  <statement>${r.statement}</statement>`,
        `  <guidance>${r.body.replace(/\s+/g, " ").trim().slice(0, 1200)}</guidance>`,
        `</rule>`,
      ].join("\n");
    })
    .join("\n");
}

export interface RunEvents {
  onSplit?: (verifyTasks: number, layoutTasks: number) => void;
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

  // ---- DETERMINISTIC SPLIT (DR-25: no planner agent — chunks of 10 comments /
  // 6 rules, constructed, never negotiated). Idempotent: an empty task list only. ----
  if (run.tasks.length === 0) {
    planTasksDeterministic(run);
    store.save(run);
    events.onSplit?.(
      run.tasks.filter((t) => t.type === "verify_comments").length,
      run.tasks.filter((t) => t.type === "validate_layout").length
    );
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
          const isLayout = task.type === "validate_layout";
          const tools = isLayout
            ? buildLayoutTools({ store, run, task })
            : buildVerifierTools({ store, run, task });
          const userPrompt = isLayout
            ? layoutUserPrompt({
                runSummary: `${run.summary.docSummaryAfter} · ${run.summary.hunkCount} diff hunks vs before-review`,
                taskTitle: `${task.title} (${task.taskId})`,
                rulesBlock: rulesBlock(run, task),
              })
            : verifierUserPrompt({
                runSummary: `${run.summary.docSummaryBefore} → ${run.summary.docSummaryAfter}; ${run.summary.hunkCount} diff hunks`,
                taskTitle: `${task.title} (${task.taskId})`,
                commentsBlock: commentsBlock(run, task),
              });
          const outcome = await spawnAgent({
            systemPrompt: isLayout ? LAYOUT_SYSTEM_PROMPT : VERIFIER_SYSTEM_PROMPT,
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
  const findingLines = run.tasks.flatMap((t) =>
    t.findings.map((f) => `${f.ruleId} ${f.severity}${f.location ? ` @ ${f.location}` : ""}`)
  );
  const completionOutcome = await spawnAgent({
    systemPrompt: COMPLETER_SYSTEM_PROMPT,
    userPrompt: completerUserPrompt({ verdictsBlock: [...verdictLines, ...findingLines].join("\n") }),
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
