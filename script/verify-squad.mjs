// Verify the squad (outfield players per side) feature end to end:
// open /match?...&squad=N and read the engine's actual player rosters.
// Usage: node script/verify-squad.mjs
import { chromium } from "playwright-core";

const base = "http://localhost:13000/match?red=argentina&blue=portugal&ai=0&side=home&time=20";
const browser = await chromium.launch({ channel: "msedge", headless: false });

async function probe(squad) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const url = `${base}&squad=${squad}&play=1`;
  console.log(`[squad] opening squad=${squad} ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const g = window.__matchGame;
    if (!g) return { ok: false, reason: "no __matchGame" };
    const red = g.pitch.redTeam.allPlayers;
    const blue = g.pitch.blueTeam.allPlayers;
    return {
      ok: true,
      total: g.allPlayers.length,
      red: red.length,
      blue: blue.length,
      redGk: red.filter((p) => p.isGoalkeeper).length,
      blueGk: blue.filter((p) => p.isGoalkeeper).length,
      redIds: red.map((p) => p.id).join(","),
      blueIds: blue.map((p) => p.id).join(","),
      redRoles: red.map((p) => (p.role === 1 ? "D" : p.role === 2 ? "M" : p.role === 3 ? "A" : "?" + p.role)).join(","),
    };
  });
  console.log("[squad]", JSON.stringify(info));
  await page.close();
  return info;
}

const expect = {
  2: { total: 6, red: 3, blue: 3, redGk: 1, blueGk: 1 },
  4: { total: 10, red: 5, blue: 5, redGk: 1, blueGk: 1 },
  6: { total: 14, red: 7, blue: 7, redGk: 1, blueGk: 1 },
};

let pass = true;
for (const sq of [2, 4, 6]) {
  const r = await probe(sq);
  const e = expect[sq];
  const ok = r.ok && r.total === e.total && r.red === e.red && r.blue === e.blue && r.redGk === e.redGk && r.blueGk === e.blueGk;
  console.log(`[squad] squad=${sq} ${ok ? "PASS" : "FAIL"} (expected ${JSON.stringify(e)})`);
  if (!ok) pass = false;
}

// also probe a boundary: squad missing -> default 6
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${base}&play=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 });
await page.waitForTimeout(4000);
const def = await page.evaluate(() => {
  const g = window.__matchGame;
  return g ? g.allPlayers.length : -1;
});
console.log(`[squad] no-squad default total=${def} ${def === 14 ? "PASS" : "FAIL"}`);
if (def !== 14) pass = false;
await page.close();

await browser.close();
console.log(pass ? "ALL PASS" : "SOME FAIL");
process.exit(pass ? 0 : 1);
