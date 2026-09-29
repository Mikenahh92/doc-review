// Core domain types — kept runtime-agnostic (nothing here knows about pi).

export type Verdict =
  | "correctly_applied"
  | "incorrectly_applied"
  | "missing"
  | "needs_user";

export const VERDICTS: Verdict[] = [
  "correctly_applied",
  "incorrectly_applied",
  "missing",
  "needs_user",
];

export type Severity = "pass" | "warning" | "violation" | "not_applicable";

/** A normalized comment row from the register (pre-filtered: accepted + processed=yes). */
export interface CommentRecord {
  number: number;            // Comment_ID
  documentTitle: string;
  page: number;              // may be 0 by mistake
  locationType: string;      // Line | Requirement | Figure | Table | Paragraph | Area
  locationNumber: number;    // ordinal of that element type
  comment: string;
  commentType: string;       // meeting | author
  replyByAuthor: string;
  externalReply: string;
  externalParticipant: string;
  participant: string;
  status: string;            // accepted (guaranteed by export scope)
  processed: string;         // yes (guaranteed by export scope)
}

/** One structural block of a parsed document (paragraph, table, heading). */
export interface DocBlock {
  index: number;             // position in document order
  type: "paragraph" | "table" | "heading";
  text: string;
  pageEstimate: number;      // rough page attribution (blocks/45 heuristic)
}

export interface ParsedDoc {
  fileName: string;
  blocks: DocBlock[];
}

/** Aligned diff hunk between before/after documents. */
export interface DiffHunk {
  id: string;
  kind: "changed" | "added" | "removed";
  beforeIndex?: number;      // block index in before-doc
  afterIndex?: number;       // block index in after-doc
  beforeText?: string;
  afterText?: string;
}

export interface CommentAnchor {
  commentNumber: number;
  anchorIndex: number | null; // block index in before-doc; null = unanchorable
  method: "location" | "content" | "failed";
}

export interface TaskResult {
  commentNumber: number;
  verdict: Verdict;
  evidence: string;
  note?: string;
  confidence: "high" | "medium" | "low";
}

export interface Finding {
  id: string;
  ruleId: string;
  severity: Severity;
  page?: number;
  location?: string;
  evidence: string;
  verdictReason: string;
  suggestedFix?: string;
  confidence: "high" | "medium" | "low";
}

export type TaskType = "verify_comments" | "validate_layout";

/** One styling rule parsed from a ruleset markdown file (`## ID: statement`). */
export interface Rule {
  id: string;           // e.g. "TBL-3"
  statement: string;    // rule statement from the heading
  body: string;         // explanation / examples / edge cases below the heading
  auto: boolean;        // [auto] = deterministic pre-pass rule; not re-judged by the layout agent
}

/** A parsed ruleset, snapshotted verbatim into the run at start. */
export interface Ruleset {
  name: string;
  version: string;
  sourceMarkdown: string; // verbatim snapshot — audit trail, reproducibility
  rules: Rule[];
}

export interface Task {
  taskId: string;
  type: TaskType;
  title: string;
  commentNumbers: number[];
  ruleIds?: string[];
  status: "todo" | "in_progress" | "done" | "blocked";
  results: TaskResult[];
  findings: Finding[];
  note?: string;
}

export interface RunSummary {
  docSummaryBefore: string;
  docSummaryAfter: string;
  blockCountBefore: number;
  blockCountAfter: number;
  hunkCount: number;
  commentCount: number;
  anchoredCount: number;
}

export interface Run {
  runId: string;
  createdAt: string;
  status: "planned" | "running" | "done" | "failed";
  before: ParsedDoc;
  after: ParsedDoc;
  diff: DiffHunk[];
  comments: CommentRecord[];
  anchors: CommentAnchor[];
  ruleset: Ruleset | null;   // snapshot of the ruleset selected at run start (null = none supplied)
  summary: RunSummary;
  autoChecks: Finding[];     // [auto] rule results (DOC-*) — deterministic
  tasks: Task[];
  verdict: string | null;    // deterministic rollup, set at completion
  completionSummary?: string; // written by the completion agent (1 session, after all tasks)
}

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}
