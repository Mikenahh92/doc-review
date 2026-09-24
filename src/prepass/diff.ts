// Aligned paragraph-level diff between before/after documents (LCS over normalized block text).
// Deterministic pre-pass; no LLM.

import type { DiffHunk, ParsedDoc } from "../types.js";

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

interface LcsCell { len: number; dir: "diag" | "up" | "left"; }

export function diffDocs(before: ParsedDoc, after: ParsedDoc): DiffHunk[] {
  const A = before.blocks.map((b) => norm(b.text));
  const B = after.blocks.map((b) => norm(b.text));
  const n = A.length, m = B.length;

  // LCS table (fine for prototype scale; production would use Myers/Hirschberg)
  const dp: LcsCell[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => ({ len: 0, dir: "up" as const }))
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j]
          ? { len: dp[i + 1][j + 1].len + 1, dir: "diag" }
          : dp[i + 1][j].len >= dp[i][j + 1].len
            ? { len: dp[i + 1][j].len, dir: "up" }
            : { len: dp[i][j + 1].len, dir: "left" };
    }
  }

  // Walk and collect change runs
  const hunks: DiffHunk[] = [];
  let i = 0, j = 0, h = 0;
  while (i < n && j < m) {
    if (dp[i][j].dir === "diag") { i++; j++; continue; }
    const bi = i, aj = j;
    while (i < n && j < m && dp[i][j].dir !== "diag") {
      if (dp[i][j].dir === "up") i++; else j++;
    }
    // trailing unmatched tail
    const removedEnd = i, addedEnd = j;
    const bTxt = before.blocks.slice(bi, removedEnd);
    const aTxt = after.blocks.slice(aj, addedEnd);
    const kind: DiffHunk["kind"] =
      bTxt.length > 0 && aTxt.length > 0 ? "changed" : bTxt.length > 0 ? "removed" : "added";
    hunks.push({
      id: `h${++h}`,
      kind,
      beforeIndex: bTxt.length ? bTxt[0].index : undefined,
      afterIndex: aTxt.length ? aTxt[0].index : undefined,
      beforeText: bTxt.map((b) => b.text).join("\n"),
      afterText: aTxt.map((b) => b.text).join("\n"),
    });
  }
  while (i < n || j < m) {
    const bTxt = before.blocks.slice(i, n);
    const aTxt = after.blocks.slice(j, m);
    hunks.push({
      id: `h${++h}`,
      kind: bTxt.length && aTxt.length ? "changed" : bTxt.length ? "removed" : "added",
      beforeIndex: bTxt.length ? bTxt[0].index : undefined,
      afterIndex: aTxt.length ? aTxt[0].index : undefined,
      beforeText: bTxt.map((b) => b.text).join("\n"),
      afterText: aTxt.map((b) => b.text).join("\n"),
    });
    i = n; j = m;
  }
  return hunks;
}
