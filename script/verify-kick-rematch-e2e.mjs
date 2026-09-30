// E2E: first pad's KICK OFF (ready) + REMATCH (after ended) buttons.
// Part A (relay core): Node host + two pad pages -> button visibility, tap -> host msg,
//   ended flips the button to REMATCH.
// Part B (lobby kickoff): real /lobby page as host; first pad taps KICK OFF ->
//   the lobby navigates the big screen into /match (pad-triggered start works).
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

  // ---------- Part A: relay core with Node host ----------
  const host = await wsConnect(`ws://127.0.0.1:${PORT}`);
  const hostedP = waitMsg(host, "hosted");
  host.send(JSON.stringify({ t: "host", room: "", squad: 6 }));
  const code = (await hostedP).room;
  console.log("PART A ROOM:", code);

  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const mkPad = async (tag) => {
    const ctx = await browser.newContext({ viewport: { width: 860, height: 420 } });
    await ctx.addInitScript((p) => { window.__lanPort = p; }, PORT);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log(`${tag} ERR:`, m.text().slice(0, 140)); });
    await page.goto(`${BASE}/pad?room=${code}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2500);
    return { ctx, page };
  };

  const { page: padA } = await mkPad("PAD-A");
  const kickA = await padA.$(".pad-ctl-btn--kick");
  check("A: pad1 shows KICK OFF at ready", !!kickA);

  const hStart = waitMsg(host, "start");
  await kickA.tap();
  check("A: pad1 KICK OFF reaches host", (await hStart).t === "start");

  // pad2 must have no control button
  const { ctx: ctxB, page: padB } = await mkPad("PAD-B");
  check("A: pad2 has no kick/rematch button", !(await padB.$(".pad-ctl")));

  // ended -> pad1 flips to REMATCH
  host.send(JSON.stringify({ t: "ended" }));
  await sleep(1200);
  const rematchA = await padA.$(".pad-ctl-btn--rematch");
  check("A: pad1 shows REMATCH after ended", !!rematchA);
  const hRematch = waitMsg(host, "rematch");
  await rematchA.tap();
  check("A: pad1 REMATCH reaches host", (await hRematch).t === "rematch");
  await padA.screenshot({ path: path.join(__dir, "..", ".scratch-pad-rematch.png") });
  await ctxB.close();

  // ---------- Part B: real lobby host, pad-triggered kickoff ----------
  const lobbyCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await lobbyCtx.addInitScript((p) => { window.__lanPort = p; }, PORT);
  const lobby = await lobbyCtx.newPage();
  await lobby.goto(
    `${BASE}/lobby?red=argentina&blue=portugal&side=home&ai=0&time=20&squad=6&teamMode=same&sameSide=blue`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );
  // wait for the room code to appear (hosted -> setRoom replaces the placeholder)
  await lobby.waitForFunction(() => {
    const el = document.querySelector(".lb-code b");
    return el && el.textContent.trim() && !el.textContent.includes("\u00b7\u00b7\u00b7\u00b7");
  }, { timeout: 20000 });
  const roomText = (await lobby.textContent(".lb-code b")).trim();
  console.log("PART B ROOM:", roomText);

  const padCtx = await browser.newContext({ viewport: { width: 860, height: 420 } });
  await padCtx.addInitScript((p) => { window.__lanPort = p; }, PORT);
  const padC = await padCtx.newPage();
  await padC.goto(`${BASE}/pad?room=${roomText}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(2500);
  const kickC = await padC.$(".pad-ctl-btn--kick");
  check("B: first pad sees KICK OFF in lobby", !!kickC);
  await kickC.tap();

  // the lobby host start() must navigate the big screen into /match
  let navOk = false;
  try {
    await lobby.waitForURL(/\/match/, { timeout: 8000 });
    navOk = true;
  } catch {}
  check("B: lobby navigated to /match after pad KICK OFF", navOk, lobby.url());

  await browser.close();
  host.close();
  relay.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("SCRIPT ERROR:", e.message); relay.kill(); process.exit(1); });
