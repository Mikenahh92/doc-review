// Markdown parsing — structural blocks from plain markdown text. Deterministic, no LLM.
// #/##/... → heading · | rows | → table · consecutive text lines → one paragraph.

import type { DocBlock, ParsedDoc } from "../types.js";

export function parseMarkdown(fileName: string, buffer: Buffer): ParsedDoc {
  const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let tbl: string[] = [];
  let page = 1;
  // Page markers preserved by upstream PDF→md conversion: <!-- page: 3 --> · [PAGE 3] · [page 3] · form feed
  const pageMarker = /^(?:<!--\s*page:\s*(\d+)\s*-->|\[\s*page\s+(\d+)\s*\])$/i;
  const setPage = (t: string) => {
    const m = t.match(pageMarker);
    if (m) { page = parseInt(m[1] || m[2], 10); return true; }
    return false;
  };
  const flushTbl = () => {
    if (!tbl.length) return;
    const rows = tbl.filter((r) => !/^\|[\s:|-]+\|?$/.test(r)); // drop |---|---| separators
    const cols = rows[0] ? rows[0].replace(/^\||\|$/g, "").split("|").length : 0;
    const text = rows.map((r) => r.replace(/^\||\|$/g, "").trim()).join(" | ");
    blocks.push({ index: blocks.length, type: "table", text, pageEstimate: page, tableCols: cols, tableRows: rows.length });
    tbl = [];
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { flushTbl(); continue; }
    if (setPage(t)) { flushTbl(); continue; }
    if (t.startsWith("#")) { flushTbl(); blocks.push({ index: blocks.length, type: "heading", text: t.replace(/^#+\s*/, ""), pageEstimate: page }); continue; }
    if (t.startsWith("|")) { tbl.push(t); continue; }
    flushTbl(); blocks.push({ index: blocks.length, type: "paragraph", text: t, pageEstimate: page });
  }
  flushTbl();
  return { fileName, blocks };
}
