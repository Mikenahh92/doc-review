// Comment anchoring (DR-27): resolve each register row to a block index in the
// BEFORE document via a deterministic cascade. LLM fallback lives in the
// orchestrator (one bounded resolver session) — this module never calls a model.
//
// Cascade:
//   Tier 1a  section number in the heading map ("6.2") → heading block; tables
//            inside the section resolve to the first table block
//   Tier 1b  plain integer location number on docs WITHOUT numbered headings
//            → ordinal among blocks of that location type (legacy behaviour)
//   Tier 2a  content match: distinctive fragments of comment/reply against
//            before-doc text (skipping the TOC region)
//   Tier 2b  diff match: distinctive tokens shared with a diff hunk's afterText
//            (the applied change often contains the reviewer's wording)
//   Tier 4   unresolved → anchorIndex null, method "failed" (LLM resolver runs
//            later; survivors become needs_user — never guess)

import type { CommentAnchor, CommentRecord, DiffHunk, ParsedDoc } from "../types.js";
import { buildHeadingMap, parseToc, sectionRange } from "./headings.js";

function typeMatch(locationType: string, blockType: string): boolean {
  const lt = locationType.toLowerCase();
  if (blockType === "table") return lt === "table" || lt === "area";
  if (blockType === "heading") return false;
  return lt === "paragraph" || lt === "line" || lt === "requirement";
}

/** Document frequency of a token across before-blocks + diff afterTexts.
 *  Diff matching only trusts RARE tokens: "thermal monitor" appears in hundreds
 *  of blocks — a shared hit proves nothing. Unique-ish tokens (≤3 occurrences)
 *  actually identify a location (DR-28). */
const STOP = new Set([
  "this", "that", "with", "from", "shall", "must", "have", "been", "here", "there",
  "into", "your", "them", "then", "than", "when", "what", "which", "where", "added",
  "please", "value", "text", "some", "also", "only", "needs", "need", "make", "made",
  "document", "sentence", "version", "setting", "section",
]);
function buildDf(before: ParsedDoc, diff: DiffHunk[]): Map<string, number> {
  const df = new Map<string, number>();
  const bump = (text: string) => {
    for (const w of new Set(text.toLowerCase().split(/[^a-z0-9.]+/))) {
      if (w.length >= 4 && !STOP.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
    }
  };
  for (const b of before.blocks) bump(b.text);
  for (const h of diff) bump(h.afterText ?? "");
  return df;
}

function distinctive(c: CommentRecord, df: Map<string, number>): string[] {
  const words = `${c.comment} ${c.replyByAuthor}`
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && (df.get(w) ?? Infinity) <= 3);
  return [...new Set(words)];
}

export function anchorComments(
  comments: CommentRecord[],
  before: ParsedDoc,
  diff: DiffHunk[]
): CommentAnchor[] {
  const headingMap = buildHeadingMap(before);
  const { bodyStart } = parseToc(before);
  const df = buildDf(before, diff);

  return comments.map((c) => {
    const sec = (c.locationNumber ?? "").trim();

    // ---- Tier 1a: section-number anchor (page never needed) ----
    if (sec && headingMap.has(sec)) {
      const h = headingMap.get(sec)!;
      const { start, end } = sectionRange(before, h);
      const lt = c.locationType.toLowerCase();
      if (lt === "table" || lt === "area") {
        const tbl = before.blocks.find(
          (b) => b.index >= start && b.index <= end && b.type === "table"
        );
        const target = tbl ?? before.blocks[h];
        return {
          commentNumber: c.number,
          anchorIndex: target.index,
          sectionEnd: tbl ? target.index : end, // table → exact block; else whole section window
          method: "section",
        };
      }
      // paragraph / empty / line / requirement → section heading, window = whole section
      return { commentNumber: c.number, anchorIndex: h, sectionEnd: end, method: "section" };
    }

    // ---- Tier 1b: integer ordinal among that location type (docs without numbered headings) ----
    if (sec && /^\d+$/.test(sec)) {
      const of = before.blocks.filter(
        (b) => b.index >= bodyStart && typeMatch(c.locationType, b.type)
      );
      const idx = parseInt(sec, 10) - 1;
      if (idx >= 0 && idx < of.length) {
        return { commentNumber: c.number, anchorIndex: of[idx].index, method: "section" };
      }
    }

    // ---- Tier 2a: n-gram window match against before-doc (outside the TOC region).
    // Reviewers quote the text they refer to, embedded mid-comment — so sentence
    // prefixes never match. Instead: slide word windows over comment+reply; any
    // 8..6-word window found verbatim in a block pins that block. ----
    const words = `${c.comment} ${c.replyByAuthor}`
      .replace(/[""'']/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9±%.]+/)
      .filter(Boolean);
    let hit: typeof before.blocks[number] | undefined;
    for (const size of [8, 7, 6]) {
      if (hit || words.length < size) continue;
      for (let i = 0; i + size <= words.length && !hit; i++) {
        const win = words.slice(i, i + size).join(" ");
        hit = before.blocks.find((b) => b.index >= bodyStart && b.text.toLowerCase().includes(win));
      }
    }
    if (hit) return { commentNumber: c.number, anchorIndex: hit.index, method: "content" };

    // ---- Tier 2b: distinctive tokens shared with a diff hunk's afterText ----
    const tokens = distinctive(c, df);
    if (tokens.length) {
      const scored = diff
        .map((h) => {
          const at = (h.afterText ?? "").toLowerCase();
          const shared = tokens.filter((t) => at.includes(t));
          // a shared token with a digit (IP67, 250) is strong; words need two
          const strong = shared.some((t) => /\d/.test(t));
          return { h, score: strong || shared.length >= 2 ? shared.length : 0 };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best) {
        const idx = best.h.beforeIndex ?? best.h.afterIndex;
        if (idx !== undefined)
          return { commentNumber: c.number, anchorIndex: idx, method: "content", note: "diff-match" };
      }
    }

    // ---- Tier 4: unanchorable → LLM resolver (orchestrator), then needs_user ----
    return { commentNumber: c.number, anchorIndex: null, method: "failed" };
  });
}

/** Recompute the method distribution for the run summary. */
export function anchorMethodCounts(anchors: CommentAnchor[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of anchors) counts[a.method] = (counts[a.method] ?? 0) + 1;
  return counts;
}
