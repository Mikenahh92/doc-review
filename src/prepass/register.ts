// Register (comments XLSX) normalization. Deterministic pre-pass.
// Expected columns (header names matched case-insensitively):
//   Number | document | page number | location | location number | comment | comment type |
//   reply by author | external reply | external participant | participant | status | processed
// Export scope (confirmed): every row is status=accepted AND processed=yes — enforced loudly.

import * as XLSX from "xlsx";
import type { CommentRecord } from "../types.js";

function pick(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const hit = Object.keys(row).find(
      (h) => h.toLowerCase().replace(/[^a-z]/g, "") === k
    );
    if (hit !== undefined && row[hit] !== undefined && row[hit] !== null) {
      return String(row[hit]).trim();
    }
  }
  return "";
}

export function parseRegister(buffer: Buffer): CommentRecord[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Register XLSX has no sheets");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });

  const out: CommentRecord[] = [];
  for (const row of rows) {
    const number = parseInt(pick(row, ["number", "commentid", "commentnumber"]), 10);
    if (!Number.isFinite(number) || number <= 0) continue; // header junk / blank rows
    out.push({
      number,
      documentTitle: pick(row, ["document", "documenttitle"]),
      page: parseInt(pick(row, ["pagenumber", "page"]), 10) || 0,
      locationType: pick(row, ["location", "locationtype"]),
      locationNumber: parseInt(pick(row, ["locationnumber"]), 10) || 1,
      comment: pick(row, ["comment"]),
      commentType: pick(row, ["commenttype", "type"]),
      replyByAuthor: pick(row, ["replybyauthor", "reply"]),
      externalReply: pick(row, ["externalreply"]),
      externalParticipant: pick(row, ["externalparticipant"]),
      participant: pick(row, ["participant", "commenter"]),
      status: pick(row, ["status"]),
      processed: pick(row, ["processed"]),
    });
  }
  return out;
}

/** Export-scope sanity check: warn loudly if the pre-filter promise is violated. */
export function assertExportScope(comments: CommentRecord[]): string[] {
  const warnings: string[] = [];
  const bad = comments.filter(
    (c) => c.status.toLowerCase() !== "accepted" || c.processed.toLowerCase() !== "yes"
  );
  if (bad.length > 0) {
    warnings.push(
      `Register contains ${bad.length} row(s) outside the expected export scope ` +
      `(status=accepted AND processed=yes), e.g. #${bad[0].number} ` +
      `(status=${bad[0].status || "?"}, processed=${bad[0].processed || "?"}). ` +
      `These are still verified but metadata cross-checks apply.`
    );
  }
  return warnings;
}
