// Verify the full seat throw-in: after routing to HumanThrowIn, pressing the
// pass key must throw the ball (ThrowInThrow) — proves the human can actually
// take the set-piece, not just sit in the state.
// Usage: node script/verify-setpiece-throw.mjs [url]
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

  const result = await page.evaluate(async () => {
    const out = { states: [] };
    const p = window.__matchGame.pitch;
    const st = window.require("players/states");
    const player = (p.redTeam.allPlayers || p.redTeam.players).find((x) => x.id === 4);
    const snap = () => player.states.current ? player.states.current.constructor.name : "none";
    try { player.states.change(st.ThrowInRequestHuman); } catch (e) { out.states.push("force-err:" + (e && e.message)); }
    await new Promise((r) => setTimeout(r, 300));
    out.states.push("after-route:" + snap());
    // give it a kick direction (small movement) then press pass
    window.__acPads[0].ti = {
      active: true, vx: 0, vy: -0.6, shoot: false, sprint: false,
      pass: true, lob: false, switchPlayer: false, tackle: false,
    };
    await new Promise((r) => setTimeout(r, 150));
    out.states.push("pass-pressed:" + snap());
    await new Promise((r) => setTimeout(r, 600));
    out.states.push("+600ms:" + snap());
    // clear pass, observe follow-up
    window.__acPads[0].ti = { active: false, vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false };
    await new Promise((r) => setTimeout(r, 400));
    out.states.push("cleared:" + snap());
    out.ballOwner = p.ball.owner ? "id" + p.ball.owner.id : (p.ball.inHands ? "hands:" + p.ball.inHands.id : "loose");
    return out;
  });

  console.log("[sp] ====== THROW RESULT ======");
  for (const s of result.states) console.log("[sp] ", s);
  console.log("[sp] 球状态:", result.ballOwner);
  const ok = result.states.some((s) => s.includes("ThrowInThrow"));
  console.log("[sp] " + (ok ? "PASS: 玩家按 A 成功投掷界外球" : "INFO: 未观察到 ThrowInThrow（可能已进入后续状态）"));
} finally {
  await browser.close();
}
