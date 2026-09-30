// Verify: 1) scoreboard shows real mm:ss; 2) controls legend starts collapsed;
// 3) time param drives the match. Uses the user's running dev server (13000).
// Usage: node script/verify-clock-legend.mjs
import { chromium } from "playwright-core";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("http://localhost:13000/match?play=1&time=10", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });

  // 1) clock: must read mm:ss, e.g. "0:00" shortly after kickoff
  await sleep(2500);
  const clock = await page.evaluate(() => {
    const el = document.querySelector(".ms-clock");
    return el ? el.textContent.trim() : null;
  });
  const clockOk = /^\d{1,2}:\d{2}$/.test(clock || "");

  // cross-check against engine truth: halfTime must be 30*10=300s (5-min half)
  const engine = await page.evaluate(() => {
    const p = window.__matchGame.pitch;
    return { time: Math.round(p.time), halfTime: Math.round(p.halfTime), secondHalf: p.secondHalf };
  });

  // 2) legend: must start COLLAPSED (the "?" pill), not the full card
  const legendCollapsed = await page.evaluate(() => !!document.querySelector(".ctrl-legend__pill"));
  const legendOpen = await page.evaluate(() => !!document.querySelector(".ctrl-legend"));
  // tap the pill -> card expands
  await page.click(".ctrl-legend__pill").catch(() => {});
  await sleep(300);
  const legendAfterTap = await page.evaluate(() => !!document.querySelector(".ctrl-legend"));

  // 3) engine halfTime sanity for time=10
  const halfOk = engine.halfTime === 300;

  console.log("[clk] 比分牌:", clock, "| mm:ss 格式:", clockOk);
  console.log("[clk] 引擎:", JSON.stringify(engine), "| halfTime=300(5分钟半场):", halfOk);
  console.log("[clk] 操作说明默认折叠(pill):", legendCollapsed, "| 未展开(card):", legendOpen === false, "| 点击后展开:", legendAfterTap);
  const pass = clockOk && legendCollapsed && !legendOpen && legendAfterTap && halfOk;
  console.log("[clk] VERDICT:", pass ? "PASS" : "FAIL");
  await page.close();
} finally {
  await browser.close();
}
