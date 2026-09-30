// Quick visual check: pad zoom group moved up to top:34px.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dir, "lan-server.mjs");
const PORT = 13099;
const BASE = "http://localhost:13000";

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function waitMsg(ws, type, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + type)), timeout);
    const on = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === type) { clearTimeout(t); ws.off("message", on); resolve(m); }
    };
    ws.on("message", on);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const relay = spawn(process.execPath, [RELAY], {
    env: { ...process.env, LAN_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await sleep(700);
  const host = await wsConnect(`ws://127.0.0.1:${PORT}`);
  const hostedP = waitMsg(host, "hosted");
  host.send(JSON.stringify({ t: "host", room: "", squad: 6 }));
  const code = (await hostedP).room;

  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const ctx = await browser.newContext({ viewport: { width: 860, height: 420 } });
  await ctx.addInitScript((p) => { window.__lanPort = p; }, PORT);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/pad?room=${code}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2200);
  host.send(JSON.stringify({ t: "lock", locked: true }));
  host.send(JSON.stringify({ t: "start", info: null }));
  await sleep(1800);

  const box = await page.$eval(".pad-zoom", (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left };
  });
  console.log("pad-zoom box:", JSON.stringify(box));
  await page.screenshot({ path: path.join(__dir, "..", ".scratch-pad-zoom-up.png") });
  await browser.close();
  host.close();
  relay.kill();
  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
