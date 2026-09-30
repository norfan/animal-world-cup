// Post-fix regression: frame lengths must equal squadSize and no render errors.
// Usage: node script/diag-squad-errors.mjs
import { chromium } from "playwright-core";

const base = "http://localhost:13000/match?red=argentina&blue=portugal&ai=0&side=home&time=20";
const browser = await chromium.launch({ channel: "msedge", headless: false });

for (const squad of [2, 3, 4, 5, 6]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    window.__errs = [];
    window.addEventListener("error", (ev) => {
      if (window.__errs.length < 50) window.__errs.push((ev.error && ev.error.stack ? ev.error.stack : String(ev.message)).split("\n")[0]);
    });
  });
  let consoleErrs = 0;
  page.on("console", (m) => { if (m.type() === "error") consoleErrs += 1; });
  await page.goto(`${base}&squad=${squad}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  try { await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 }); } catch {}
  await page.waitForTimeout(6000);
  const snap = await page.evaluate(() => {
    const g = window.__matchGame;
    const stream = g && g.stream;
    const read = (f) => (f && f.redTeam && f.redTeam.players ? f.redTeam.players.length : -1);
    const frames = stream && stream.frames ? stream.frames.map(read) : [];
    const pitch = g && g.pitch;
    return {
      frameMax: frames.length ? Math.max(...frames) : -1,
      frameMin: frames.length ? Math.min(...frames) : -1,
      inter: stream && stream.interpolated ? read(stream.interpolated) : -1,
      merged: stream && stream._merged ? read(stream._merged) : -1,
      pitchRed: pitch && pitch.redTeam && pitch.redTeam.allPlayers ? pitch.redTeam.allPlayers.length : -1,
      stadPlayers: g && g.stadium && g.stadium.players ? g.stadium.players.length : -1,
      hooked: (window.__errs || []).length,
    };
  });
  const status = snap.hooked === 0 && consoleErrs === 0 ? "CLEAN" : "ERRORS";
  console.log(`[diag] squad=${squad} ${status} frame=[${snap.frameMin}..${snap.frameMax}] inter=${snap.inter} merged=${snap.merged} pitchRed=${snap.pitchRed} stad=${snap.stadPlayers} hooked=${snap.hooked} console=${consoleErrs}`);
  if (snap.hooked) console.log("  first:", snap.hooked ? "see hooked" : "");
  await page.close();
}
await browser.close();
console.log("[diag] done");
