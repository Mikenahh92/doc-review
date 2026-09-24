// Pre-pass entry point: build the complete run snapshot from the three inputs. No LLM anywhere.

import { parseDocx } from "./docx.js";
import { parseMarkdown } from "./markdown.js";
import { parsePdf } from "./pdf.js";
import { assertExportScope, parseRegister } from "./register.js";
import { diffDocs } from "./diff.js";
import { anchorComments } from "./anchor.js";
import type { CommentRecord, Finding, ParsedDoc, Run, RunSummary } from "../types.js";
import { randomUUID } from "node:crypto";

const BLOCKS_PER_PAGE = 45; // heuristic for page attribution

function docSummary(doc: ParsedDoc): string {
  const headings = doc.blocks.filter((b) => b.type === "heading").length;
  const tables = doc.blocks.filter((b) => b.type === "table").length;
  return (
    `${doc.fileName} · ~${Math.max(1, Math.ceil(doc.blocks.length / BLOCKS_PER_PAGE))} pages (est.) · ` +
    `${doc.blocks.length} blocks (${headings} headings, ${tables} tables)`
  );
}

/** DOC-* [auto] checks — deterministic findings, code-checked, never judged by an agent. */
function autoDocChecks(before: ParsedDoc, after: ParsedDoc): Finding[] {
  const findings: Finding[] = [];
  // DOC-2 (prototype): after-doc must contain MORE non-empty content than before
  // (a real implementation reads revision numbers from footers — see architecture doc DOC-2).
  if (after.blocks.length < before.blocks.length - 2) {
    findings.push({
      id: "AUTO-DOC-2",
      ruleId: "DOC-2",
      severity: "violation",
      evidence: `before has ${before.blocks.length} blocks, after has ${after.blocks.length}`,
      verdictReason: "after-review document appears smaller than before-review document (revision check placeholder)",
      suggestedFix: "Verify the correct after-review document was supplied",
      confidence: "high",
    });
  }
  return findings;
}

export async function buildRun(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  registerBuffer: Buffer,
  fileNames: { before: string; after: string; register: string }
): Promise<{ run: Run; warnings: string[] }> {
  const parse = async (name: string, buf: Buffer) => {
    if (name.toLowerCase().endsWith(".md")) return parseMarkdown(name, buf);
    if (name.toLowerCase().endsWith(".pdf")) return parsePdf(name, buf);
    return parseDocx(name, buf);
  };
  const before = await parse(fileNames.before, beforeBuffer);
  const after = await parse(fileNames.after, afterBuffer);
  const comments = parseRegister(registerBuffer);
  const warnings = assertExportScope(comments);
  const diff = diffDocs(before, after);
  const anchors = anchorComments(comments, before);

  const summary: RunSummary = {
    docSummaryBefore: docSummary(before),
    docSummaryAfter: docSummary(after),
    blockCountBefore: before.blocks.length,
    blockCountAfter: after.blocks.length,
    hunkCount: diff.length,
    commentCount: comments.length,
    anchoredCount: anchors.filter((a) => a.anchorIndex !== null).length,
  };

  const run: Run = {
    runId: `R${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    status: "planned",
    before,
    after,
    diff,
    comments,
    anchors,
    summary,
    autoChecks: autoDocChecks(before, after),
    tasks: [],
    verdict: null,
  };
  return { run, warnings };
}

export type { CommentRecord };
