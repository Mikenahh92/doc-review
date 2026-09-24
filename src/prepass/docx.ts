// DOCX parsing — extracts structural blocks (paragraphs, headings, tables) from word/document.xml.
// Deterministic pre-pass; no LLM. Prototype-grade: regex-based, good enough for .docx built by
// the fixture generator and typical Word files (full fidelity would use a proper OOXML parser).

import AdmZip from "adm-zip";
import type { DocBlock, ParsedDoc } from "../types.js";

const PARAGRAPH_RE = /<w:p[ >][\s\S]*?<\/w:p>/g;

function paraText(pXml: string): string {
  return (pXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
    .map((t) => t.replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

function isHeading(pXml: string): boolean {
  return /<w:pStyle[^>]*w:val="Heading\d"/.test(pXml);
}

export function parseDocx(fileName: string, buffer: Buffer): ParsedDoc {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry("word/document.xml");
  if (!entry) throw new Error(`${fileName}: not a valid .docx (missing word/document.xml)`);
  const xml = entry.getData().toString("utf8");

  // Split into top-level elements: paragraphs and tables (tables handled as single blocks).
  const blocks: DocBlock[] = [];
  const tokenRe = /<w:tbl[ >][\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const tok = m[0];
    if (tok.startsWith("<w:tbl")) {
      const text = (tok.match(PARAGRAPH_RE) ?? []).map(paraText).filter(Boolean).join(" | ");
      blocks.push({
        index: blocks.length,
        type: "table",
        text: text || "(empty table)",
        pageEstimate: Math.floor(blocks.length / 45) + 1,
      });
    } else {
      const text = paraText(tok);
      if (!text) continue; // skip empty paragraphs
      blocks.push({
        index: blocks.length,
        type: isHeading(tok) ? "heading" : "paragraph",
        text,
        pageEstimate: Math.floor(blocks.length / 45) + 1,
      });
    }
  }
  return { fileName, blocks };
}
