# doc-review (ReWork Check)

Validates human rework: compares the **before-review document**, the **after-review document**
and the **comments register (XLSX, pre-filtered: accepted + processed=yes)**, and produces
per-comment verdicts + a deterministic report. **The agent never edits anything.**

- **Inputs:** `.docx`, `.pdf` or `.md` for both documents (same format for the pair), `.xlsx` for
  the comments register. PDF requires a text-based file (scanned images are not supported).
- **Architecture:** deterministic pre-pass (parse → anchor every comment → aligned diff → `[auto]`
  doc checks) builds the complete run map before any LLM task starts. Verify agents work per task
  through guarded tools; the verdict is computed deterministically from collected results — never
  by the agent. Per-task JSONL transcripts give a full audit trail.
- **Agent runtime:** [pi](https://github.com/badlogic/pi-mono) sessions — one fresh session per
  task. Runs against any OpenAI-compatible endpoint (remote), an Ollama server (air-gapped), or a
  deterministic faux provider for model-free tests.
- **Resumability:** parallel worker pool with per-task attempts; guarded completion refuses to
  finish until every comment has a verdict.

## Run in Docker

```sh
docker run -d --name doc-review -p 3000:3000 \
  -e MODEL_MODE=remote \
  -e MODEL_BASE_URL=https://api.example.com/v1 \
  -e MODEL_ID=your-model \
  -e MODEL_API_KEY=your-key \
  -v doc-review-runs:/app/runs \
  ghcr.io/mikenahh92/doc-review:latest
# UI: http://localhost:3000
```

## Run in Podman

```sh
podman run -d --name doc-review -p 3000:3000 \
  -e MODEL_MODE=ollama \
  -e MODEL_BASE_URL=http://host.containers.internal:11434/v1 \
  -e MODEL_ID=llama3.1 \
  -v doc-review-runs:/app/runs \
  ghcr.io/mikenahh92/doc-review:latest
```

Podman notes:
- Runs rootless by default; the container needs no special privileges.
- Reaching an Ollama server on the host uses `host.containers.internal` (Docker's
  `host.docker.internal` does not exist in Podman).
- The image is also fully usable with `podman load` from an exported OCI archive for
  air-gapped installs: `podman save --format oci-archive ghcr.io/mikenahh92/doc-review -o doc-review.tar`
  on a connected machine, then `podman load -i doc-review.tar` on the target.

## Model settings

All runtime settings are editable in the UI (⚙ settings): mode (`remote` / `ollama` / `faux`),
model id (with live model list fetched from the endpoint's `/models`), base URL, API key,
parallel tasks, and attempts per task. They are persisted to `settings.json` inside the
container; environment variables act as defaults, so a fully env-configured deployment never
needs the UI.

## Local development

```sh
npm ci
npm run build
npm run fixtures    # small docx/md/pdf fixture pairs + comments registers
npm run benchmark   # 60-page benchmark set (test/fixtures/bench) with ground truth
npm run e2e         # full end-to-end without a model server (faux provider oracle)
npm start           # API + UI on :3000
```

## API

- `POST /api/runs` — `{ before:{filename,contentB64}, after:{...}, register:{...} }` → `{runId}`
- `GET /api/runs` · `GET /api/runs/:id` — list/detail (tasks, verdicts, findings)
- `GET /api/runs/:id/comments/:num` — register row + anchor + before/after excerpts + verdict
- `GET /api/runs/:id/report.html` · `/api/runs/:id/export.json` · `/api/runs/:id/transcript/:taskId`
- `GET/PUT /api/settings` · `GET /api/settings/models`

## Benchmark

`test/fixtures/bench/` contains a 60-page document pair + 25-comment register with mixed edit
outcomes (correct / wrong / missing) and `ground_truth.json` for scoring. Latest container run
(glm-5.3-flash): 25/25 correct verdicts in ~4 minutes.
