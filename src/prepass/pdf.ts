// PDF parsing — text extraction via pdfjs-dist (legacy build), split into paragraph blocks.
// PDF carries no reliable structure, so every block is a paragraph.

import type { DocBlock, ParsedDoc } from "../types.js";

export async function parsePdf(fileName: string, buffer: Buffer): Promise<ParsedDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const blocks: DocBlock[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // group text items into lines by y, then paragraphs by vertical gaps
    let lines: { y: number; parts: string[] }[] = [];
    for (const item of tc.items as any[]) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      let line = lines.find((l) => Math.abs(l.y - y) <= 2);
      if (!line) { line = { y, parts: [] }; lines.push(line); }
      line.parts.push(item.str);
    }
    lines = lines.sort((a, b) => b.y - a.y); // top of page first
    const text = lines.map((l) => l.parts.join(" ")).join("\n");
    for (const ln of text.split("\n")) {
      const t = ln.replace(/\s+/g, " ").trim();
      if (t) blocks.push({ index: blocks.length, type: "paragraph", text: t, pageEstimate: p });
    }
  }
  await doc.destroy();
  if (!blocks.length) throw new Error(`${fileName}: no extractable text — scanned image PDFs are not supported`);
  // merge continuation lines: a line not ending in sentence-end joins the previous block
  const merged: DocBlock[] = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && !/[.!?:]$/.test(prev.text)) {
      prev.text = (prev.text + " " + b.text).trim();
    } else merged.push({ ...b, index: merged.length });
  }
  return { fileName, blocks: merged };
}
