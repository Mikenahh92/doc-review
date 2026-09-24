// Fixture generator: builds a realistic before/after .docx pair + comments .xlsx.
// Run: npm run fixtures  → test/fixtures/{before.docx,after.docx,comments.xlsx}

import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(process.cwd(), "test", "fixtures");
fs.mkdirSync(OUT, { recursive: true });

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

// ---- before-review document ----
const before = [
  para("System Specification", "Heading1"),
  para("Introduction"),
  para("This document specifies the requirements for the sensor unit and its interfaces. The tolerance values in this section are normative."),
  para("The enclosure shall be sealed against water ingress."),                                    // idx ~4 → comment 1 (rephrased in after)
  para("Operating temperature range is -20 to +60 degrees Celsius."),
  para("Sensor calibration"),
  table([
    ["Parameter", "Value"],
    ["Range", "0-100"],
    ["Accuracy", "±5 %"],                                    // → comment 3 (table fix in after)
  ]),
  para("The sensor shall report measurements every 100 milliseconds."),                             // → comment 2 (NOT changed in after → missing)
  para("Maintenance"),
  para("The unit must be serviced annually by qualified personnel."),
  para("Deprecated: firmware version 1.x is no longer supported and should be avoided."),           // idx ~11 → comment 4 (reworded in after)
  para("Appendix A: wiring diagram"),
  table([["Pin", "Signal"], ["1", "VCC"], ["2", "GND"], ["3", "DATA"]]),
  para("End of document."),
];

// ---- after-review document (humans applied comments 1, 3, 4; forgot 2) ----
const after = [
  para("System Specification", "Heading1"),
  para("Introduction"),
  para("This document specifies the requirements for the sensor unit and its interfaces. The tolerance values in this section are normative."),
  para("The enclosure shall be sealed against water ingress and dust according to IP67."),          // comment 1 applied
  para("Operating temperature range is -20 to +60 degrees Celsius."),
  para("Sensor calibration"),
  table([
    ["Parameter", "Value"],
    ["Range", "0-100"],
    ["Accuracy", "±5 % (full scale)"],                                   // comment 3 applied
  ]),
  para("The sensor shall report measurements every 100 milliseconds."),                             // comment 2 NOT applied
  para("Maintenance"),
  para("The unit must be serviced annually by qualified personnel."),
  para("Firmware version 2.x or later is required for this product."),                              // comment 4 applied
  para("Appendix A: wiring diagram"),
  table([["Pin", "Signal"], ["1", "VCC"], ["2", "GND"], ["3", "DATA"]]),
  para("End of document."),
];

fs.writeFileSync(path.join(OUT, "before.docx"), makeDocx(before));
fs.writeFileSync(path.join(OUT, "after.docx"), makeDocx(after));

// ---- comments register (structured XLSX, pre-filtered: accepted + processed=yes) ----
// NOTE: location ordinals count element types in parse order among *paragraph-ish* blocks.
const rows = [
  {
    Number: 1,
    document: "System Specification",
    "page number": 1,
    location: "Paragraph",
    "location number": 3,
    comment: "Please specify the degree of protection of the enclosure (IP rating).",
    "comment type": "Author",
    "reply by author": "Added IP67 rating to the sentence.",
    "external reply": "",
    "external participant": "",
    participant: "J. de Vries",
    status: "accepted",
    processed: "yes",
  },
  {
    Number: 2,
    document: "System Specification",
    "page number": 1,
    location: "Paragraph",
    "location number": 6,
    comment: "Clarify whether the 100 ms reporting interval includes transmission time.",
    "comment type": "Meeting",
    "reply by author": "Clarified reporting interval definition.",
    "external reply": "",
    "external participant": "",
    participant: "K. Jansen",
    status: "accepted",
    processed: "yes",
  },
  {
    Number: 3,
    document: "System Specification",
    "page number": 1,
    location: "Table",
    "location number": 1,
    comment: "The accuracy value needs a reference (percentage of what?).",
    "comment type": "Author",
    "reply by author": "Added '(full scale)' to the accuracy value.",
    "external reply": "",
    "external participant": "",
    participant: "J. de Vries",
    status: "accepted",
    processed: "yes",
  },
  {
    Number: 4,
    document: "System Specification",
    "page number": 2,
    location: "Paragraph",
    "location number": 9,
    comment: "Update the deprecated firmware reference to the current supported version.",
    "comment type": "Meeting",
    "reply by author": "Replaced with firmware 2.x requirement.",
    "external reply": "",
    "external participant": "",
    participant: "P. Smit",
    status: "accepted",
    processed: "yes",
  },
];
const ws = XLSX.utils.json_to_sheet(rows);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Comments");
XLSX.writeFile(wb, path.join(OUT, "comments.xlsx"));

console.log("fixtures written to", OUT);

// ---- plain-text fixture set (works for BOTH .md and .pdf — same logical structure) ----
// no headings/tables so paragraph ordinals are identical in markdown and PDF parsing.
const plainBefore = [
  "Product specification for the data acquisition unit.",
  "The enclosure shall be sealed against water ingress.",
  "Operating temperature range is -20 to +60 degrees Celsius.",
  "The sensor shall report measurements every 100 milliseconds.",
  "Maintenance: the unit must be serviced annually by qualified personnel.",
  "Deprecated: firmware version 1.x is no longer supported and should be avoided.",
  "Accuracy of the measurement chain is ±5 %.",
  "The unit connects via RS-485 at 115200 baud.",
  "Storage temperature range is -30 to +70 degrees Celsius.",
  "End of document.",
];
const plainAfter = [
  plainBefore[0],
  "The enclosure shall be sealed against water ingress and dust according to IP67.",   // c1 applied
  plainBefore[2],
  plainBefore[3],                                                                       // c2 missing
  plainBefore[4],
  "Firmware version 2.x or later is required for this product.",                       // c4 applied
  "Accuracy of the measurement chain is ±5 % (full scale).",                            // c3 applied
  plainBefore[7],
  plainBefore[8],
  plainBefore[9],
];
fs.writeFileSync(path.join(OUT, "before.md"), plainBefore.map((l) => l + "\n").join(""));
fs.writeFileSync(path.join(OUT, "after.md"), plainAfter.map((l) => l + "\n").join(""));

// ---- minimal raw PDF writer (no deps): one page, Helvetica, one Tj per line ----
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  let content = "BT\n/F1 11 Tf\n14 TL\n72 760 Td\n";
  for (const l of lines) content += `(${esc(l)}) Tj T*\n`;
  content += "ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}
fs.writeFileSync(path.join(OUT, "before.pdf"), makePdf(plainBefore));
fs.writeFileSync(path.join(OUT, "after.pdf"), makePdf(plainAfter));

// register for the plain set: paragraph ordinals 2 (c1), 4 (c2), 7 (c3), 6 (c4)
const plainRow = (n: number, ord: number, comment: string, reply: string, type = "Author") => ({
  Number: n, document: "Product Specification", "page number": 1,
  location: "Paragraph", "location number": ord,
  comment, "comment type": type, "reply by author": reply, "external reply": "",
  "external participant": "", participant: "R. Jansen", status: "accepted", processed: "yes",
});
const plainRows = [
  plainRow(1, 2, "Please specify the degree of protection of the enclosure (IP rating).", "Added IP67 rating."),
  plainRow(2, 4, "Change the reporting interval to 250 ms.", "Checked — interval already correct."),
  plainRow(3, 7, "Add '(full scale)' to the accuracy value.", "Clarified the accuracy reference."),
  plainRow(4, 6, "Remove the deprecated firmware statement and require firmware 2.x.", "Reworded."),
];
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(plainRows), "Comments");
XLSX.writeFile(wb2, path.join(OUT, "comments-plain.xlsx"));
console.log("plain fixtures (md + pdf + comments-plain.xlsx) written");
