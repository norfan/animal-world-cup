// Verify LAN relay: only the FIRST pad's t:start / t:rematch reaches the host
// (kickoff + rematch buttons live on the first controller only).
import { spawn } from "node:child_process";
import WebSocket from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(__dir, "lan-server.mjs");
const PORT = 13099;
const HOST = `ws://127.0.0.1:${PORT}`;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  · " + detail : ""}`);
}
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HOST);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitMsg(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + type)), timeout);
    const on = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === type) { clearTimeout(t); ws.off("message", on); resolve(m); }
    };
    ws.on("message", on);
  });
}
function waitNoMsg(ws, type, ms = 1100) {
  return new Promise((resolve) => {
    let hit = false;
    const on = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === type) hit = true;
    };
    ws.on("message", on);
    setTimeout(() => { ws.off("message", on); resolve(!hit); }, ms);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const relay = spawn(process.execPath, [RELAY], {
  env: { ...process.env, LAN_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

async function main() {
  await sleep(700);
  const host = await connect();
  const hostedP = waitMsg(host, "hosted");
  send(host, { t: "host", room: "", squad: 6 });
  const hosted = await hostedP;
  const code = hosted.room;

  const p1 = await connect();
  const p1j = waitMsg(p1, "joined");
  send(p1, { t: "join", room: code, name: "P1", clientId: "c1" });
  await p1j;

  // pad1 start -> host
  const hStart = waitMsg(host, "start");
  send(p1, { t: "start" });
  check("pad1 start reaches host", (await hStart).t === "start");

  // pad1 rematch -> host
  const hRematch = waitMsg(host, "rematch");
  send(p1, { t: "rematch" });
  check("pad1 rematch reaches host", (await hRematch).t === "rematch");

  // pad2 joins; its start/rematch must be blocked
  const p2 = await connect();
  const p2j = waitMsg(p2, "joined");
  send(p2, { t: "join", room: code, name: "P2", clientId: "c2" });
  await p2j;
  const silent1 = waitNoMsg(host, "start", 1100);
  send(p2, { t: "start" });
  check("pad2 start blocked", await silent1);
  const silent2 = waitNoMsg(host, "rematch", 1100);
  send(p2, { t: "rematch" });
  check("pad2 rematch blocked", await silent2);

  // host->pads start/rematch broadcast still works (regression: kickoff path)
  const p1Start = waitMsg(p1, "start");
  send(host, { t: "start", info: { red: "r", blue: "b" } });
  check("host broadcast start still reaches pads", (await p1Start).t === "start");
  const p2Ended = waitMsg(p2, "ended");
  send(host, { t: "ended" });
  check("host ended still reaches pads", (await p2Ended).t === "ended");

  p1.close(); p2.close(); host.close();
  relay.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error("SCRIPT ERROR:", e.message); relay.kill(); process.exit(1); });
