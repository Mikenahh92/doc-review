// Comment anchoring: resolve each register row to a block index in the BEFORE document.
// Primary: location type + location number (ordinal of that element type).
// Fallback: content match (comment text / reply snippet against document text).
// Unanchorable -> method "failed", anchorIndex null (agent must return needs_user — never guess).

import type { CommentAnchor, CommentRecord, ParsedDoc } from "../types.js";

function typeMatch(locationType: string, blockType: string): boolean {
  const lt = locationType.toLowerCase();
  if (blockType === "table") return lt === "table" || lt === "area";
  if (blockType === "heading") return false;
  return lt === "paragraph" || lt === "line" || lt === "requirement";
}

export function anchorComments(
  comments: CommentRecord[],
  before: ParsedDoc
): CommentAnchor[] {
  return comments.map((c) => {
    // 1) location type + ordinal
    const of = before.blocks.filter((b) => typeMatch(c.locationType, b.type));
    const idx = c.locationNumber - 1;
    if (of.length > 0 && idx >= 0 && idx < of.length) {
      return { commentNumber: c.number, anchorIndex: of[idx].index, method: "location" };
    }
    // 2) content fallback: try distinctive fragments of the comment/reply against doc text
    const fragments = [c.replyByAuthor, c.comment]
      .flatMap((s) => s.split(/[.;:]\s+/))
      .map((s) => s.trim())
      .filter((s) => s.length >= 15)
      .sort((a, b) => b.length - a.length);
    for (const frag of fragments) {
      const hit = before.blocks.find((b) =>
        b.text.toLowerCase().includes(frag.slice(0, 40).toLowerCase())
      );
      if (hit) return { commentNumber: c.number, anchorIndex: hit.index, method: "content" };
    }
    return { commentNumber: c.number, anchorIndex: null, method: "failed" };
  });
}
