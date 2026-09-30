// E2E: first pad sees zoom buttons and its tap reaches the host via the relay;
// second pad gets no zoom buttons. Uses a TEMP relay (13099) via the __lanPort seam.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dir, "lan-server.mjs");
const PORT = 13099;
const BASE = "http://localhost:13000";
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`);
}
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

const relay = spawn(process.execPath, [RELAY], {
  env: { ...process.env, LAN_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

(async () => {
  await sleep(700);
  // create a room + be the big-screen host on the temp relay
  const host = await wsConnect(`ws://127.0.0.1:${PORT}`);
  const hostedP = waitMsg(host, "hosted");
  host.send(JSON.stringify({ t: "host", room: "", squad: 6 }));
  const hosted = await hostedP;
  const code = hosted.room;
  console.log("ROOM:", code);

  const browser = await chromium.launch({ channel: "msedge", headless: false });
  // context A = first pad (LANDSCAPE — the pad UI requires horizontal orientation)
  const ctxA = await browser.newContext({ viewport: { width: 860, height: 420 } });
  await ctxA.addInitScript((p) => { window.__lanPort = p; }, PORT);
  const padA = await ctxA.newPage();
  padA.on("console", (m) => { if (m.type() === "error") console.log("PAD-A ERR:", m.text().slice(0, 160)); });
  await padA.goto(`${BASE}/pad?room=${code}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(3000);
  console.log("PAD-A state:", JSON.stringify((await padA.textContent(".pad-status-card, .pad")).slice(0, 120)));

  // context B = second pad (separate localStorage -> separate clientId -> new seat)
  const ctxB = await browser.newContext({ viewport: { width: 860, height: 420 } });
  await ctxB.addInitScript((p) => { window.__lanPort = p; }, PORT);
  const padB = await ctxB.newPage();
  await padB.goto(`${BASE}/pad?room=${code}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2500);
  console.log("PAD-B state:", JSON.stringify((await padB.textContent(".pad-status-card, .pad")).slice(0, 120)));

  // wait both joined, then kick off (lock + start)
  await sleep(2500);
  host.send(JSON.stringify({ t: "lock", locked: true }));
  host.send(JSON.stringify({ t: "start", info: null }));
  await sleep(2000);

  const zoomA = await padA.$(".pad-zoom");
  check("pad1 shows zoom buttons", !!zoomA);
  const zoomB = await padB.$(".pad-zoom");
  check("pad2 has NO zoom buttons", !zoomB);

  // pad1 taps zoom-out -> host receives {t:"zoom", d:1/1.18}
  const hZoom = waitMsg(host, "zoom", 4000);
  const btnOut = await padA.$(".pad-zoom-btn--out");
  await btnOut.tap();
  const zm = await hZoom;
  check("host received zoom from pad1", Math.abs(zm.d - 1 / 1.18) < 1e-9, `d=${zm.d}`);

  await padA.screenshot({ path: path.join(__dir, "..", ".scratch-pad-zoom.png") });
  await browser.close();
  host.close();
  relay.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("SCRIPT ERROR:", e.message); relay.kill(); process.exit(1); });
