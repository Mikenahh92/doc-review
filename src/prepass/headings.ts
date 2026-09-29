// Heading map + TOC parsing — deterministic pre-pass (DR-27).
//
// The review register's "location number" is a SECTION NUMBER ("6.2", "7.3",
// "5.2.1") as used in the document's numbered headings / table of contents —
// not an element ordinal. Page is often 0 (not enforced in the review tool),
// so section numbers are the primary anchor signal.
//
//   buildHeadingMap(doc)  → { "6.2" → blockIndex } from Heading-styled blocks;
//                           falls back to numbered paragraphs (unstyled headings)
//   parseToc(doc)         → TOC entries (number → page) + body start index;
//                           used for cross-checks and to keep content anchoring
//                           out of the TOC region
//   sectionRange(doc, i)  → block range [start, end] of the section under heading i

import type { ParsedDoc } from "../types.js";

/** "6.2 Sensor calibration" / "7.3.1. Range" → section number captured. */
const SECTION_HEADING_RE = /^(\d+(?:\.\d+){0,4})[.)]?\s+\S/;

/** "Contents" / "Table of contents" heading (style-agnostic on purpose). */
const TOC_TITLE_RE = /^(table of )?contents$/i;

/** TOC line after normalization: "6.2 Measurement accuracy 2" → number + page. */
const TOC_LINE_RE = /^(\d+(?:\.\d+){0,4})\s+\D.*?\s(\d{1,4})$/;

export function buildHeadingMap(doc: ParsedDoc): Map<string, number> {
  const map = new Map<string, number>();
  // pass 1: real heading blocks (Word styles Heading1..9)
  for (const b of doc.blocks) {
    if (b.type !== "heading") continue;
    const m = SECTION_HEADING_RE.exec(b.text.trim());
    if (m && !map.has(m[1])) map.set(m[1], b.index);
  }
  // pass 2 (only when no styled numbered headings): numbered paragraphs —
  // covers documents whose headings lost their styles (common in legacy .doc rounds)
  if (map.size === 0) {
    for (const b of doc.blocks) {
      const m = SECTION_HEADING_RE.exec(b.text.trim());
      if (m && !map.has(m[1])) map.set(m[1], b.index);
    }
  }
  return map;
}

export interface TocEntry {
  number: string;
  page: number;
}

/** Parse the table of contents, if present. Also returns where real body content
 *  starts (first heading after the TOC) so content anchoring never matches TOC lines. */
export function parseToc(doc: ParsedDoc): { entries: TocEntry[]; bodyStart: number } {
  const entries: TocEntry[] = [];
  let inToc = false;
  let bodyStart = 0;
  for (const b of doc.blocks) {
    if (!inToc) {
      if (b.type === "heading" && TOC_TITLE_RE.test(b.text.trim())) inToc = true;
      continue;
    }
    if (b.type === "heading") {
      bodyStart = b.index; // TOC ends at the first real heading after it
      break;
    }
    const t = b.text.replace(/\.{2,}/g, " ").replace(/\t/g, " ").replace(/\s+/g, " ").trim();
    const m = TOC_LINE_RE.exec(t);
    if (m) entries.push({ number: m[1], page: parseInt(m[2], 10) });
  }
  return { entries, bodyStart };
}

/** Block range of the section under heading at index i (inclusive, up to the next heading). */
export function sectionRange(doc: ParsedDoc, headingIndex: number): { start: number; end: number } {
  let end = doc.blocks.length - 1;
  for (const b of doc.blocks) {
    if (b.index > headingIndex && b.type === "heading") {
      end = b.index - 1;
      break;
    }
  }
  return { start: headingIndex + 1, end };
}
