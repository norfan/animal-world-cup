// Diagnose why the seat-taker set-piece route did not fire.
// Usage: node script/diag-setpiece.mjs [url]
import { chromium } from "playwright-core";

const url = process.argv[2] || "http://localhost:13000/match?play=1";

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForFunction(() => {
    const g = window.__matchGame;
    return g && g.pitch && g.pitch.matchStarted;
  }, { timeout: 60000 });
  await page.evaluate(() => {
    window.__acPads = [{
      padId: "verify-seat-1", side: "red", playerId: 4,
      color: 0xffc233, name: "V", number: 4, ready: true, suspended: false,
      ti: { active: false, vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false },
    }];
  });
  await page.waitForFunction(() => {
    const p = window.__matchGame && window.__matchGame.pitch;
    const list = p && p.redTeam && p.redTeam.allPlayers;
    if (!list) return false;
    for (let i = 0; i < list.length; i += 1) if (list[i].id === 4 && list[i].__acHuman) return true;
    return false;
  }, { timeout: 15000 });

  const diag = await page.evaluate(async () => {
    const out = { padsState: null, padsErrors: [], stuck: [], samples: [], fnCheck: null, jsNew: null };
    // hard proof: what the page would load for the glue script
    try {
      const r = await fetch("/match-runtime-min/standalone-match.js");
      const t = await r.text();
      out.jsNew = { hasReqMap: t.includes("AC_REQ_TO_HUMAN"), hasSeatTaker: t.includes("seat-taker"), len: t.length };
    } catch (e) { out.jsNew = "ERR:" + (e && e.message); }
    const p = window.__matchGame.pitch;
    const st = window.require("players/states");
    const player = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.id === 4);
    out.padsState = window.__acPadsState;
    out.padsErrors = (window.__acPadsErrors || []).slice(0, 10);
    out.stuck = (window.__acStuck || []).slice(0, 6);
    // reference identity: does team.players contain the SAME object as allPlayers?
    try {
      const rt = p.redTeam;
      out.refs = {
        playersType: typeof rt.players,
        playersIsArray: Array.isArray(rt.players),
        playersLen: rt.players ? rt.players.length : -1,
        allLen: rt.allPlayers ? rt.allPlayers.length : -1,
        id4InPlayers: Array.isArray(rt.players) ? rt.players.some((x) => x && x.id === 4) : "n/a",
        id4InAll: rt.allPlayers ? rt.allPlayers.some((x) => x && x.id === 4) : "n/a",
        sameObject: Array.isArray(rt.players) && rt.allPlayers ? rt.players.some((x) => x === player) : "n/a",
        playerIsGoalkeeper: !!player.isGoalkeeper,
        playerId: player.id,
      };
    } catch (e) { out.refs = "ERR:" + (e && e.message); }
    // reachability of the new mapping (via any exposed handle? acUnstickSetPieces is
    // closure-private; probe the page's loaded script text indirectly)
    out.fnCheck = {
      hasReqMap: document.querySelector("script[src*='standalone-match']") ? "script-tag-found" : "no-tag",
      hooks: !!window.__matchGame.pitch.update.__acHook,
    };
    // force ThrowInRequestHuman and sample every 100ms for 1.2s
    try { player.states.change(st.ThrowInRequestHuman); out.samples.push({ t: 0, s: player.states.current.constructor.name }); }
    catch (e) { out.samples.push({ t: 0, s: "ERR:" + (e && e.message) }); }
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      out.samples.push({ t: (i + 1) * 100, s: player.states.current ? player.states.current.constructor.name : "none" });
    }
    out.stuck = (window.__acStuck || []).slice(0, 6);
    out.padsState2 = window.__acPadsState;
    return out;
  });

  console.log("[diag] ====== padsState ======", JSON.stringify(diag.padsState));
  console.log("[diag] ====== padsErrors ======", JSON.stringify(diag.padsErrors));
  console.log("[diag] ====== stuck before ======", JSON.stringify(diag.stuck));
  console.log("[diag] ====== state samples ======");
  for (const s of diag.samples) console.log(`  +${s.t}ms  ${s.s}`);
  console.log("[diag] ====== stuck after ======", JSON.stringify(diag.stuck));
  console.log("[diag] ====== padsState2 ======", JSON.stringify(diag.padsState2));
  console.log("[diag] ====== fnCheck ======", JSON.stringify(diag.fnCheck));
  console.log("[diag] ====== page-loaded JS ======", JSON.stringify(diag.jsNew));
  console.log("[diag] ====== refs ======", JSON.stringify(diag.refs));
} finally {
  await browser.close();
}
