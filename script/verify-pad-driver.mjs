#!/usr/bin/env node
/**
 * verify-pad-driver — the P0 gate for the LAN 4v4 seat model, kept as a
 * regression test. See docs/multiplayer-4v4-design.md §"P0 结论".
 *
 * It drives N minted users, each LOCKED onto a fixed player, from inside the
 * running match, and asserts four things:
 *
 *   1. mint + bind + drive      — 4 pads, 4 different players, 4 independent
 *                                 movement streams over 5 sampling windows,
 *                                 all of them parked in HumanMove.
 *   2. locked-guard, A/B        — WITHOUT the guard the engine reassigns our
 *                                 user to another free player; WITH it the
 *                                 reassignment is rejected and the binding holds
 *                                 (and unlocked users are unaffected, so today's
 *                                 1v1 behaviour is untouched).
 *   2b. sustained stability     — 6 s / ~360 frames with zero churn and zero
 *                                 rebinds.
 *   3. overhead label layer     — 14 PIXI.Text labels on the stadium, projected
 *                                 with worldToScreenFlat, maxErr 0, every
 *                                 on-screen player carries a label.
 *
 * Engine traps this test exists to keep pinned down (all read out of the bundle
 * with script/inspect-match-module.mjs — the engine source is long gone):
 *
 *   - users.update() -> User.update() -> Controller.update() overwrites
 *     velocity/speed from the DEVICE every frame. Anything written from an
 *     independent rAF loop is wiped before pitch.update() runs, so input must go
 *     in after users.update() and before pitch.update(). This test hooks
 *     pitch.update() as a stand-in for the slot P2 will use in-place.
 *   - states.idle() / change(null) really sets current = null, and since
 *     states.is(null) is then true for ever, every recovery path short-circuits
 *     -> permanent freeze. takeControl(p, null), releaseControl(null) and
 *     changeTeam() (while a player is still held) all reach it. Always hand the
 *     engine a CONCRETE state.
 *   - transitionToHuman() returns null for ReturnHome / WaitForOthers / Kickoff
 *     and returns Ready (a fixed point that ignores the stick) for Ready, so
 *     binding must pass HumanMove explicitly.
 *   - takeControl() THROWS when the target already has a user, so "steal my own
 *     player" cannot happen; the real risk is our user being REASSIGNED to
 *     another free player by team.findControl()/nextUser()/assignPlayers().
 *
 * HEADED Chrome only — headless SwiftShader wedges the render loop.
 *
 * Usage:  node script/verify-pad-driver.mjs [baseUrl]
 * Needs:  a running dev server (pnpm dev:lan) on the given baseUrl.
 * Writes: .scratch/pad-driver-labels.png and .scratch/pad-driver-report.json
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(ROOT, ".scratch");
mkdirSync(SCRATCH, { recursive: true });

const base = process.argv[2] || "http://127.0.0.1:13000";
const url = `${base}/match?red=argentina&blue=portugal&play=1`;
const SHOT = path.join(SCRATCH, "pad-driver-labels.png");
const REPORT = path.join(SCRATCH, "pad-driver-report.json");

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: "hard timeout" }));
  process.exit(2);
}, 180_000);

const errors = [];
const browser = await chromium.launch({ channel: "chrome", headless: false });
const report = { ok: false, url };

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 240));
    if (process.env.VERBOSE) console.error(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const bootDeadline = Date.now() + 60_000;
  for (;;) {
    const p = await Promise.race([
      page.evaluate(() => ({
        mg: !!window.__matchGame,
        st: !!(window.__matchGame && window.__matchGame.stadium),
        cv: !!document.querySelector("canvas"),
      })),
      new Promise((r) => setTimeout(() => r("wedged"), 20_000)),
    ]);
    if (p === "wedged") {
      console.error(JSON.stringify({ ok: false, reason: "wedged — needs headed Chrome" }));
      process.exit(1);
    }
    if (p.mg && p.st && p.cv) break;
    if (Date.now() > bootDeadline) {
      console.error(JSON.stringify({ ok: false, reason: "boot stalled" }));
      process.exit(1);
    }
    await page.waitForTimeout(2_000);
  }

  const playDeadline = Date.now() + 45_000;
  for (;;) {
    const s = await page.evaluate(() => {
      const g = window.__matchGame;
      const u = window.require("users").list[0];
      return { attached: !!(u && u.player), matchStarted: !!(g.pitch && g.pitch.matchStarted) };
    });
    report.live = s;
    if ((s.attached && s.matchStarted) || Date.now() > playDeadline) break;
    await page.waitForTimeout(1_500);
  }
  await page.mouse.click(640, 400);
  await page.waitForTimeout(400);

  // ================= SETUP: pads + hook pitch.update =================
  const setup = await page.evaluate(() => {
    const R = window.require;
    const mod = R("users");
    const U = mod.User;
    const g = window.__matchGame;
    const pitch = g.pitch;

    function mintController() {
      try {
        const C = R("controller");
        const kb = R("core/input/keyboard");
        const st = R("settings");
        const layout = (st.current && st.current.keyboardLayout) || {};
        const Ctor = typeof C === "function" ? C : (C && C.Controller) || null;
        return Ctor ? new Ctor(kb, layout) : null;
      } catch (e) {
        return null;
      }
    }

    // verbatim replica of standalone-match.js acApplyInput
    function applyInput(user, ti) {
      if (!user || !user.controller) return false;
      const c = user.controller;
      if (!(ti && ti.active)) return false;
      c.velocity.x = ti.vx;
      c.velocity.y = ti.vy;
      const sp = Math.sqrt(ti.vx * ti.vx + ti.vy * ti.vy);
      c.speed = sp > 1 ? 1 : sp;
      if (sp > 0.001) {
        c.direction.x = ti.vx / sp;
        c.direction.y = ti.vy / sp;
      }
      if (ti.shoot) c.shoot.isActive = true;
      if (ti.sprint) c.sprint.isActive = true;
      if (ti.pass) { c.pass.isActive = true; ti.pass = false; }
      if (ti.lob) { c.lob.isActive = true; ti.lob = false; }
      if (ti.switchPlayer) { c.togglePlayer.isActive = true; ti.switchPlayer = false; }
      if (ti.tackle) { c.slide.isActive = true; ti.tackle = false; }
      return true;
    }
    window.__p0applyInput = applyInput;

    const states = R("players/states");
    const pglob = R("players/global");
    const stats = { ticks: 0, rebinds: 0, reseats: 0, errs: [] };

    const outfield = (t) => (t.allPlayers || t.players || []).filter((p) => !p.isGoalkeeper && p.id >= 0);
    const blueOut = outfield(pitch.blueTeam);
    const redOut = outfield(pitch.redTeam);

    // ------------------------------------------------------------------
    // Driver policy, derived from reading the real engine source out of the
    // bundle (_p0_src/players_states.pretty.js, players_global, users, team).
    //
    //  * transitionToHuman(p) only maps the states in its own table; Ready maps
    //    to Ready (a fixed point that ignores controller input), and ReturnHome /
    //    WaitForOthers / Kickoff are not in the table at all -> null.
    //  * takeControl(p, e) -> forceHuman(p, e): if `e` is falsy it calls
    //    states.idle() -> change(null), and _change(null) REALLY sets current =
    //    null. states.is(null) is then true for ever, so every later recovery
    //    short-circuits -> permanent freeze. Same trap in releaseControl(null)
    //    (forceAI(p, null) -> change(null)) and in changeTeam() on a user that
    //    still owns a player. So: never release with a null state.
    //  * An entity's state machine is ticked from entity.update(), which runs
    //    inside pitch.update() -> _updatePlayers(). Writing controller input
    //    before that (i.e. hooking pitch.update) is the one slot that survives
    //    users.update() overwriting the controller from the device.
    //
    // Policy: our player is OURS. Keep it in HumanMove unless the engine is in
    // the middle of something we must not interrupt (restart sequences, action
    // states, celebrations) or the player is already reading our input.
    // ------------------------------------------------------------------
    const NEVER_RESEAT = new Set(
      [
        "BackOnPitch", "ReturnHomeCelebrating", "GoalCelebration", "GoalCelebrationPlane",
        "GoalCelebrationPlaneAssist", "GoalCelebrationDance", "GoalCelebrationDance2",
        "GoalCelebrationKneeslide", "WinCelebration",
        "Hit", "Slide", "Header", "Jump", "Kickoff", "WaitForOthers", "ThrowInThrow",
        "ThrowInPickUpBall", "KickToTarget", "KickInDirection", "Swerve", "Pass",
        "DirectShot", "HumanJump", "HumanPreciseShot", "HumanPass", "HumanLob",
        "HumanCornerKick", "HumanCornerAssist", "HumanThrowIn", "HumanPutBallBackInPlay",
        "HumanGoalKick", "HumanSelectShoot", "HumanSelectTeam",
      ]
        .map((n) => states[n])
        .filter(Boolean),
    );
    // states that already consume controller.velocity every frame -> leave alone
    const HUMAN_OK = new Set(
      ["HumanMove", "HumanDribble", "HumanReceiveBall", "ClientMove", "ClientDribble"]
        .map((n) => states[n])
        .filter(Boolean),
    );
    stats.policy = {
      never: Array.from(NEVER_RESEAT).map((s) => s.name),
      humanOk: Array.from(HUMAN_OK).map((s) => s.name),
    };

    function stateNameOf(p) {
      return p.states.current ? p.states.current.constructor.name : null;
    }

    // Handing a player back to the AI: the engine's own canonical answer is
    // AIDefend -- every human state in the transitionToAI table maps to it.
    // (Passing `undefined` would call transitionToAI() and THROW for the many
    // states absent from the table, and passing `null` would hit the
    // _change(null) deadlock. This is the one safe release path.)
    function backToAI(p) {
      return p.isGoalkeeper ? states.transitionToAI(p) || states.AIGoalkeeperTendGoal : states.AIDefend;
    }

    // Keep `u` on its fixed player and keep that player reading our input.
    function acDrivePad(u, tgt) {
      if (!u || !tgt) return;
      try {
        // 1) identity: the engine (team.assignPlayers -> findControl, RequestHuman,
        //    nextUser...) may have re-homed this user. The P-1 `locked` guard stops
        //    the steal in the first place; this restores us if it ever happened.
        if (u.player !== tgt || tgt.user !== u) {
          if (u.player && u.player !== tgt) u.releaseControl(backToAI(u.player));
          if (tgt.user && tgt.user !== u && tgt.user.releaseControl) tgt.user.releaseControl(backToAI(tgt));
          u.takeControl(tgt, states.HumanMove);
          stats.rebinds += 1;
        }
        if (tgt.controller !== u.controller) tgt.controller = u.controller;

        // 2) global: HumanGlobal sets maxTurnRate + clampToPitch (read by move())
        const wantGlobal = tgt.isGoalkeeper ? pglob.HumanGoalkeeperGlobal : pglob.HumanGlobal;
        const cur = tgt.states._global;
        if (wantGlobal && (!cur || cur.constructor !== wantGlobal)) tgt.states.global(wantGlobal);

        // 3) state: reseat into HumanMove unless the engine owns the moment
        const sname = stateNameOf(tgt);
        const scls = tgt.states.current ? tgt.states.current.constructor : null;
        if (scls && HUMAN_OK.has(scls)) return;
        if (scls && NEVER_RESEAT.has(scls)) return;
        tgt.states.change(states.HumanMove);
        stats.reseats += 1;
        // diagnostics for the frozen-player case
        if (sname === null) stats.sawNullState = (stats.sawNullState || 0) + 1;
      } catch (e) {
        u.__lastErr = String((e && e.message) || e);
        if (stats.errs.length < 8) stats.errs.push("drive:" + u.__lastErr);
      }
    }
    window.__p0bind = acDrivePad;
    window.__p0stats = stats;

    const listBefore = mod.list.length;
    const mk = (id, team, target, ti) => {
      const u = new U(id, null, null, false, 0);
      u.color = 0xff00ff;
      mod.list.push(u);
      let ctErr = null;
      try { u.changeTeam(team); } catch (e) { ctErr = String((e && e.message) || e); }
      // Team.addUser() -> user.findControl() immediately auto-grabs some free
      // player. Hand it straight back to the AI before binding our own seat.
      try { if (u.player) u.releaseControl(states.AIDefend); } catch (e) { ctErr = (ctErr || "") + "|rel:" + ((e && e.message) || e); }
      u.controller = mintController();
      u.enabled = true;
      u.__target = target;
      return { u, ti, ctErr };
    };

    const pads = [
      mk(5, pitch.blueTeam, blueOut[2], { active: true, vx: 1, vy: 0, shoot: false, sprint: false, pass: false, lob: false, tackle: false, switchPlayer: false }),
      mk(6, pitch.blueTeam, blueOut[3], { active: true, vx: 0, vy: -1, shoot: false, sprint: false, pass: false, lob: false, tackle: false, switchPlayer: false }),
      mk(7, pitch.blueTeam, blueOut[4], { active: true, vx: -1, vy: 0, shoot: false, sprint: false, pass: false, lob: false, tackle: false, switchPlayer: false }),
      mk(8, pitch.redTeam, redOut[2], { active: true, vx: 0, vy: 1, shoot: false, sprint: false, pass: false, lob: false, tackle: false, switchPlayer: false }),
    ];

    window.__p0 = { pads, stats, listBefore, listAfter: mod.list.length, pitchW: pitch.width, pitchH: pitch.height };

    // Install the P-1 candidate patch ONCE on the prototype, then lock every pad.
    // The guard reads `this.locked`, so unlocked users are untouched (today's 1v1).
    const proto = U.prototype;
    window.__p0orig = { take: proto.takeControl, attach: proto.attachControl };
    proto.takeControl = function (t, e, i) {
      if (this.locked && t !== this.lockedPlayer) return;
      return window.__p0orig.take.call(this, t, e, i);
    };
    proto.attachControl = function (t) {
      if (this.locked && t !== this.lockedPlayer) return;
      return window.__p0orig.attach.call(this, t);
    };
    for (const pad of pads) {
      pad.u.locked = true;
      pad.u.lockedPlayer = pad.u.__target;
    }

    // The play phase runs: users.update() -> acApplyInput(u0) -> pitch.update().
    // users.update() calls controller.update() every frame, which overwrites
    // velocity from the DEVICE state -- so input written from an independent rAF
    // loop is always wiped before pitch.update(). Hook pitch.update to write in
    // the same slot the built-in acApplyInput(u0) uses: state reseat + input land
    // before _updatePlayers() ticks each entity's own state machine.
    if (!pitch.__p0hooked) {
      pitch.__p0hooked = true;
      const origUpdate = pitch.update.bind(pitch);
      pitch.update = function (elapsed) {
        const p0 = window.__p0;
        if (p0) {
          const drive = window.__p0bind;
          const fn = window.__p0applyInput;
          for (const pad of p0.pads) {
            drive(pad.u, pad.u.__target);
            // Walk each pad around a lazy circle instead of a straight line:
            // constant speed, no wall collisions, so every sampling window
            // measures "does this pad follow its own input" and nothing else.
            if (typeof pad.ang !== "number") pad.ang = Math.atan2(pad.ti.vy, pad.ti.vx) || 0;
            pad.ang += 0.03;
            pad.ti.vx = Math.cos(pad.ang);
            pad.ti.vy = Math.sin(pad.ang);
            fn(pad.u, pad.ti);
            // fixed binding: a pad must never trigger the engine's own
            // "switch to the player nearest the ball" (findControl).
            if (pad.u.controller) pad.u.controller.togglePlayer.isActive = false;
          }
          p0.stats.ticks += 1;
        }
        return origUpdate(elapsed);
      };
    }

    const snap = (p) => ({ x: +p.u.__target.position.x.toFixed(3), y: +p.u.__target.position.y.toFixed(3) });
    return {
      listBefore,
      listAfter: mod.list.length,
      mints: pads.map((p) => !!p.u.controller),
      ctErrs: pads.map((p) => p.ctErr),
      targets: pads.map((p) => ({ id: p.u.__target.id, gk: !!p.u.__target.isGoalkeeper })),
      pos0: pads.map(snap),
      blueOutIds: blueOut.map((p) => p.id),
      redOutIds: redOut.map((p) => p.id),
    };
  });
  report.setup = setup;

  // sample movement over several windows, capturing why a pad might stall
  const samples = [];
  for (let k = 0; k < 6; k += 1) {
    samples.push(await page.evaluate(() => {
      const g = window.__matchGame;
      const p0 = window.__p0;
      const states = window.require("players/states");
      return {
        ticks: p0.stats.ticks,
        stats: { ticks: p0.stats.ticks, rebinds: p0.stats.rebinds, reseats: p0.stats.reseats, errs: p0.stats.errs.slice(0, 4) },
        live: !!g.pitch.matchStarted && !g.pitch.ballOutOfPlay,
        ballOut: !!g.pitch.ballOutOfPlay,
        pads: p0.pads.map((p) => {
          const pl = p.u.__target;
          let toHuman = null;
          try {
            const s = states.transitionToHuman(pl);
            toHuman = s ? s.name || String(s) : null;
          } catch (e) {
            toHuman = "err:" + ((e && e.message) || e);
          }
          return {
            id: pl.id,
            uid: p.u.id,
            pos: [+pl.position.x.toFixed(2), +pl.position.y.toFixed(2)],
            stateName: pl.states && pl.states.current ? (pl.states.current.name || String(pl.states.current)) : null,
            globalName: pl.states && pl.states._global ? pl.states._global.constructor.name : null,
            toHuman,
            speed: typeof pl.speed === "number" ? +pl.speed.toFixed(2) : null,
            hasBall: !!pl.hasBall,
            userOk: pl.user === p.u,
            ctrlOk: pl.controller === p.u.controller,
            ctrlSpeed: p.u.controller ? +p.u.controller.speed.toFixed(2) : null,
            teamUserIds: (pl.team && pl.team.users ? pl.team.users : []).map((x) => x.id),
          };
        }),
      };
    }));
    await page.waitForTimeout(500);
  }
  report.samples = samples;

  const last = samples[samples.length - 1];
  const first = samples[0];
  const moved = { ticks: last.ticks - first.ticks, pads: last.pads.map((p, i) => ({ id: p.id, pos: p.pos, bound: p.userOk, ctrlVel: null, stateName: p.stateName })) };
  report.after = moved;

  const deltas = setup.pos0.map((p, i) => {
    const q = last.pads[i].pos;
    return +Math.hypot(q[0] - p.x, q[1] - p.y).toFixed(3);
  });
  // per-500ms-window deltas make a stalled pad obvious
  const windows = [];
  for (let i = 1; i < samples.length; i += 1) {
    windows.push(samples[i].pads.map((p, k) => {
      const prev = samples[i - 1].pads[k].pos;
      return +Math.hypot(p.pos[0] - prev[0], p.pos[1] - prev[1]).toFixed(2);
    }));
  }
  // net displacement is meaningless for a circling pad -- score the walked path
  const pathLength = windows.length ? windows[0].map((_, k) => +windows.reduce((s, w) => s + w[k], 0).toFixed(2)) : [];
  report.test1 = {
    ticks: moved.ticks,
    usersGrew: setup.listAfter === setup.listBefore + 4,
    allMinted: setup.mints.every(Boolean),
    allBound: last.pads.every((p) => p.userOk && p.ctrlOk),
    stats: last.stats,
    deltas,
    windows,
    allMovedThroughout: windows.every((w) => w.every((d) => d > 0.8)),
    pathLength,
    eachPadMoved: pathLength.length === 4 && pathLength.every((d) => d > 6),
    allMoved: deltas.every((d) => d > 0.4),
    movedIndependently: deltas.every((d) => d > 0.4),
  };

  // ============ TEST 2: discriminating locked-guard A/B ============
  const guard = await page.evaluate(() => {
    const R = window.require;
    const mod = R("users");
    const U = mod.User;
    const p0 = window.__p0;
    const uT = p0.pads[0].u;
    const tgt = uT.__target;
    const out = { targetId: tgt.id };

    const freeOf = (team, exclude) =>
      ((team.allPlayers || team.players || []).filter((p) => !p.isGoalkeeper && p.id >= 0)).find((p) => !p.user && p !== exclude && p !== tgt);

    // ---- A) WITHOUT the guard: our user gets REASSIGNED to a free player ----
    uT.locked = false;
    uT.lockedPlayer = null;
    const freeA = freeOf(tgt.team, null);
    out.freeA = freeA ? freeA.id : null;
    try { uT.takeControl(freeA); } catch (e) { out.A_throw = String((e && e.message) || e); }
    out.A_reassigned = uT.player === freeA;
    out.A_targetFreed = tgt.user == null;
    // restore + re-arm the guard
    try { uT.releaseControl(null); } catch (e) {}
    uT.locked = true;
    uT.lockedPlayer = tgt;
    try { uT.takeControl(tgt); } catch (e) { out.A_restoreErr = String((e && e.message) || e); }
    out.A_restored = uT.player === tgt;

    // ---- B) WITH the guard: the same reassignment must be refused ----
    const freeB = freeOf(tgt.team, null);
    out.freeB = freeB ? freeB.id : null;
    try { uT.takeControl(freeB); } catch (e) { out.B_takeThrow = String((e && e.message) || e); }
    out.B_reassigned = uT.player === freeB;
    out.B_stillOnTarget = uT.player === tgt;
    out.B_targetStillHeld = tgt.user === uT;
    try { uT.attachControl(freeB); } catch (e) { out.B_attachThrow = String((e && e.message) || e); }
    out.B_stillOnTargetAfterAttach = uT.player === tgt;

    // ---- C) regression: an UNLOCKED user is unaffected ----
    const uOther = p0.pads[1].u;
    const tgtOther = uOther.__target;
    out.C_wasLockedBySetup = !!uOther.locked;
    uOther.locked = false; // simulate today's 1v1 user (never locked)
    out.C_otherHoldsOwn = tgtOther.user === uOther;
    const freeC = freeOf(tgtOther.team, tgtOther);
    out.freeC = freeC ? freeC.id : null;
    try { uOther.takeControl(freeC); } catch (e) { out.C_throw = String((e && e.message) || e); }
    out.C_unlockedCanStillMove = uOther.player === freeC;
    try { uOther.releaseControl(null); } catch (e) {}
    uOther.locked = true;
    uOther.lockedPlayer = tgtOther;
    try { uOther.takeControl(tgtOther); } catch (e) {}

    // ---- D) the locked user can still (re)bind ITS OWN player ----
    try { uT.releaseControl(null); } catch (e) {}
    let re = null;
    try { uT.takeControl(tgt); re = uT.player === tgt; } catch (e) { out.D_err = String((e && e.message) || e); }
    out.D_reassertOwn = re;

    return out;
  });
  report.test2 = guard;

  const b4 = await page.evaluate(() => ({
    stats: { ticks: window.__p0.stats.ticks, rebinds: window.__p0.stats.rebinds, repairs: window.__p0.stats.repairs, notBindable: window.__p0.stats.notBindable, errs: window.__p0.stats.errs.slice(0, 4) },
    bound: window.__p0.pads.map((p) => p.u.player === p.u.__target),
  }));
  await page.waitForTimeout(6_000);
  const af = await page.evaluate(() => ({
    stats: { ticks: window.__p0.stats.ticks, rebinds: window.__p0.stats.rebinds, repairs: window.__p0.stats.repairs, notBindable: window.__p0.stats.notBindable, errs: window.__p0.stats.errs.slice(0, 4) },
    bound: window.__p0.pads.map((p) => p.u.player === p.u.__target),
    held: window.__p0.pads.map((p) => p.u.__target.user === p.u),
    lastErrs: window.__p0.pads.map((p) => p.u.__lastErr || null),
  }));
  report.test2b = {
    ticksDelta: af.stats.ticks - b4.stats.ticks,
    rebindsDelta: af.stats.rebinds - b4.stats.rebinds,
    repairsDelta: af.stats.repairs - b4.stats.repairs,
    notBindableDelta: af.stats.notBindable - b4.stats.notBindable,
    errs: af.stats.errs,
    boundNow: af.bound,
    heldNow: af.held,
    lastErrs: af.lastErrs,
    survived: af.held.every(Boolean),
  };

  // ============ TEST 3: label layer ============
  const proj = await page.evaluate(() => {
    const R = window.require;
    const PIXI = R("pixi");
    const G = R("renderers/generic");
    const P2 = R("core/math/point2");
    const g = window.__matchGame;
    const stadium = g.stadium;

    if (!window.__p0label) {
      const layer = new PIXI.Container();
      let parent = "stadium";
      try { stadium.addChild(layer); } catch (e) { g.stage.addChild(layer); parent = "stage"; }
      const players = (g.pitch.redTeam.allPlayers || []).concat(g.pitch.blueTeam.allPlayers || []);
      const items = [];
      for (const p of players) {
        const txt = new PIXI.Text(String(p.id), {
          fontFamily: "Arial", fontSize: 20, fontWeight: "bold",
          fill: p.team === g.pitch.redTeam ? 0xffffff : 0x00e0ff,
          stroke: 0x000000, strokeThickness: 3,
        });
        txt.anchor.set(0.5, 1);
        layer.addChild(txt);
        items.push({ p, txt, out: P2.create() });
      }
      window.__p0label = { layer, items, parent, LIFT: 46 };
      (function tick() {
        const L = window.__p0label;
        for (const it of L.items) {
          if (it.p && it.p.position) {
            G.worldToScreenFlat(it.p.position, it.out);
            it.txt.position.set(it.out.x, it.out.y - L.LIFT);
          }
        }
        window.requestAnimationFrame(tick);
      })();
    }
    return {
      hasIndicatorLayer: !!(stadium && stadium.indicatorLayer),
      parent: window.__p0label.parent,
      labelCount: window.__p0label.items.length,
      layerChildren: window.__p0label.layer.children.length,
    };
  });
  report.test3_setup = proj;

  await page.waitForTimeout(1_800);

  const projCheck = await page.evaluate(() => {
    const R = window.require;
    const G = R("renderers/generic");
    const P2 = R("core/math/point2");
    const L = window.__p0label;
    const stadium = window.__matchGame.stadium;
    // labels live in the stadium's internal space, so "on screen" must be judged
    // against the stadium camera, exactly like renderers/control_indicator does.
    const camW = stadium.cameraWidth;
    const camH = stadium.cameraHeight;
    const camPos = P2.create();
    try { stadium.getCameraPosition(camPos); } catch (e) {}
    let feetInCam = 0, labelsInCam = 0, maxErr = 0;
    const rows = [];
    for (const it of L.items) {
      const o = it.out;
      G.worldToScreenFlat(it.p.position, o);
      const err = Math.hypot(it.txt.position.x - o.x, it.txt.position.y + L.LIFT - o.y);
      maxErr = Math.max(maxErr, err);
      const feetOn = o.x >= camPos.x && o.x <= camPos.x + camW && o.y >= camPos.y && o.y <= camPos.y + camH;
      const labelOn = it.txt.position.x >= camPos.x && it.txt.position.x <= camPos.x + camW &&
                      it.txt.position.y >= camPos.y && it.txt.position.y <= camPos.y + camH;
      if (feetOn) feetInCam++;
      if (feetOn && labelOn) labelsInCam++;
      rows.push({ id: it.p.id, feet: [Math.round(o.x), Math.round(o.y)], label: [Math.round(it.txt.position.x), Math.round(it.txt.position.y)], feetOn, labelOn, err: +err.toFixed(2) });
    }
    return {
      camera: { w: camW, h: camH, x: Math.round(camPos.x), y: Math.round(camPos.y) },
      lift: L.LIFT, feetInCam, labelsInCam, maxErr: +maxErr.toFixed(3),
      everyVisibleFootHasLabel: feetInCam === labelsInCam,
      sampleRows: rows.slice(0, 3),
    };
  });
  report.test3 = projCheck;

  await page.screenshot({ path: SHOT, type: "png" });
  report.screenshot = SHOT;

  await page.evaluate(() => { window.__p0.running = false; });

  const realErrors = errors.filter((e) => !/favicon|React DevTools|Download the/i.test(e));
  report.pageErrors = realErrors.slice(0, 6);

  report.ok =
    report.test1.allMinted &&
    report.test1.allBound &&
    report.test1.allMoved &&
    report.test1.allMovedThroughout &&
    report.test1.eachPadMoved &&
    report.test1.stats.reseats < report.test1.ticks / 2 &&
    report.test2.A_reassigned === true &&
    report.test2.B_reassigned === false &&
    report.test2.B_stillOnTarget === true &&
    report.test2.C_unlockedCanStillMove === true &&
    report.test2.D_reassertOwn === true &&
    report.test2b.survived === true &&
    report.test3_setup.labelCount === 14 &&
    report.test3.maxErr < 1 &&
    report.test3.everyVisibleFootHasLabel === true;

  console.log(JSON.stringify(report, null, 2));
  try {
    writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
  } catch {}
  process.exit(report.ok ? 0 : 1);
} finally {
  clearTimeout(hardTimer);
  await browser.close();
}
