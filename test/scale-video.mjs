// Scale-run video recorder (DR-39 evidence): drives the web UI through a full
// live run on the fixtures-scale pair and records it as video.
// Usage: node test/scale-video.mjs <http://localhost:3000> <outDir>
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/mikena/openclaw-workspaces/synod/tmp/node_modules/playwright-core");
const ffmpegPath = require("ffmpeg-static");

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = path.resolve(process.argv[3] ?? "test/video-out");
const FIX = path.join(process.cwd(), "test", "fixtures-scale");
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
  log("open UI");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.click("text=New run");
  await page.waitForSelector("#before input", { state: "attached" });
  log("uploading fixtures");
  await page.setInputFiles("#before input", path.join(FIX, "before.docx"));
  await page.setInputFiles("#after input", path.join(FIX, "after.docx"));
  await page.setInputFiles("#register input", path.join(FIX, "comments.xlsx"));
  await sleep(600);
  await page.click("text=Run pre-pass & plan");
  log("run submitted — waiting for detail view");
  await page.waitForSelector("text=Verdicts", { timeout: 120000 });

  // poll API until done/failed (max 30 min)
  let runId = null;
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    const runs = await page.evaluate(async () => (await fetch("/api/runs").then((r) => r.json())).runs ?? []);
    const cur = runs[0];
    if (cur && !runId) { runId = cur.runId; log(`run ${runId} — ${cur.status}`); }
    if (cur && (cur.status === "done" || cur.status === "failed")) {
      log(`final status: ${cur.status} verdict=${cur.verdict}`);
      break;
    }
    if (i % 12 === 0 && runId) {
      const one = await page.evaluate(async (id) => (await fetch(`/api/runs/${id}`).then((r) => r.json())).run, runId);
      log(`poll ${one?.status} tasks=${one?.tasks?.filter((t) => t.status === "done").length}/${one?.tasks?.length}`);
    }
  }

  // show verdicts + a comment detail for the camera
  await page.click("button:has-text(\"Verdicts\")");
  await sleep(1500);
  const row = await page.$("tr.clickable");
  if (row) { await row.click(); await sleep(2000); }
  await page.screenshot({ path: path.join(OUT, "final-verdicts.png"), fullPage: false });
  console.log("RUN_ID=" + runId);
} finally {
  const vid = await (await (page).video())?.path?.();
  await context.close();
  await browser.close();
  // find newest webm and convert
  const webm = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm")).map((f) => ({ f, m: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]?.f;
  if (webm) {
    const mp4 = path.join(OUT, "scale-run.mp4");
    log(`converting ${webm} -> mp4`);
    const { execSync } = require("node:child_process");
    execSync(`"${ffmpegPath}" -y -i "${path.join(OUT, webm)}" -c:v libx264 -pix_fmt yuv420p -crf 30 -preset veryfast -an "${mp4}"`, { stdio: "inherit" });
    console.log("VIDEO=" + mp4);
  }
}
