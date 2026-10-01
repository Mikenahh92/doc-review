// Attach recorder: film an existing run's live progress to completion.
// Usage: node test/attach-video.mjs <base> <runId> <outDir>
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/mikena/openclaw-workspaces/synod/tmp/node_modules/playwright-core");
const ffmpegPath = require("ffmpeg-static");

const BASE = process.argv[2] ?? "http://localhost:3100";
const RUN_ID = process.argv[3];
const OUT = path.resolve(process.argv[4] ?? "test/video-out");
fs.mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: "/home/mikena/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 820 } },
});
const page = await context.newPage();

try {
  log(`open UI, attach to ${RUN_ID}`);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click(`.runrow:has-text("${RUN_ID}")`);
  await page.waitForSelector("text=Verdicts", { timeout: 60000 });

  for (let i = 0; i < 420; i++) {
    await sleep(5000);
    const run = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`).then((r) => r.json())).run, RUN_ID);
    if (!run) continue;
    const done = run.tasks.filter((t) => t.status === "done").length;
    const verdicts = run.tasks.reduce((n, t) => n + (t.results?.length ?? 0), 0);
    if (i % 6 === 0) log(`${run.status} tasks ${done}/${run.tasks.length} verdicts ${verdicts}/${run.commentCount}`);
    if (run.status === "done" || run.status === "failed") { log(`final: ${run.status} verdict=${run.verdict}`); break; }
  }

  await page.click("button:has-text(\"Verdicts\")");
  await sleep(1500);
  const row = await page.$("tr.clickable");
  if (row) { await row.click(); await sleep(2000); }
  await page.screenshot({ path: path.join(OUT, "final-verdicts.png") });
} finally {
  await context.close();
  await browser.close();
  const webm = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => ({ f, m: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f;
  if (webm) {
    const mp4 = path.join(OUT, "scale-run.mp4");
    log(`converting ${webm} -> mp4`);
    const { execSync } = require("node:child_process");
    execSync(`"${ffmpegPath}" -y -i "${path.join(OUT, webm)}" -c:v libx264 -pix_fmt yuv420p -crf 30 -preset veryfast -an "${mp4}"`, { stdio: "inherit" });
    console.log("VIDEO=" + mp4);
  }
}
