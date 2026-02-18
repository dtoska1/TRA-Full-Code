"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function hostnameOf(u) {
  try {
    return new URL(u).hostname.replace(/[^a-z0-9.\-]/gi, "_").toLowerCase();
  } catch {
    return "unknown-host";
  }
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(3)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error(
      "Usage: node scripts/pw_capture_state.js <url> [--waitMs=15000] [--steps=3]"
    );
    process.exit(2);
  }

  const args = parseArgs(process.argv);
  const waitMs = Math.max(1000, toInt(args.waitMs, 15000));
  const steps = Math.max(1, Math.min(12, toInt(args.steps, 3)));

  const outDir = path.join(__dirname, "..", ".pw_state");
  ensureDir(outDir);

  const host = hostnameOf(url);
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(outDir, `${host}_${runStamp}`);
  ensureDir(runDir);

  const profileDir = path.join(outDir, "profiles", host);
  ensureDir(profileDir);

  const summaryPath = path.join(runDir, "summary.json");

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ["--start-maximized"],
    viewport: null,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] || (await context.newPage());
  const perStepWaitMs = Math.max(1000, Math.floor(waitMs / steps));

  console.log(`Opening: ${url}`);
  console.log("Diagnostics-only mode. No bypass/solve actions are performed.");
  console.log(`Output directory: ${runDir}`);

  const summary = {
    requestedUrl: url,
    status: null,
    finalUrl: null,
    title: null,
    cloudflareChallengeDetected: false,
    capturedAtUtc: null,
    samples: [],
  };

  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    summary.status = resp ? resp.status() : null;
  } catch (err) {
    summary.navigationError = String(err?.message || err);
  }

  for (let i = 1; i <= steps; i += 1) {
    await sleep(perStepWaitMs);
    const sampleUrl = page.url();
    const sampleTitle = await page.title().catch(() => null);
    const screenshotPath = path.join(runDir, `step_${String(i).padStart(2, "0")}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    summary.samples.push({
      step: i,
      url: sampleUrl,
      title: sampleTitle,
      screenshot: path.basename(screenshotPath),
      atUtc: new Date().toISOString(),
    });
  }

  summary.finalUrl = page.url();
  summary.title = await page.title().catch(() => null);
  summary.cloudflareChallengeDetected = String(summary.finalUrl || "")
    .toLowerCase()
    .includes("__cf_chl");
  summary.capturedAtUtc = new Date().toISOString();

  const statePath = path.join(runDir, "storage_state.json");
  const state = await context.storageState();
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Saved summary: ${summaryPath}`);
  console.log(`Saved storage state: ${statePath}`);

  await context.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
