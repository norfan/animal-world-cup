// Verify the set-piece takeover safety net: after the ThrowIn state is entered
// (engine taker assigned), the human player grabs the ball -> safety net routes
// him into HumanThrowIn -> pressing pass takes the throw-in.
// Usage: node script/diag-restart.mjs
import { chromium } from "playwright-core";

const base = "http://localhost:13000/match?red=argentina&blue=portugal&ai=0&side=home&time=20&play=1&squad=2";
const browser = await chromium.launch({ channel: "msedge", headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
try { await page.waitForFunction(() => document.body.classList.contains("loaded"), { timeout: 120000 }); } catch {}

for (let k = 0; k < 40; k += 1) {
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => {
    const g = window.__matchGame;
    const u = g && g.users && g.users.list && g.users.list[0];
    if (u && u.controller) u.controller.pass.isActive = true;
    const ps = g && g.pitch && g.pitch.states && g.pitch.states.current;
    const nm = ps && ps.constructor ? ps.constructor.name : "";
    return nm === "Play" || (nm === "Match" && g.pitch.ball.position.z < 0.3 && !g.pitch.ballOutOfPlay);
  });
  if (got) { console.log("[diag] gotPlay"); break; }
}

// force sideline out (blue last touch -> red throw-in); place deep out so the
// ball cannot be trapped back in before the out detection fires
await page.evaluate(() => {
  const g = window.__matchGame;
  const pitch = g.pitch;
  pitch.lastTouch = pitch.blueTeam.players[0];
  const b = pitch.ball;
  b.placeAtPosition(8, -1.4, 0.2);
  b.velocity.x = 0; b.velocity.y = 0; b.velocity.z = 0;
  b.owner = null; b.inHands = null;
});
console.log("[diag] forced out (deep)");

// wait until the pitch actually enters ThrowIn
let inThrowIn = false;
for (let k = 0; k < 30; k += 1) {
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const g = window.__matchGame;
    const st = g.pitch.states && g.pitch.states.current;
    return st && st.constructor ? st.constructor.name : "?";
  });
  if (r === "ThrowIn") { inThrowIn = true; console.log("[diag] in ThrowIn"); break; }
}
if (!inThrowIn) { console.log("[diag] FAIL: never reached ThrowIn"); await browser.close(); process.exit(1); }

// human grabs the ball (simulate trap/steal) + attach a connected controller
// (what a keyboard/seat player's player has) so the safety net sees a human
const r = await page.evaluate(() => {
  const g = window.__matchGame;
  const pitch = g.pitch;
  const human = pitch.redTeam.players[1]; // keyboard human's usual target
  const b = pitch.ball;
  b.owner = human; b.inHands = null;
  human.hasBall = true;
  if (!human.controller || !human.controller.connected) {
    human.controller = {
      connected: true,
      velocity: { x: 0, y: 0 },
      speed: 0,
      direction: { x: 0, y: 1 },
      pass: { isActive: false },
      lob: { isActive: false },
      shoot: { isActive: false },
      sprint: { isActive: false },
      slide: { isActive: false },
      togglePlayer: { isActive: false },
    };
  }
  // HumanThrowIn.update calls t.user.takeControl(...) to hand the receiver
  // control — a real keyboard user has one; simulate a minimal user here.
  if (!human.user) {
    human.user = {
      controller: human.controller,
      takeControl: function () {},
      releaseControl: function () {},
    };
  }
  const st = human.states && human.states.current;
  return "human " + human.id + " grabbed ball, ctrl=" + !!(human.controller && human.controller.connected) + " state=" + (st && st.constructor && st.constructor.name);
});
console.log("[diag]", r);

// press pass and watch the safety net route + throw-in happen
for (let i = 0; i < 12; i += 1) {
  await page.waitForTimeout(700);
  const snap = await page.evaluate((step) => {
    const g = window.__matchGame;
    const pitch = g.pitch;
    const owner = pitch.ball.owner;
    if (owner && owner.controller) owner.controller.pass.isActive = true;
    const st = pitch.states && pitch.states.current;
    const stName = st && st.constructor ? st.constructor.name : "?";
    const os = owner && owner.states && owner.states.current;
    const osName = os && os.constructor ? os.constructor.name : "?";
    const stOf = (p) => {
      const s = p.states && p.states.current;
      return p.id + (p === owner ? "*" : "") + ":" + ((s && s.constructor && s.constructor.name) || "?");
    };
    return {
      t: step,
      pitch: stName,
      out: !!pitch.ballOutOfPlay,
      owner: owner ? owner.id : "-",
      oState: osName,
      red: pitch.redTeam.players.map(stOf).join(" "),
      blue: pitch.blueTeam.players.map(stOf).join(" "),
    };
  }, i);
  if (snap) console.log("[snap]", JSON.stringify(snap));
  const done = await page.evaluate(() => {
    const g = window.__matchGame;
    const st = g.pitch.states && g.pitch.states.current;
    const nm = st && st.constructor ? st.constructor.name : "";
    return nm === "Match" || nm === "Play";
  });
  if (done) { console.log("[diag] PLAY RESUMED (fix works)"); break; }
}
await browser.close();
console.log("[diag] done");
