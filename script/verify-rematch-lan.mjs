// End-to-end rematch verification over the REAL lan-server relay:
//   host page (playwright) + simulated phone pad (node ws client).
// Verifies the fix: after `ended` + reload, LanHostBridge re-sends
// lock+start on ab-match-started so the pad leaves standby and the seated
// player can move again.
// Usage: node script/verify-rematch-lan.mjs
import { chromium } from "playwright-core";
import WebSocket from "ws";

const LAN_WS = "ws://127.0.0.1:13001";
const ROOM = "RMVT" + Math.floor(1000 + Math.random() * 9000);
const PAGE = `http://localhost:13000/match?play=1&lan=${ROOM}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Minimal pad client: joins, tracks status, can stream input. */
function makePad() {
  const pad = {
    ws: null, padId: null, side: null, number: null, playerId: null,
    status: "connecting", events: [], inputSeq: 0, sendInput: false,
  };
  pad.ws = new WebSocket(LAN_WS);
  pad.ws.on("open", () => {
    pad.ws.send(JSON.stringify({ t: "join", room: ROOM, name: "PadV", clientId: "verify-client-v" }));
  });
  pad.ws.on("message", (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    pad.events.push(m.t);
    if (m.t === "joined") {
      pad.padId = m.padId; pad.side = m.side; pad.number = m.number; pad.playerId = m.playerId;
      pad.status = m.started ? "playing" : "ready";
    } else if (m.t === "start") { pad.status = "playing"; }
    else if (m.t === "locked") { /* ui-only on the real pad */ }
    else if (m.t === "ended") { pad.status = "ready"; }
  });
  pad.stream = () => {
    if (!pad.ws || pad.ws.readyState !== 1 || pad.status !== "playing" || !pad.sendInput) return;
    pad.inputSeq += 1;
    pad.ws.send(JSON.stringify({ t: "input", seq: pad.inputSeq, d: { vx: 0, vy: -0.8, shoot: false, sprint: false } }));
  };
  return pad;
}

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });

  // pad joins (host page already created the room via hello/host)
  const pad = makePad();
  await new Promise((resolve) => pad.ws.on("message", resolve));
  for (let i = 0; i < 50 && !pad.padId; i += 1) await sleep(100);

  // wait until the host bound the seat
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    return !!list && list.some((x) => x.__acHuman);
  }, { timeout: 15000 });

  async function moveProbe(label) {
    pad.sendInput = true;
    const iv = setInterval(() => pad.stream(), 50);
    await sleep(700);
    clearInterval(iv);
    pad.sendInput = false;
    const r = await page.evaluate((lbl) => {
      const p = window.__matchGame.pitch;
      const pl = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.__acHuman);
      return {
        label: lbl,
        padStatus: (window.__acPads && window.__acPads[0] && window.__acPads[0].__user) ? "bound" : "no-user",
        padsState: window.__acPadsState,
        state: pl && pl.states.current ? pl.states.current.constructor.name : "none",
        speed: pl ? +pl.speed.toFixed(2) : -1,
        moved: pl ? +Math.hypot(pl.position.x - pl.__x0, pl.position.y - pl.__y0).toFixed(3) : -1,
      };
    }, label);
    return r;
  }

  // snapshot position before each probe
  async function snap() {
    await page.evaluate(() => {
      const p = window.__matchGame.pitch;
      const pl = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.__acHuman);
      if (pl) { pl.__x0 = pl.position.x; pl.__y0 = pl.position.y; }
    });
  }

  console.log("[lan] ROOM", ROOM, "| pad:", pad.padId, pad.side, "#" + pad.number, "playerId", pad.playerId, "status", pad.status);
  await snap();
  const g1 = await moveProbe("第一局");
  console.log("[lan] 第一局:", JSON.stringify(g1));

  // full time -> pads drop to standby
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("ab-match-ended", { detail: { score: [1, 0] } })));
  await sleep(400);
  console.log("[lan] ended 后 pad status:", pad.status, "| 事件:", pad.events.slice(-6).join(","));

  // rematch = reload; LanHostBridge re-attaches, onStarted re-sends lock+start
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });
  // pad socket stays open across the host reload (same ws), relay keeps the seat
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    return !!list && list.some((x) => x.__acHuman);
  }, { timeout: 15000 });
  await sleep(500);
  console.log("[lan] 第二局 pad status:", pad.status);
  await snap();
  const g2 = await moveProbe("第二局");
  console.log("[lan] 第二局:", JSON.stringify(g2));

  const ok = g1.speed > 2 && g2.speed > 2;
  console.log("[lan] VERDICT:", ok ? "PASS: 第一局与第二局玩家均可移动（rematch 修复生效）" : "FAIL: 见上");
  pad.ws.close();
} finally {
  await browser.close();
}
