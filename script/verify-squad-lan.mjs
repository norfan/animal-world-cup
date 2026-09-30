// Verify the squad-aware seat model on a SCRATCH lan-server (LAN_PORT=13099):
//   - host hello with squad -> hosted.squad / bindable / humansPerSide
//   - pad joins bind only within squad range; counts.ai = squad - humans
//   - picks outside the range are rejected
// Usage: node script/verify-squad-lan.mjs
import WebSocket from "ws";
import { spawn } from "child_process";

const SCRATCH_PORT = 13099;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = spawn(process.execPath, ["script/lan-server.mjs"], {
  env: { ...process.env, LAN_PORT: String(SCRATCH_PORT) },
  cwd: process.cwd(),
  stdio: "ignore",
});
await sleep(1500);

function client() {
  const c = { ws: null, inbox: [], wait: (t, ms) => new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = c.inbox.find((x) => x.t === t);
      if (m) { clearInterval(iv); res(m); }
      else if (Date.now() - t0 > (ms || 5000)) { clearInterval(iv); res(null); }
    }, 50);
  }) };
  c.ws = new WebSocket(`ws://127.0.0.1:${SCRATCH_PORT}`);
  c.ws.on("message", (raw) => { let m; try { m = JSON.parse(String(raw)); } catch { return; } c.inbox.push(m); });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`[squad-lan] ${ok ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
}

let pass = true;

try {
  // --- room A: squad=2 ---
  const host = client();
  await host.wait("open", 2000).catch(() => {});
  host.send({ t: "host", room: "SQR1", squad: 2 });
  const hosted = await host.wait("hosted", 5000);
  check("hosted.squad=2", hosted && hosted.squad === 2, JSON.stringify(hosted && { squad: hosted.squad, bindable: hosted.bindable, humansPerSide: hosted.humansPerSide }));
  check("bindable=[2,3]", hosted && JSON.stringify(hosted.bindable) === "[2,3]", JSON.stringify(hosted && hosted.bindable));
  check("humansPerSide=2", hosted && hosted.humansPerSide === 2, String(hosted && hosted.humansPerSide));

  // pad joins
  const p1 = client();
  await p1.wait("open", 2000).catch(() => {});
  p1.send({ t: "join", room: "SQR1", name: "p1", clientId: "p1" });
  const j1 = await p1.wait("joined", 5000);
  check("p1 joined red number=2", j1 && j1.side === "red" && j1.number === 2, JSON.stringify(j1 && { side: j1.side, number: j1.number, playerId: j1.playerId }));

  const p2 = client();
  await p2.wait("open", 2000).catch(() => {});
  p2.send({ t: "join", room: "SQR1", name: "p2", clientId: "p2" });
  const j2 = await p2.wait("joined", 5000);
  check("p2 joined blue number=2", j2 && j2.side === "blue" && j2.number === 2, JSON.stringify(j2 && { side: j2.side, number: j2.number }));

  const p3 = client();
  await p3.wait("open", 2000).catch(() => {});
  p3.send({ t: "join", room: "SQR1", name: "p3", clientId: "p3" });
  const j3 = await p3.wait("joined", 5000);
  check("p3 joins red number=3 (2 humans/side cap)", j3 && j3.side === "red" && j3.number === 3, j3 ? JSON.stringify({ side: j3.side, number: j3.number }) : "no joined");

  // 4th pad: red is full (2 humans), blue has 1 -> balance assigns blue #3
  const p4 = client();
  await p4.wait("open", 2000).catch(() => {});
  p4.send({ t: "join", room: "SQR1", name: "p4", clientId: "p4" });
  const j4 = await p4.wait("joined", 5000);
  check("p4 joins blue number=3 (balance)", j4 && j4.side === "blue" && j4.number === 3, j4 ? JSON.stringify({ side: j4.side, number: j4.number }) : "no joined");

  // 5th pad: red full + blue full (2 humans each) -> rejected
  const p5 = client();
  await p5.wait("open", 2000).catch(() => {});
  p5.send({ t: "join", room: "SQR1", name: "p5", clientId: "p5" });
  const j5 = await p5.wait("joined", 5000);
  check("p5 rejected (both sides full: 2 humans/side)", j5 === null, j5 ? JSON.stringify(j5) : "no joined (expected)");

  // counts: latest roster (wait a beat so the post-join roster lands)
  await sleep(300);
  const rosters = host.inbox.filter((x) => x.t === "roster");
  const roster = rosters[rosters.length - 1];
  check("counts red humans=2 ai=0 blue humans=2 ai=0", roster && roster.counts && roster.counts.red.humans === 2 && roster.counts.red.ai === 0 && roster.counts.blue.humans === 2 && roster.counts.blue.ai === 0, JSON.stringify(roster && roster.counts));

  // pad pick out of range
  p1.send({ t: "pick", number: 4 });
  const err1 = await p1.wait("pickErr", 3000);
  check("pad pick #4 rejected", err1 && err1.reason === "bad-number", JSON.stringify(err1));

  // host pick out of range
  host.send({ t: "pick", padId: p1.inbox.find((x) => x.t === "joined").padId, number: 4 });
  const err2 = await host.wait("pickErr", 3000);
  check("host pick #4 rejected", err2 && err2.reason === "bad-number", JSON.stringify(err2));

  // --- room B: squad=6 (default) ---
  const host6 = client();
  await host6.wait("open", 2000).catch(() => {});
  host6.send({ t: "host", room: "SQR6" });
  const h6 = await host6.wait("hosted", 5000);
  check("default squad=6 bindable=[2..7]", h6 && h6.squad === 6 && JSON.stringify(h6.bindable) === "[2,3,4,5,6,7]" && h6.humansPerSide === 4, JSON.stringify(h6 && { squad: h6.squad, bindable: h6.bindable, humansPerSide: h6.humansPerSide }));

  // --- room C: squad=5 -> cap humans=4, ai counts ---
  const host5 = client();
  await host5.wait("open", 2000).catch(() => {});
  host5.send({ t: "host", room: "SQR5", squad: 5 });
  const h5 = await host5.wait("hosted", 5000);
  check("squad=5 bindable=[2..6] humans=4", h5 && h5.squad === 5 && JSON.stringify(h5.bindable) === "[2,3,4,5,6]" && h5.humansPerSide === 4, JSON.stringify(h5 && { squad: h5.squad, bindable: h5.bindable, humansPerSide: h5.humansPerSide }));

  const px = client();
  await px.wait("open", 2000).catch(() => {});
  px.send({ t: "join", room: "SQR5", name: "px", clientId: "px" });
  const jx = await px.wait("joined", 5000);
  check("squad5 p1 joins number=2", jx && jx.number === 2, JSON.stringify(jx && { side: jx.side, number: jx.number }));
} catch (e) {
  console.log("[squad-lan] ERROR", e && e.message);
  pass = false;
}

relay.kill();
for (const r of results) if (!r.ok) pass = false;
console.log(pass ? "ALL PASS" : "SOME FAIL");
process.exit(pass ? 0 : 1);
