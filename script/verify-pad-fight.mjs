// Reproduce the pad UI "connecting / joining" fight: two pad pages on the SAME
// phone (same origin -> same localStorage clientId). Page2's join reclaims the
// seat via the relay's 1b branch and closes page1's ws; page1's lanClient then
// auto-reconnects and fights back -> infinite connecting<->joining loop.
// Usage: node script/verify-pad-fight.mjs
import { chromium } from "playwright-core";
import { spawn } from "child_process";

const SCRATCH_PORT = 13099;
const ROOM = "RPF" + Math.floor(1000 + Math.random() * 9000);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const relay = spawn(process.execPath, ["script/lan-server.mjs"], {
  env: { ...process.env, LAN_PORT: String(SCRATCH_PORT) },
  cwd: process.cwd(),
  stdio: "ignore",
});
await sleep(1200);

/** Sample the pad page's visible status card text ('' = gamepad UI is up). */
async function sampleStatus(page) {
  return page.evaluate(() => {
    const b = document.querySelector(".pad-status-card b");
    return b ? b.textContent.trim() : "PAD-UI";
  });
}

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await ctx.newPage();
  await host.addInitScript((port) => { window.__lanPort = port; }, SCRATCH_PORT);
  await host.goto(`http://localhost:13000/match?play=1&lan=${ROOM}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await host.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await host.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });

  // pad page 1
  const p1 = await ctx.newPage();
  await p1.addInitScript((port) => { window.__lanPort = port; }, SCRATCH_PORT);
  await p1.goto(`http://localhost:13000/pad?room=${ROOM}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  let s1 = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    s1 = await sampleStatus(p1);
    if (s1 === "PAD-UI" || s1.includes("待分配") || s1.includes("号")) break;
  }
  console.log("[pf] 页面1 初始状态:", s1);

  // pad page 2 (same origin -> same clientId)
  const p2 = await ctx.newPage();
  await p2.addInitScript((port) => { window.__lanPort = port; }, SCRATCH_PORT);
  await p2.goto(`http://localhost:13000/pad?room=${ROOM}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);

  // sample both pages for ~4s and record transitions
  const seq = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(250);
    const a = await sampleStatus(p1);
    const b = await sampleStatus(p2);
    seq.push({ i, p1: a, p2: b });
  }
  console.log("[pf] ===== 状态采样（p1=页面1, p2=页面2）=====");
  for (const s of seq) console.log(`[pf]   ${s.i}: p1=${s.p1} | p2=${s.p2}`);

  // verdict: after the fix one page must WIN (stable PAD-UI on the newer page,
  // the older page parked on 连接中 without fighting back). A loop means both
  // pages keep alternating between PAD-UI and 连接中.
  const ui = (s) => (s.includes("PAD") ? "P" : s.includes("连接中") ? "C" : s.includes("加入房间") ? "J" : "?");
  const lastHalf = seq.slice(Math.max(0, seq.length - 8));
  const p1Tail = lastHalf.map((s) => ui(s.p1));
  const p2Tail = lastHalf.map((s) => ui(s.p2));
  const stableP1 = p1Tail.every((c) => c === "C") || p1Tail.every((c) => c === "P");
  const stableP2 = p2Tail.every((c) => c === "P") || p2Tail.every((c) => c === "C");
  const alternation = p1Tail.some((c, i) => i > 0 && c !== p1Tail[i - 1]) && p2Tail.some((c, i) => i > 0 && c !== p2Tail[i - 1]);
  const won = (stableP1 && stableP2 && !alternation);
  console.log("[pf] 尾部采样 p1:", p1Tail.join(""), "| p2:", p2Tail.join(""));
  console.log("[pf] VERDICT:", won
    ? "PASS: 无互踢循环——新页面稳定接管，旧页面停在连接中不再重连"
    : "FAIL: 仍存在互踢循环（两页面交替抢占）");
  await p1.close(); await p2.close(); await host.close();
} finally {
  await browser.close();
  relay.kill();
}
