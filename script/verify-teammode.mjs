// Verify LAN same-team (teamMode=same) vs split allocation on a TEMP relay (13099).
// Does NOT touch the user's own 13001 process.
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
  results.push({ name, ok: !!cond, detail: detail || "" });
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
    const t = setTimeout(() => reject(new Error("timeout waiting " + type)), timeout);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === type) { clearTimeout(t); ws.off("message", onMsg); resolve(m); }
    };
    ws.on("message", onMsg);
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const relay = spawn(process.execPath, [RELAY], {
  env: { ...process.env, LAN_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayErr = "";
relay.stderr.on("data", (d) => { relayErr += d; });

async function main() {
  await sleep(700);

  // ============ 1) same-team mode: all phones -> blue, request ignored ============
  const host = await connect();
  const hostedP = waitMsg(host, "hosted");
  send(host, { t: "host", room: "", squad: 6, teamMode: "same", sameSide: "blue" });
  const hosted = await hostedP;
  check("hosted echoes teamMode=same", hosted.teamMode === "same", `teamMode=${hosted.teamMode}`);
  check("hosted echoes sameSide=blue", hosted.sameSide === "blue", `sameSide=${hosted.sameSide}`);
  const code1 = hosted.room;

  const p1 = await connect();
  const p1j = waitMsg(p1, "joined");
  send(p1, { t: "join", room: code1, name: "P1", side: "red" }); // red request must be ignored
  const j1 = await p1j;
  check("same-mode P1 forced to blue", j1.side === "blue", `side=${j1.side}, number=${j1.number}`);

  const p2 = await connect();
  const p2j = waitMsg(p2, "joined");
  send(p2, { t: "join", room: code1, name: "P2" });
  const j2 = await p2j;
  check("same-mode P2 also blue", j2.side === "blue", `side=${j2.side}, number=${j2.number}`);

  const p3 = await connect();
  const p3j = waitMsg(p3, "joined");
  send(p3, { t: "join", room: code1, name: "P3", side: "red" });
  const j3 = await p3j;
  check("same-mode P3 also blue (request ignored)", j3.side === "blue", `side=${j3.side}, number=${j3.number}`);

  const rosterP = waitMsg(host, "roster");
  send(host, { t: "lock", locked: true });
  const roster = await rosterP;
  const bluePads = (roster.pads || []).filter((p) => p.side === "blue").length;
  const redPads = (roster.pads || []).filter((p) => p.side === "red").length;
  check("roster: 3 humans all blue, red empty", bluePads === 3 && redPads === 0, `blue=${bluePads}, red=${redPads}`);

  p1.close(); p2.close(); p3.close();
  send(host, { t: "lock", locked: false });

  // ============ 2) split mode: balanced auto-assign ============
  const host2 = await connect();
  const hosted2P = waitMsg(host2, "hosted");
  send(host2, { t: "host", room: "", squad: 6, teamMode: "split" });
  const hosted2 = await hosted2P;
  check("hosted echoes teamMode=split", hosted2.teamMode === "split", `teamMode=${hosted2.teamMode}`);
  const code2 = hosted2.room;

  const q1 = await connect();
  const q1j = waitMsg(q1, "joined");
  send(q1, { t: "join", room: code2, name: "Q1" });
  const m1 = await q1j;
  const q2 = await connect();
  const q2j = waitMsg(q2, "joined");
  send(q2, { t: "join", room: code2, name: "Q2" });
  const m2 = await q2j;
  const q3 = await connect();
  const q3j = waitMsg(q3, "joined");
  send(q3, { t: "join", room: code2, name: "Q3" });
  const m3 = await q3j;
  const q4 = await connect();
  const q4j = waitMsg(q4, "joined");
  send(q4, { t: "join", room: code2, name: "Q4" });
  const m4 = await q4j;
  check("split Q1 red (first, tie->red)", m1.side === "red", `side=${m1.side}`);
  check("split Q2 blue (balance)", m2.side === "blue", `side=${m2.side}`);
  check("split Q3 red (red has fewer)", m3.side === "red", `side=${m3.side}`);
  check("split Q4 blue (balance)", m4.side === "blue", `side=${m4.side}`);
  q1.close(); q2.close(); q3.close(); q4.close();

  // ============ 3) same-team with squad=2 cap: 3rd phone refused ============
  const host3 = await connect();
  const hosted3P = waitMsg(host3, "hosted");
  send(host3, { t: "host", room: "", squad: 2, teamMode: "same", sameSide: "red" });
  const hosted3 = await hosted3P;
  const code3 = hosted3.room;
  const r1 = await connect();
  const r1j = waitMsg(r1, "joined");
  send(r1, { t: "join", room: code3, name: "R1" });
  const s1 = await r1j;
  const r2 = await connect();
  const r2j = waitMsg(r2, "joined");
  send(r2, { t: "join", room: code3, name: "R2" });
  const s2 = await r2j;
  const r3 = await connect();
  const r3e = waitMsg(r3, "joinErr");
  send(r3, { t: "join", room: code3, name: "R3" });
  const e3 = await r3e;
  check("same squad=2 cap: R1/R2 red", s1.side === "red" && s2.side === "red", `n=${s1.number},${s2.number}`);
  check("same squad=2 cap: R3 refused (full)", e3.reason === "full", `reason=${e3.reason}`);
  r1.close(); r2.close(); r3.close();

  host.close(); host2.close(); host3.close();
  relay.kill();
  await sleep(300);

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) { console.error("RELAY ERR:\n" + relayErr.slice(0, 2000)); process.exit(1); }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("SCRIPT ERROR:", e.message);
  relay.kill();
  process.exit(1);
});
