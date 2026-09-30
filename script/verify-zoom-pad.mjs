// Verify LAN camera-zoom relay: only the FIRST pad's zoom reaches the host,
// and occupancy carries zoomControl so only that pad's UI shows zoom buttons.
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
function waitNoMsg(ws, type, ms = 1200) {
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

  // host + room (split mode default)
  const host = await connect();
  const hostedP = waitMsg(host, "hosted");
  send(host, { t: "host", room: "", squad: 6 });
  const hosted = await hostedP;
  const code = hosted.room;

  // pad1 joins first
  const p1 = await connect();
  const p1j = waitMsg(p1, "joined");
  send(p1, { t: "join", room: code, name: "P1", clientId: "c1" });
  await p1j;
  const occ1 = waitMsg(p1, "occupancy");
  send(p1, { t: "occupancy" }); // trigger? no — occupancy is pushed; just wait for it
  const o1 = await occ1;
  check("pad1 zoomControl=true (first pad)", o1.zoomControl === true, `zoomControl=${o1.zoomControl}`);

  // pad1 zoom -> host receives
  const hZoom = waitMsg(host, "zoom");
  send(p1, { t: "zoom", d: 1.18 });
  const zm = await hZoom;
  check("pad1 zoom reaches host", Math.abs(zm.d - 1.18) < 1e-9, `d=${zm.d}`);

  // pad2 joins second
  const p2 = await connect();
  const p2j = waitMsg(p2, "joined");
  send(p2, { t: "join", room: code, name: "P2", clientId: "c2" });
  await p2j;
  const occ2 = waitMsg(p2, "occupancy");
  const o2 = await occ2;
  check("pad2 zoomControl=false", o2.zoomControl === false, `zoomControl=${o2.zoomControl}`);

  // pad2 zoom must NOT reach host
  const silent = waitNoMsg(host, "zoom", 1200);
  send(p2, { t: "zoom", d: 1 / 1.18 });
  check("pad2 zoom blocked", await silent);

  // reconnect: pad1 drops and re-joins (held -> same seat) and KEEPS control
  p1.close();
  await sleep(300);
  const p1b = await connect();
  const p1bj = waitMsg(p1b, "joined");
  send(p1b, { t: "join", room: code, name: "P1", clientId: "c1" });
  const j1b = await p1bj;
  check("pad1 rejoin resumes", j1b.resumed === true || j1b.side != null, `resumed=${j1b.resumed}`);
  const occ1b = waitMsg(p1b, "occupancy");
  const o1b = await occ1b;
  check("pad1 keeps zoomControl after reconnect", o1b.zoomControl === true, `zoomControl=${o1b.zoomControl}`);

  p1b.close(); p2.close(); host.close();
  relay.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error("SCRIPT ERROR:", e.message); relay.kill(); process.exit(1); });
