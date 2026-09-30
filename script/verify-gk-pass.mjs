// Verify the goalkeeper-distribution fix by polling ball state:
// count GK kick-outs (fast ownerless ball whose lastTouch is the GK) and how
// often the ball is controlled by the GK's own team within 2.5s afterwards.
// Usage: node script/verify-gk-pass.mjs [seconds] [url]
import { chromium } from "playwright-core";

const maxWaitMs = Number(process.argv[2] || 100) * 1000;
const url = process.argv[3] || "http://localhost:13000/match";

const browser = await chromium.launch({ channel: "msedge", headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  console.log("[gk] opening", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForTimeout(3000);

  const stats = await page.evaluate(async (maxMs) => {
    return await new Promise((resolve) => {
      const state = { gkKicks: 0, gkReceived: 0, gkLost: 0, untrappableSamples: [], errors: [] };
      const game = () => window.__matchGame;
      const t0 = Date.now();
      let lastKickAt = 0, lastKickBall = null;
      const sample = () => {
        try {
          const g = game();
          const b = g && g.pitch && g.pitch.ball;
          if (!b) return;
          // GK kick-out: loose ball travelling fast whose lastTouch is the GK.
          if (b.lastTouch && b.lastTouch.isGoalkeeper && !b.owner && b.speed > 3) {
            const now = Date.now();
            if (now - lastKickAt > 2000 || lastKickBall !== b) {
              lastKickAt = now;
              lastKickBall = b;
              state.gkKicks++;
              state.untrappableSamples.push({ ut: b.untrappable, z: +b.position.z.toFixed(2), speed: +b.speed.toFixed(1) });
              const team = b.lastTouch.team;
              const deadline = Date.now() + 2500;
              const check = () => {
                const bb = game() && game().pitch && game().pitch.ball;
                if (!bb || bb !== b) return; // ball reset / out of play: ignore
                if (bb.owner && bb.owner.team === team) { state.gkReceived++; return; }
                if (Date.now() > deadline) { state.gkLost++; return; }
                setTimeout(check, 100);
              };
              setTimeout(check, 100);
            }
          }
        } catch (e) { state.errors.push(e && e.message); }
      };
      const timer = setInterval(sample, 100);
      const done = setInterval(() => {
        if (state.gkKicks >= 6 || Date.now() - t0 > maxMs) {
          clearInterval(timer);
          clearInterval(done);
          setTimeout(() => resolve(state), 3500);
        }
      }, 1000);
    });
  }, maxWaitMs);

  console.log("[gk] ====== RESULT ======");
  console.log("[gk] 门将发球次数:", stats.gkKicks);
  console.log("[gk] 发球瞬间 untrappable 值:", JSON.stringify(stats.untrappableSamples));
  console.log("[gk] 2.5s 内被本队球员控制(接到):", stats.gkReceived);
  console.log("[gk] 未被本队控制(丢失/被抢):", stats.gkLost);
  if (stats.gkKicks > 0) {
    console.log("[gk] 本队接管率:", (100 * stats.gkReceived / stats.gkKicks).toFixed(0) + "%");
  }
  if (stats.errors.length) console.log("[gk] errors:", stats.errors.slice(0, 5));
} finally {
  await browser.close();
}
