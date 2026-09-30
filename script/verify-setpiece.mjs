// Verify the seat-taker set-piece fix: with a simulated LAN seat, force the
// seated player into ThrowInRequestHuman and confirm acUnstickSetPieces routes
// it to HumanThrowIn (engine's team.isAI branch would otherwise activateAI).
// Usage: node script/verify-setpiece.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://localhost:13000/match?play=1";

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  console.log("[sp] opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  console.log("[sp] loaded, waiting for match to start...");
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && (g.pitch.matchStarted || (g.pitch.states && g.pitch.states.current && g.pitch.states.current.constructor.name === "Match"));
  }, { timeout: 60000 });
  console.log("[sp] match live — injecting fake seat (red #4)...");
  await page.evaluate(() => {
    window.__acPads = [{
      padId: "verify-seat-1", side: "red", playerId: 4,
      color: 0xffc233, name: "V", number: 4, ready: true, suspended: false,
      ti: { active: false, vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false },
    }];
  });
  // wait for the seat to bind
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    if (!list) return false;
    for (let i = 0; i < list.length; i += 1) if (list[i].id === 4 && list[i].__acHuman) return true;
    return false;
  }, { timeout: 15000 });
  console.log("[sp] seat bound (__acHuman=true)");

  const result = await page.evaluate(async () => {
    const out = { forced: null, after1: null, after2: null, stuck: [], playerState: null };
    const p = window.__matchGame.pitch;
    const st = window.require("players/states");
    const player = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.id === 4);
    // sanity: current state before forcing
    out.before = player.states.current ? player.states.current.constructor.name : "none";
    // force the taker into ThrowInRequestHuman (as the engine does on a throw-in)
    try {
      player.states.change(st.ThrowInRequestHuman);
      out.forced = player.states.current.constructor.name;
    } catch (e) { out.forced = "ERR:" + (e && e.message); }
    await new Promise((r) => setTimeout(r, 300)); // a few frames of acSyncPads
    out.after1 = player.states.current ? player.states.current.constructor.name : "none";
    await new Promise((r) => setTimeout(r, 300));
    out.after2 = player.states.current ? player.states.current.constructor.name : "none";
    out.stuck = (window.__acStuck || []).slice(-3);
    out.playerState = { hasUser: !!player.user, isAI: !!p.redTeam.isAI, human: !!player.__acHuman };
    return out;
  });

  console.log("[sp] ====== RESULT ======");
  console.log("[sp] 强制前状态:", result.before);
  console.log("[sp] 强制 ThrowInRequestHuman:", result.forced);
  console.log("[sp] 0.3s 后:", result.after1);
  console.log("[sp] 0.6s 后:", result.after2);
  console.log("[sp] 席位信息:", JSON.stringify(result.playerState));
  console.log("[sp] __acStuck 最近记录:", JSON.stringify(result.stuck));
  const ok = result.after1 === "HumanThrowIn" || result.after2 === "HumanThrowIn";
  console.log("[sp] " + (ok ? "PASS: 席位发球者被路由到 HumanThrowIn（玩家可发球）" : "FAIL: 未路由到 HumanThrowIn"));
} finally {
  await browser.close();
}
