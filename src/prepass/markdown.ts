// Markdown parsing — structural blocks from plain markdown text. Deterministic, no LLM.
// #/##/... → heading · | rows | → table · consecutive text lines → one paragraph.

import type { DocBlock, ParsedDoc } from "../types.js";

export function parseMarkdown(fileName: string, buffer: Buffer): ParsedDoc {
  const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let tbl: string[] = [];
  const flushTbl = () => {
    if (!tbl.length) return;
    const rows = tbl.filter((r) => !/^\|[\s:|-]+\|?$/.test(r)); // drop |---|---| separators
    const text = rows.map((r) => r.replace(/^\||\|$/g, "").trim()).join(" | ");
    blocks.push({ index: blocks.length, type: "table", text, pageEstimate: 1 });
    tbl = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flushTbl(); continue; }
    if (t.startsWith("#")) { flushTbl(); blocks.push({ index: blocks.length, type: "heading", text: t.replace(/^#+\s*/, ""), pageEstimate: 1 }); continue; }
    if (t.startsWith("|")) { tbl.push(t); continue; }
    flushTbl(); blocks.push({ index: blocks.length, type: "paragraph", text: t, pageEstimate: 1 });
  }
  flushTbl();
  return { fileName, blocks };
}
