// Reproduce "after rematch (reload) the seated player cannot move".
// Simulates the LAN seat path: inject __acPads on both halves of the reload.
// Usage: node script/verify-rematch-move.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://localhost:13000/match?play=1";

const SEAT = {
  padId: "verify-seat-1", side: "red", playerId: 4,
  color: 0xffc233, name: "V", number: 4, ready: true, suspended: false,
  ti: { active: false, vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false },
};

async function waitMatch(page) {
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });
}

async function injectSeat(page, { beforeStart = false } = {}) {
  if (beforeStart) {
    // Simulate the LAN relay delivering the roster BEFORE the match boots:
    // the host reloads, re-attaches, and the relay immediately re-publishes
    // the seats while the page is still loading the match.
    await page.evaluate((seat) => { window.__acPads = [seat]; }, SEAT);
    return;
  }
  await page.evaluate((seat) => { window.__acPads = [seat]; }, SEAT);
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    if (!list) return false;
    for (let i = 0; i < list.length; i += 1) if (list[i].id === 4 && list[i].__acHuman) return true;
    return false;
  }, { timeout: 15000 });
}

async function probeMove(page, label) {
  const r = await page.evaluate(async (lbl) => {
    const p = window.__matchGame.pitch;
    const player = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.id === 4);
    const out = {
      label: lbl,
      pad: window.__acPads && window.__acPads.length,
      padsState: window.__acPadsState,
      human: !!player.__acHuman,
      user: !!player.user,
      state: player.states.current ? player.states.current.constructor.name : "none",
      posBefore: { x: +player.position.x.toFixed(2), y: +player.position.y.toFixed(2) },
      speedBefore: +player.speed.toFixed(2),
    };
    // push movement input for ~600ms
    window.__acPads[0].ti = { active: true, vx: 0, vy: -0.8, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false };
    await new Promise((r) => setTimeout(r, 600));
    window.__acPads[0].ti = { active: false, vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false };
    out.posAfter = { x: +player.position.x.toFixed(2), y: +player.position.y.toFixed(2) };
    out.speedAfter = +player.speed.toFixed(2);
    out.moved = Math.hypot(out.posAfter.x - out.posBefore.x, out.posAfter.y - out.posBefore.y);
    out.stuck = (window.__acStuck || []).slice(-4);
    return out;
  }, label);
  console.log(`[rm] ====== ${label} ======`);
  console.log("[rm]   pads:", r.pad, "| padsState:", JSON.stringify(r.padsState));
  console.log("[rm]   human:", r.human, "user:", r.user, "state:", r.state);
  console.log("[rm]   pos:", JSON.stringify(r.posBefore), "->", JSON.stringify(r.posAfter), "moved:", r.moved.toFixed(3), "speed:", r.speedBefore, "->", r.speedAfter);
  if (r.stuck && r.stuck.length) console.log("[rm]   stuck:", JSON.stringify(r.stuck));
  return r;
}

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitMatch(page);
  await injectSeat(page);

  const first = await probeMove(page, "第一局（注入席位后）");

  // ---- rematch: reload the page. The LAN relay re-delivers the roster
  // IMMEDIATELY (before the match boots) — this is the real 2nd-half timing. ----
  console.log("[rm] reloading (rematch)...");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  // inject BEFORE the match is live, like the relay's pushRoster would
  await injectSeat(page, { beforeStart: true });
  await waitMatch(page);
  // if the seat bound itself, it was pending -> check binding came through
  const bound = await page.evaluate(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    const pl = list && list.find((x) => x.id === 4);
    return {
      human: !!pl && !!pl.__acHuman,
      padsState: window.__acPadsState,
      padUser: !!(window.__acPads && window.__acPads[0] && window.__acPads[0].__user),
      padPlayer: !!(window.__acPads && window.__acPads[0] && window.__acPads[0].__player),
    };
  });
  console.log("[rm] 第二局开球后绑定检查:", JSON.stringify(bound));

  const second = await probeMove(page, "第二局（reload + 席位重注入）");

  const verdict = first.moved > 0.3 && second.moved > 0.3 ? "PASS: 两局均可移动" :
    (first.moved > 0.3 && second.moved <= 0.3 ? "FAIL: 第二局无法移动（复现！）" :
    "INFO: 观察结果见上");
  console.log("[rm] VERDICT:", verdict);
} finally {
  await browser.close();
}
