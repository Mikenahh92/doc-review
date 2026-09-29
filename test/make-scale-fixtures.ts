// Scale fixture generator (DR-28): ~100-page docx pair + 60-comment register
// covering ALL anchor cases, with a known-answer ledger for live grading.
// Run: npx tsc && node dist/test/make-scale-fixtures.js
// Output: test/fixtures-scale/{before.docx,after.docx,comments.xlsx,ledger.json}
//
// Case groups (60 comments):
//   A (24) page=0 + valid section number, paragraph — 12 target-edited / 12 not
//   B (8)  page=0 + valid section number, table — 4 edited / 4 not
//   C (4)  page filled + valid section number — 2 edited / 2 not
//   D (6)  ghost section number + quoted target text — 3 edited / 3 not
//   E (4)  ghost section + unique revision token only in reply (diff-match tier)
//   F (5)  no location at all + quoted target text — 2 edited / 3 not
//   G (5)  no location at all, vague hint — LLM resolver tier (tolerant grading)
//   H (4)  no location, nonsense references — expect unresolvable → needs_user

import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(process.cwd(), "test", "fixtures-scale");
fs.mkdirSync(OUT, { recursive: true });

let seed = 20260929;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};

const COMPS = [
  "acquisition module", "power supervisor", "bus controller", "enclosure sensor",
  "clock tree", "diagnostic probe", "thermal monitor", "relay matrix",
  "memory scrubber", "link transceiver",
];
const SECTION_TITLES = [
  "General requirements", "Interfaces", "Signal acquisition", "Power distribution",
  "Environmental limits", "Diagnostics", "Communication", "Timing and clocks",
  "Mechanical integration", "Reliability", "Safety", "Compliance",
];
const SUB_TITLES = ["General", "Parameters", "Verification", "Constraints", "Behaviour", "Margin"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function para(text: string, style?: string): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}
function table(rows: string[][]): string {
  return `<w:tbl>${rows
    .map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`)
    .join("")}</w:tbl>`;
}
function makeDocx(blocks: string[]): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  );
  zip.addFile(
    "word/document.xml",
    Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.join("")}</w:body></w:document>`)
  );
  return zip.toBuffer();
}

// ---- document model ----
interface Sub {
  sec: string;              // "4.2"
  subIdx: number;           // 0..35
  paras: string[];          // paragraph texts
  table?: string[][];       // table cells (some subs)
  editParaIdx?: number;     // paragraph edited in the after-doc
  editTable?: boolean;      // table edited in the after-doc
  token?: string;           // unique revision token added by the edit
}

const subs: Sub[] = [];
let paraCounter = 0;
for (let s = 1; s <= 12; s++) {
  for (let ss = 1; ss <= 3; ss++) {
    const subIdx = (s - 1) * 3 + (ss - 1);
    const paras: string[] = [];
    for (let i = 0; i < 105; i++) {
      paras.push(
        `The ${COMPS[rnd(COMPS.length)]} shall sample channel ${rnd(8)} at ${[50, 100, 200][rnd(3)]} Hz; tolerance ±${1 + rnd(9)}% under condition L${paraCounter++}.`
      );
    }
    const sub: Sub = { sec: `${s}.${ss}`, subIdx, paras };
    // tables: group-B subs (24..31) always; elsewhere every other sub before 24
    if ((subIdx >= 24 && subIdx < 32) || (subIdx < 24 && subIdx % 2 === 0)) {
      sub.table = [
        ["Parameter", "Nominal", "Measured"],
        ["Voltage", "24 V", `${23 + rnd(2)} V`],
        ["Current", "1.5 A", `${(1.4 + rnd(20) / 100).toFixed(2)} A`],
        ["Frequency", "60 Hz", `${59 + rnd(2)} Hz`],
      ];
    }
    subs.push(sub);
  }
}

// ---- edit plan (deterministic): one edit max per subsection ----
// A subs 0..23: even = edited (12 applied), odd = not (12 missing)
for (let i = 0; i < 24; i++) {
  if (i % 2 === 0) {
    subs[i].editParaIdx = rnd(105);
    subs[i].token = `MKT-${1000 + i}`;
  }
}
// B subs 24..31: 24..27 table edited (4 applied), 28..31 not (4 missing)
for (let i = 24; i < 32; i++) subs[i].editTable = i < 28;
// C subs 32..35: 32,33 edited (2 applied), 34,35 not (2 missing)
for (let i = 32; i < 36; i++) {
  if (i < 34) {
    subs[i].editParaIdx = rnd(105);
    subs[i].token = `MKT-${1000 + i}`;
  }
}

// ---- build before/after XML ----
function buildDoc(after: boolean): string[] {
  const out: string[] = [];
  out.push(para("System Specification — Distributed Sensor Platform DDX-400", "Heading1"));
  out.push(para("Contents", "Heading1"));
  for (const sub of subs) {
    const page = 2 + Math.floor(sub.subIdx * 2.4);
    const [s, ss] = sub.sec.split(".");
    const title = SUB_TITLES[sub.subIdx % SUB_TITLES.length];
    out.push(para(`${sub.sec} ${title} . ${page}`));
    void s; void ss;
  }
  for (let s = 1; s <= 12; s++) {
    out.push(para(`${s} ${SECTION_TITLES[s - 1]}`, "Heading2"));
    for (const sub of subs.filter((x) => x.sec.startsWith(`${s}.`))) {
      out.push(para(`${sub.sec} ${SUB_TITLES[sub.subIdx % SUB_TITLES.length]}`, "Heading3"));
      sub.paras.forEach((p, i) => {
        const edited = after && sub.editParaIdx === i;
        out.push(para(edited ? `${p} REV2: reference condition is 25 °C (${sub.token}).` : p));
      });
      if (sub.table) {
        const t = sub.table.map((r) => [...r]);
        if (after && sub.editTable) t[1][1] = `${t[1][1]} (rev2)`;
        out.push(table(t));
      }
    }
  }
  out.push(para("End of document."));
  return out;
}

const beforeXml = buildDoc(false);
const afterXml = buildDoc(true);
const blockCount = beforeXml.length;
const pageCount = Math.floor(blockCount / 45) + 1;
fs.writeFileSync(path.join(OUT, "before.docx"), makeDocx(beforeXml));
fs.writeFileSync(path.join(OUT, "after.docx"), makeDocx(afterXml));

// ---- comments (60) + ledger ----
interface Row {
  n: number; page: number; loc: string; locNum: string;
  comment: string; reply: string; group: string;
  expectAnchor: string; expectVerdict: string; targetSub: number; strict: boolean;
}
const rows: Row[] = [];
let n = 1;
const mk = (r: Omit<Row, "n">) => rows.push({ n: n++, ...r });

// A (24): page=0, Paragraph + valid section; quote target sentence
for (let i = 0; i < 24; i++) {
  const sub = subs[i];
  const target = sub.paras[sub.editParaIdx ?? 7];
  mk({
    page: 0, loc: "Paragraph", locNum: sub.sec,
    comment: `Section ${sub.sec}: the requirement "${target}" does not state the reference condition for the tolerance. Add it.`,
    reply: `Reference condition added to the requirement (see revision note).`,
    group: "A", expectAnchor: "section",
    expectVerdict: sub.editParaIdx !== undefined ? "correctly_applied" : "missing",
    targetSub: i, strict: true,
  });
}
// B (8): page=0, Table + valid section
for (let i = 24; i < 32; i++) {
  const sub = subs[i];
  mk({
    page: 0, loc: "Table", locNum: sub.sec,
    comment: `The nominal voltage value in the table of section ${sub.sec} needs its reference condition stated.`,
    reply: `Reference condition added to the nominal value.`,
    group: "B", expectAnchor: "section",
    expectVerdict: sub.editTable ? "correctly_applied" : "missing",
    targetSub: i, strict: true,
  });
}
// C (4): page FILLED + valid section
for (let i = 32; i < 36; i++) {
  const sub = subs[i];
  const target = sub.paras[sub.editParaIdx ?? 7];
  mk({
    page: 3 + (i - 32) * 4, loc: "Paragraph", locNum: sub.sec,
    comment: `Section ${sub.sec}: the requirement "${target}" must mention the reference condition.`,
    reply: `Reference condition added.`,
    group: "C", expectAnchor: "section",
    expectVerdict: sub.editParaIdx !== undefined ? "correctly_applied" : "missing",
    targetSub: i, strict: true,
  });
}
// D (6): ghost section + quoted text — 3 edited targets (even subs), 3 unedited (odd subs)
for (let k = 0; k < 6; k++) {
  const i = k < 3 ? k * 2 : k * 2 - 3; // 0,2,4 then 1,3,5
  const sub = subs[i];
  const target = sub.paras[sub.editParaIdx ?? 7];
  mk({
    page: 0, loc: "Paragraph", locNum: "13.7",
    comment: `The requirement "${target}" is ambiguous about the tolerance source.`,
    reply: "",
    group: "D", expectAnchor: "content",
    expectVerdict: sub.editParaIdx !== undefined ? "correctly_applied" : "missing",
    targetSub: i, strict: true,
  });
}
// E (4): ghost section + unique token in reply only (diff-match tier)
for (let k = 0; k < 4; k++) {
  const sub = subs[6 + k * 2]; // 6,8,10,12 — all edited
  mk({
    page: 0, loc: "Paragraph", locNum: "13.9",
    comment: `The relevant tolerance requirement should state its revision reference.`,
    reply: `Revision marker ${sub.token} was added.`,
    group: "E", expectAnchor: "content",
    expectVerdict: "correctly_applied",
    targetSub: 6 + k * 2, strict: true,
  });
}
// F (5): NO location + quoted text — 2 edited (14,16), 3 unedited (15,17,19)
{
  const targets = [14, 16, 15, 17, 19];
  for (const i of targets) {
    const sub = subs[i];
    const target = sub.paras[sub.editParaIdx ?? 7];
    mk({
      page: 0, loc: "", locNum: "",
      comment: `This requirement "${target}" needs a stated reference condition for its tolerance.`,
      reply: "",
      group: "F", expectAnchor: "content",
      expectVerdict: sub.editParaIdx !== undefined ? "correctly_applied" : "missing",
      targetSub: i, strict: true,
    });
  }
}
// G (5): NO location, vague hints — LLM resolver tier (tolerant grading)
{
  const hints: [string, number, string][] = [
    ["The sampling rate requirement is ambiguous and must be clarified.", 20, "missing"],
    ["The thermal monitor requirement needs a margin statement.", 21, "missing"],
    ["The bus controller requirement should state its revision reference.", 18, "correctly_applied"],
    ["The clock tree tolerance needs a reference condition.", 22, "missing"],
    ["The memory scrubber requirement is unclear about its limit.", 23, "missing"],
  ];
  for (const [comment, subIdx, verdict] of hints) {
    mk({
      page: 0, loc: "", locNum: "",
      comment, reply: "",
      group: "G", expectAnchor: "llm",
      expectVerdict: verdict, targetSub: subIdx, strict: false,
    });
  }
}
// H (4): NO location, nonsense references — expect unresolvable → needs_user
{
  const nonsense = [
    "The unicorn protocol appendix requires an update to the flux tables.",
    "Appendix Z mentions a warp coil tolerance that must be corrected.",
    "The quantum telemetry section states an impossible latency budget.",
    "Reference to the dilithium calibration table should be removed.",
  ];
  for (const comment of nonsense) {
    mk({
      page: 0, loc: "", locNum: "",
      comment, reply: "",
      group: "H", expectAnchor: "failed",
      expectVerdict: "needs_user", targetSub: -1, strict: false,
    });
  }
}

// ---- write register XLSX + ledger ----
const xlsxRows = rows.map((r) => ({
  Number: r.n,
  document: "System Specification — Distributed Sensor Platform DDX-400",
  "page number": r.page,
  location: r.loc,
  "location number": r.locNum,
  comment: r.comment,
  "comment type": r.n % 2 ? "Author" : "Meeting",
  "reply by author": r.reply,
  "external reply": "",
  "external participant": "",
  participant: ["J. de Vries", "K. Jansen", "P. Smit", "R. Jansen"][r.n % 4],
  status: "accepted",
  processed: "yes",
}));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(xlsxRows), "Comments");
XLSX.writeFile(wb, path.join(OUT, "comments.xlsx"));

fs.writeFileSync(
  path.join(OUT, "ledger.json"),
  JSON.stringify({
    blocks: blockCount, pages: pageCount,
    editedSubs: subs.filter((s) => s.editParaIdx !== undefined || s.editTable).length,
    comments: rows.map(({ n, group, expectAnchor, expectVerdict, targetSub, strict }) => ({
      n, group, expectAnchor, expectVerdict, targetSub, strict,
    })),
  }, null, 2)
);
console.log(`scale fixtures written to ${OUT}`);
console.log(`  blocks=${blockCount} (~${pageCount} pages), subs=${subs.length}, tables=${subs.filter((s) => s.table).length}`);
console.log(`  edited subsections=${subs.filter((s) => s.editParaIdx !== undefined || s.editTable).length}, comments=${rows.length}`);
const byGroup: Record<string, number> = {};
for (const r of rows) byGroup[r.group] = (byGroup[r.group] ?? 0) + 1;
console.log(`  groups: ${JSON.stringify(byGroup)}`);
