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
