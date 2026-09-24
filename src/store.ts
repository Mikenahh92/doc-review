// Run state store — in-memory + JSON persistence + per-task tool-call transcript (JSONL).
// App is the source of truth; the agent runtime never writes state directly.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Run } from "./types.js";

const RUNS_DIR = process.env.RUNS_DIR ?? path.join(process.cwd(), "runs");

export class Store {
  private runs = new Map<string, Run>();

  constructor(dir: string = RUNS_DIR) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }
  private dir: string;

  /** Directory where run state, transcripts and reports live. */
  get runsDir(): string {
    return this.dir;
  }

  save(run: Run): void {
    this.runs.set(run.runId, run);
    // full snapshot persisted (blocks included) so runs survive container restarts
    const tmp = path.join(this.dir, `${run.runId}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(run));
    fs.renameSync(tmp, path.join(this.dir, `${run.runId}.json`));
  }

  /** Load all persisted runs back into memory (container restart). */
  load(): number {
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json") || f.includes(".")) continue;
      if (!/^R[\w-]+\.json$/.test(f)) continue;
      try {
        const run: Run = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        // a run interrupted mid-flight restarts as failed-but-inspectable
        if (run.status === "running" || run.status === "planned") run.status = "failed";
        this.runs.set(run.runId, run);
        n++;
      } catch { /* skip corrupt */ }
    }
    return n;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  list(): Run[] {
    return [...this.runs.values()];
  }

  /** Append a JSONL line to the per-task transcript (audit trail). */
  logToolCall(runId: string, taskId: string, entry: object): void {
    const file = path.join(this.dir, `${runId}.${taskId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  transcriptPath(runId: string, taskId: string): string {
    return path.join(this.dir, `${runId}.${taskId}.jsonl`);
  }
}
