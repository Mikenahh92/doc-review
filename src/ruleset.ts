// Ruleset system: user-editable markdown rulesets, parsed deterministically,
// snapshotted verbatim into the run at start (no re-reads, no drift mid-run).
//
// Authoring conventions (see hengelo-doc-review-ruleset-starter.md):
//   # Ruleset: <name> (v<version>)          — H1 header, name + version
//   ## <ID>: <rule statement> [auto]        — one section per rule
//   body text until the next `##`/`---`     — explanation, examples, edge cases
// IDs: uppercase prefix + dash + number (DOC-, HDG-, TBL-, FIG-, TXT-, STR-, …).
// `[auto]` rules are enforced by deterministic pre-pass code; the layout agent
// reports them for completeness but does not re-judge them.

import type { Rule, Ruleset } from "./types.js";

const RULE_ID = /^[A-Z][A-Z0-9]*-\d+$/;

export interface ParseResult {
  ruleset: Ruleset | null;
  errors: string[];
}

/** Parse a ruleset markdown document. Returns null ruleset on hard errors. */
export function parseRuleset(markdown: string): ParseResult {
  const errors: string[] = [];
  const lines = markdown.split(/\r?\n/);

  let name = "unnamed";
  let version = "v0";
  const m = lines.find((l) => /^#\s+Ruleset:/i.test(l));
  if (m) {
    const head = m.replace(/^#\s+Ruleset:\s*/i, "");
    const vm = head.match(/\(v[\w.\- ]*\)\s*$/i);
    if (vm) {
      version = vm[0].replace(/^[({]|[,)}]$/g, "").trim();
      name = head.slice(0, vm.index).trim();
    } else {
      name = head.trim();
    }
  } else {
    errors.push("no '# Ruleset: …' header found");
  }

  const rules: Rule[] = [];
  let current: Rule | null = null;
  const bodyLines: string[] = [];
  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      rules.push(current);
    }
    current = null;
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      const text = h2[1];
      const rm = text.match(/^([A-Z][A-Z0-9]*-\d+)\s*:\s*(.+)$/);
      if (!rm) {
        // `## Notes …` style sections are ignored, anything else is a warning
        if (!/^notes/i.test(text)) errors.push(`unrecognized '## ${text.slice(0, 40)}' — expected '## <ID>: statement'`);
        continue;
      }
      const id = rm[1];
      if (rules.some((r) => r.id === id)) errors.push(`duplicate rule id ${id}`);
      let statement = rm[2];
      let auto = false;
      if (/\[auto\]\s*$/i.test(statement)) {
        auto = true;
        statement = statement.replace(/\[auto\]\s*$/i, "").trim();
      }
      if (!RULE_ID.test(id)) errors.push(`invalid rule id ${id}`);
      current = { id, statement, body: "", auto };
      continue;
    }
    if (/^---\s*$/.test(line)) { flush(); continue; }
    if (current) bodyLines.push(line);
  }
  flush();

  if (!rules.length) errors.push("no rules found — need at least one '## <ID>: statement' section");

  if (errors.length) return { ruleset: null, errors };
  return {
    ruleset: { name, version, sourceMarkdown: markdown, rules },
    errors,
  };
}

/** Rules the layout agent judges (non-auto); [auto] rules belong to the pre-pass. */
export function agentRules(rs: Ruleset): Rule[] {
  return rs.rules.filter((r) => !r.auto);
}
