// Regression (natural kick-out): with the set-piece safety net installed,
// NORMAL AI set-piece flow (no human grabbing) must resume play. Kick the
// ball out naturally (as a real match does) at squad=6, then confirm the
// pitch leaves the dead-ball state. Usage: node script/verify-setpiece-ai.mjs
import { chromium } from "playwright-core";

const base = "http://localhost:13000/match?red=argentina&blue=portugal&ai=0&side=home&time=20&play=1&squad=6";
const browser = await chromium.launch({ channel: "msedge", headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
try { await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 }); } catch {}

for (let k = 0; k < 40; k += 1) {
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => {
    const g = window.__matchGame;
    const ps = g && g.pitch && g.pitch.states && g.pitch.states.current;
    const nm = ps && ps.constructor ? ps.constructor.name : "";
    return nm === "Play" || (nm === "Match" && g.pitch.ball.position.z < 0.3 && !g.pitch.ballOutOfPlay);
  });
  if (got) { console.log("[diag] gotPlay"); break; }
}

// natural kicks: down the near sideline, down the far sideline, up the pitch
const kicks = [
  { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
];
let pass = 0;
for (const k of kicks) {
  await page.evaluate((v) => {
    const g = window.__matchGame;
    const pitch = g.pitch;
    const b = pitch.ball;
    if (b.owner) { if (b.owner.releaseBall) b.owner.releaseBall(); b.owner = null; }
    b.inHands = null;
    b.kick({ x: v.dx, y: v.dy }, 95);
  }, k);
  console.log("[diag] kicked", JSON.stringify(k));
  let resumed = false;
  let states = [];
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const g = window.__matchGame;
      const st = g.pitch.states && g.pitch.states.current;
      return { nm: st && st.constructor ? st.constructor.name : "?", out: !!g.pitch.ballOutOfPlay };
    });
    states.push(r.nm);
    if ((r.nm === "Match" || r.nm === "Play") && !r.out) { resumed = true; break; }
  }
  console.log("[diag]", JSON.stringify(k), "states:", states.join(","), "resumed=", resumed);
  if (resumed) pass += 1;
  // return to live play if still stuck (pump pass may release a held ball)
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const g = window.__matchGame;
      const st = g.pitch.states && g.pitch.states.current;
      return { nm: st && st.constructor ? st.constructor.name : "?", out: !!g.pitch.ballOutOfPlay };
    });
    if ((r.nm === "Match" || r.nm === "Play") && !r.out) break;
  }
}
console.log("[diag] RESULT", pass + "/" + kicks.length, "natural kick-outs resumed");
await browser.close();
console.log("[diag] done");
