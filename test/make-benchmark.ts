// Benchmark fixture generator: 60-page technical doc + 30-comment register + reviewed copy
// with mixed edit outcomes (18 correct / 6 wrong / 6 missing). Ground truth included.
// Run: npm run benchmark  → test/fixtures/bench/

import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(process.cwd(), "test", "fixtures", "bench");
fs.mkdirSync(OUT, { recursive: true });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const para = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const table = (rows: string[][]): string =>
  `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;

function makeDocx(blocks: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join("")}</w:body></w:document>`));
  return zip.toBuffer();
}

// ---- 1. generate the 60-page BEFORE document (heuristic: ~45 blocks/page → 2700 blocks) ----
interface Block { xml: string; type: "paragraph" | "table" | "heading"; text: string }
const blocks: Block[] = [];
const ordinal = { paragraph: 0, table: 0, heading: 0 };
const add = (text: string, type: Block["type"], xml?: string) => {
  ordinal[type]++;
  blocks.push({ xml: xml ?? para(text, type === "heading" ? "Heading1" : undefined), type, text });
};

const SECTIONS = ["System Overview", "Interfaces", "Power Supply", "Sensor Array", "Data Processing", "Communication", "Mechanical Design", "Environmental Limits", "Maintenance & Service", "Compliance", "Diagnostics", "Firmware Update", "Safety", "Storage & Handling", "Shipping", "Installation", "Calibration", "Troubleshooting", "Glossary", "Appendix A: Timing Budget"];
let section = 0, n = 0;
while (blocks.length < 2700) {
  add(SECTIONS[section % SECTIONS.length] + " (part " + (Math.floor(section / SECTIONS.length) + 1) + ")", "heading");
  section++;
  for (let i = 0; i < 49 && blocks.length < 2700; i++, n++) {
    if (n % 8 === 7) {
      add("", "table", table([["Item", "Value"], ["Channel " + n, String(100 + (n % 900))], ["Threshold", String(n % 50) + " units"]]));
    } else {
      const v1 = 10 + (n % 90);
      const v2 = 200 + (n % 800);
      add(
        `Subsection ${n}: the module shall report diagnostic parameter ${n} with interval ${v1} ms and buffer up to ${v2} samples before flushing to storage; recalibration is due after ${(n % 400) + 100} operating hours.`,
        "paragraph"
      );
    }
  }
}

// ---- 2. pick 30 comment targets spread across the document ----
const targetIdxs = Array.from({ length: 30 }, (_, i) => 40 + i * 86); // ~one every 86 blocks
interface Target { n: number; blockIdx: number; type: Block["type"]; ordinal: number; page: number; beforeText: string; afterText: string; comment: string; reply: string; expected: string }
const targets: Target[] = [];
targetIdxs.forEach((bi, i) => {
  const b = blocks[bi];
  if (!b || b.type === "heading") bi = bi + 1; // avoid headings (comments target paragraphs/tables)
  const blk = blocks[bi];
  const ord = blocks.slice(0, bi + 1).filter((x) => x.type === blk.type).length;
  const kindRoll = i % 5; // 18 correct, 6 wrong, 6 missing → assign pattern below
  const m = blk.text.match(/interval (\d+) ms/);
  if (!m) return; // only paragraph targets with an interval value
  const oldVal = m[1];
  const reqVal = String(parseInt(oldVal, 10) + 55);        // what the comment asks
  const wrongVal = String(parseInt(oldVal, 10) + 777);     // plausible-but-wrong value
  const expectedKind = i < 18 ? "correctly_applied" : i < 24 ? "incorrectly_applied" : "missing";
  const afterText =
    expectedKind === "correctly_applied" ? blk.text.replace(`interval ${oldVal} ms`, `interval ${reqVal} ms`)
    : expectedKind === "incorrectly_applied" ? blk.text.replace(`interval ${oldVal} ms`, `interval ${wrongVal} ms`)
    : blk.text;
  const comment =
    `Please update the reporting interval in this ${blk.type} from ${oldVal} ms to ${reqVal} ms as agreed in review meeting R${i + 1}.`;
  targets.push({
    n: i + 1, blockIdx: bi, type: blk.type, ordinal: ord, page: Math.floor(bi / 45) + 1,
    beforeText: blk.text, afterText, comment,
    reply: expectedKind === "correctly_applied" ? `Updated interval to ${reqVal} ms.` : "Addressed in revision.",
    expected: expectedRollFix(expectedKind, kindRoll),
  });
});
function expectedRollFix(kind: string, _r: number): string { return kind; } // keep simple

// ---- 3. build AFTER document ----
const afterBlocks = blocks.map((b, i) => {
  const t = targets.find((x) => x.blockIdx === i);
  return t ? (t.type === "table" ? "" : para(t.afterText, undefined)) : b.xml;
}).filter(Boolean);

fs.writeFileSync(path.join(OUT, "before.docx"), makeDocx(blocks.map((b) => b.xml)));
fs.writeFileSync(path.join(OUT, "after.docx"), makeDocx(afterBlocks));

// ---- 4. comments register XLSX ----
const rows = targets.map((t) => ({
  Number: t.n, document: "System Specification", "page number": t.page,
  location: t.type === "table" ? "Table" : "Paragraph", "location number": t.ordinal,
  comment: t.comment, "comment type": t.n % 3 === 0 ? "Meeting" : "Author",
  "reply by author": t.reply, "external reply": "", "external participant": "",
  participant: "R. Jansen", status: "accepted", processed: "yes",
}));
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Comments");
XLSX.writeFile(wb, path.join(OUT, "comments.xlsx"));

// ---- 5. ground truth ----
fs.writeFileSync(path.join(OUT, "ground_truth.json"), JSON.stringify({
  source: "npm run benchmark",
  pages: Math.ceil(blocks.length / 45),
  blocks: blocks.length,
  comments: targets.map((t) => ({ number: t.n, expected: t.expected, page: t.page, type: t.type })),
}, null, 2));

console.log(`benchmark fixtures: ${blocks.length} blocks (~${Math.ceil(blocks.length / 45)} pages), ${targets.length} comments`);
console.log(`expected: ${targets.filter((t) => t.expected === "correctly_applied").length} correct, ${targets.filter((t) => t.expected === "incorrectly_applied").length} incorrect, ${targets.filter((t) => t.expected === "missing").length} missing`);
