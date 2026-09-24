# Document Review Validation Tool — Working Prototype

Validates human rework: compares the **before-review document**, the **after-review document**
and the **comments register (XLSX, pre-filtered: accepted + processed=yes)**, and produces
per-comment verdicts + a deterministic report. The agent never edits anything.

Implements the v2 architecture (`../hengelo-doc-review-architecture.md`) as a walking skeleton:

- **Backend (Node + TypeScript)** — pre-pass (docx parse, XLSX normalize, anchoring, aligned
  diff, `[auto]` DOC checks), run store with JSONL audit transcripts, guards, report rendering,
  HTTP API + minimal UI.
- **pi as agent runtime** (`@earendil-works/pi-agent-core` + `pi-ai`) — one agent session per
  task. **The backend calls pi (`spawnAgent`), and the pi agent calls tools that are connected
  straight back into the backend API** (`src/agent/tools.ts`). State is only ever written by the
  app after validation — pi is transport, the app is bouncer.
- **Deterministic, model-server-free end-to-end test** via pi-ai's faux provider
  (`npm run e2e`) — the scripted "oracle" follows the system prompt workflow: `getDiff` →
  `writeResult` per comment → guarded `completeTask`.

## Quick start

```bash
npm install
npm run fixtures   # generates test/fixtures/{before.docx, after.docx, comments.xlsx}
npm run e2e        # full pipeline, no model server needed (faux provider)
npm start          # HTTP API + UI on http://localhost:3000 (MODEL_MODE=faux default)
```

## Real local model (Ollama / LM Studio)

```bash
MODEL_MODE=ollama MODEL_ID=qwen3:14b MODEL_BASE_URL=http://localhost:11434/v1 npm start
```

Wiring follows pi's documented custom-provider pattern (`openai-completions` API against an
OpenAI-compatible endpoint) — see `src/agent/runtime.ts`. Fully air-gapped: no egress beyond
the configured endpoint.

## Layout

```
src/
  types.ts             domain types (verdicts, tasks, findings) — runtime-agnostic
  prepass/
    docx.ts            structural docx parsing (blocks: paragraphs/headings/tables)
    register.ts        comments XLSX → typed records + export-scope sanity check
    diff.ts            LCS-aligned block diff (before ↔ after)
    anchor.ts          comment anchoring: location type+ordinal, content fallback
    index.ts           buildRun: full run snapshot + [auto] DOC-* checks
  store.ts             in-memory + JSON runs, per-task JSONL tool-call transcript
  agent/
    runtime.ts         SWAP BOUNDARY — the only module that knows pi exists
    prompts.ts         XML-tag system prompts (from hengelo-doc-review-prompts.md)
    tools.ts           tool bridge: getOverview/getDiff/getOriginalExcerpt/getReviewedExcerpt/
                       searchGlobal/writeResult/writeValidation/completeTask → backend API
  orchestrator.ts      plan tasks → one pi session per task → guards → auto-resume
  report.ts            deterministic verdict rollup + JSON/HTML reports
  server.ts            express API + minimal UI
test/
  make-fixtures.ts     generates the docx pair + register
  e2e.ts               scripted-model end-to-end test (incl. guard rejection test)
```

## Guards (enforced app-side, told in the prompt)

- `writeResult` — verdict must be one of the 4-verdict enum; evidence non-empty; comment must
  be in the task's scope.
- `completeTask` — **rejected** unless every comment in scope has a verdict; agent receives a
  structured error and must fix its output.
- Run verdict — computed deterministically from verdicts + auto-checks
  (`missing`/`incorrectly_applied`/violation ⇒ `needs_changes`). Never the agent's call.

## Known prototype limits (deliberate)

- PDF input not implemented (docx only); `.doc` needs LibreOffice headless conversion.
- Page numbers are heuristic (blocks/45); revision numbers not yet read from footers —
  the DOC-2 auto-check is a placeholder.
- Anchoring: exact block index or content fallback; real version needs wider windows +
  fuzzy content matching (comment relocation, QAM story 8).
- Layout-validator agent is scaffolded (prompt + tools) but not yet scheduled in the
  orchestrator; ruleset loading not wired.
- Plan phase is deterministic grouping (≤10 comments/task); agent-driven planning is the
  next step.
- SQLite → JSON files; concurrency → sequential queue.

Swap boundary: everything pi-specific lives in `src/agent/runtime.ts` (~90 lines). Replacing
pi with another runtime — or running it as a sidecar from a Python backend — is a contained
change; the tools, guards, store and prompts are runtime-agnostic.
