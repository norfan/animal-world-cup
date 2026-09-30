// Verify the seat-reclaim fix on a SCRATCH lan-server (LAN_PORT=13099, via the
// window.__lanPort seam) so the user's running relay on 13001 is untouched.
//
// Scenario: pad A joins (clientId CA) -> gets seat S. WITHOUT closing A's
// socket (semi-open, relay never saw the close), pad B with the SAME clientId
// joins. Before the fix B got a fresh seat (two seats for one phone); after the
// fix B must reclaim A's exact seat and the roster must stay at one pad.
// Usage: node script/verify-reconnect-seat.mjs
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { spawn } from "child_process";

const SCRATCH_PORT = 13099;
const ROOM = "RCR" + Math.floor(1000 + Math.random() * 9000);
const PAGE = `http://localhost:13000/match?play=1&lan=${ROOM}`;
const CA = "verify-same-phone";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// scratch relay on 13099
const relay = spawn(process.execPath, ["script/lan-server.mjs"], {
  env: { ...process.env, LAN_PORT: String(SCRATCH_PORT) },
  cwd: process.cwd(),
  stdio: "ignore",
});
await sleep(1200);

/** Pad client: join with clientId, track seat. */
function makePad(clientId) {
  const pad = { ws: null, padId: null, side: null, number: null, playerId: null, status: "connecting", events: [] };
  pad.ws = new WebSocket(`ws://127.0.0.1:${SCRATCH_PORT}`);
  pad.ws.on("open", () => {
    pad.ws.send(JSON.stringify({ t: "join", room: ROOM, name: clientId, clientId }));
  });
  pad.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    pad.events.push(m.t);
    if (m.t === "joined") {
      pad.padId = m.padId; pad.side = m.side; pad.number = m.number; pad.playerId = m.playerId;
      pad.status = m.started ? "playing" : "ready";
    } else if (m.t === "start") { pad.status = "playing"; }
    else if (m.t === "ended") { pad.status = "ready"; }
  });
  return pad;
}

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // seam: point the page's lan client at the scratch relay
  await page.addInitScript((port) => { window.__lanPort = port; }, SCRATCH_PORT);
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });

  // pad A joins
  const A = makePad(CA);
  for (let i = 0; i < 50 && !A.padId; i += 1) await sleep(100);
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    return !!list && list.some((x) => x.__acHuman);
  }, { timeout: 15000 });
  console.log("[rc] A:", JSON.stringify({ padId: A.padId, side: A.side, number: A.number, playerId: A.playerId, status: A.status }));
  const seatsBefore = await page.evaluate(() => (window.__acPads ? window.__acPads.length : -1));
  console.log("[rc] host 席位数(修复后 A 占 1):", seatsBefore);

  // pad B joins with the SAME clientId while A's socket stays OPEN (semi-open sim)
  const B = makePad(CA);
  for (let i = 0; i < 50 && !B.padId; i += 1) await sleep(100);
  await sleep(500);

  const seatsAfter = await page.evaluate(() => (window.__acPads ? window.__acPads.length : -1));
  console.log("[rc] B:", JSON.stringify({ padId: B.padId, side: B.side, number: B.number, playerId: B.playerId, status: B.status }));
  console.log("[rc] host 席位数(B 重连后):", seatsAfter);

  // B streams input -> the seated player must still move
  let moved = 0;
  await page.evaluate(() => {
    const p = window.__matchGame.pitch;
    const pl = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.__acHuman);
    if (pl) { pl.__x0 = pl.position.x; pl.__y0 = pl.position.y; }
  });
  let seq = 0;
  const iv = setInterval(() => {
    seq += 1;
    if (B.ws.readyState === 1) B.ws.send(JSON.stringify({ t: "input", seq, d: { vx: 0, vy: -0.8, shoot: false, sprint: false } }));
  }, 50);
  await sleep(700);
  clearInterval(iv);
  moved = await page.evaluate(() => {
    const p = window.__matchGame.pitch;
    const pl = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.__acHuman);
    return pl ? Math.hypot(pl.position.x - pl.__x0, pl.position.y - pl.__y0) : -1;
  });

  const sameSeat = B.padId === A.padId;
  const noExtraSeat = seatsAfter === 1;
  console.log("[rc] VERDICT:", (sameSeat && noExtraSeat && moved > 0.3)
    ? "PASS: 同手机重连拿回原席位，无额外占用，玩家可移动"
    : `FAIL: sameSeat=${sameSeat} noExtraSeat=${noExtraSeat} moved=${moved.toFixed(2)}`);
  try { A.ws.close(); } catch {}
  try { B.ws.close(); } catch {}
} finally {
  await browser.close();
  relay.kill();
}
