// E2E (English UI): same-team mode blue — phone joins blue, start becomes enabled.
import { chromium } from "playwright-core";
import WebSocket from "ws";
import path from "node:path";

const BASE = "http://localhost:13000";
const RELAY = "ws://127.0.0.1:13001";
const SHOT = path.join("D:\\game\\github\\animal-world-cup", ".scratch-gate-fix.png");

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

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const wsFrames = [];
  page.on("websocket", (ws) => {
    wsFrames.push(`OPEN ${ws.url()}`);
    ws.on("framesent", (e) => { try { const m = JSON.parse(e.payload); wsFrames.push(`SENT ${m.t}`); } catch {} });
    ws.on("framereceived", (e) => { try { const m = JSON.parse(e.payload); wsFrames.push(`RECV ${m.t}`); } catch {} });
    ws.on("close", () => wsFrames.push("CLOSE"));
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("text=Same team", { timeout: 60000 });
  await page.waitForTimeout(1000);

  // same-team + blue
  await page.click("text=Same team");
  await page.waitForTimeout(400);
  await page.click("text=Blue");
  await page.waitForTimeout(300);
  await page.click("text=LAN Versus");
  await page.waitForURL(/\/lobby\?/, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const codeEl = await page.$(".lb-code b");
  const code = codeEl ? (await codeEl.textContent()).trim() : "";
  check("room code read", /^[A-Z0-9]{4}$/.test(code), code);

  let body = await page.textContent("body");
  check("note says Blue needs a phone", body.includes("Blue needs at least one phone"), "");
  const startBtn = await page.$("button:has-text('Start Match')");
  check("start disabled before any phone", (await startBtn.isDisabled()) === true);

  const pad = await wsConnect(RELAY);
  const joinedP = waitMsg(pad, "joined");
  pad.send(JSON.stringify({ t: "join", room: code, name: "PhoneA" }));
  const joined = await joinedP;
  check("phone joined blue (same-team)", joined.side === "blue", `side=${joined.side}, number=${joined.number}`);
  // KEEP the pad open: closing here makes the relay release the seat and push
  // an empty roster, wiping the UI state we are about to assert.
  await page.waitForTimeout(3000);
  body = await page.textContent("body");
  check("note now ready", body.includes("kick off when ready"), "");
  const startBtn2 = await page.$("button:has-text('Start Match')");
  check("start enabled after blue phone", (await startBtn2.isDisabled()) === false);
  pad.close(); // now safe to drop the phone
  console.log("WS FRAMES:", JSON.stringify(wsFrames.slice(-24)));

  await page.screenshot({ path: SHOT });
  console.log("SHOT:", SHOT);
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e.message); process.exit(1); });
