#!/usr/bin/env node
/**
 * lan-e2e — P5 acceptance: a full "party rehearsal", lobby to kick-off.
 *
 * The other LAN suites each pin down one link:
 *   verify-lan-seats      the relay's seat protocol
 *   verify-pad-driver     the host bridge / engine binding
 *   verify-pad-seatpath   8 phones driving 8 players concurrently
 *   verify-pad-labels     the overhead label layer
 *   verify-pad-lobby      the lobby board + the phone's picker
 *
 * None of them walks the chain a real group actually walks. This one does:
 *
 *   1. open the real /lobby and let it mint a room as the host
 *   2. 8 phones join that room by code (the seat protocol, not a fixture)
 *   3. press Start in the lobby
 *   4. the big screen navigates into /match?lan=ROOM; the engine boots and the
 *      seat driver attaches all 8 seats to 8 distinct players, leaving 6 AI
 *   5. every phone pushes its own direction for a few seconds: all 8 players
 *      move, each along its own stick, and nobody stalls
 *   6. the label layer agrees (8 human capsules, 6 AI capsules)
 *   7. page errors stay at zero — in particular no
 *      "Cannot take control, player already controlled"
 *
 * So it is the one test that would catch "each piece works but the handoff does
 * not" — the lobby dropping the room, the room code not surviving the
 * navigation, or the relay's host grace window being too short.
 *
 * ISOLATION: scratch relay on its own port, pointed at via `window.__lanPort`.
 * HEADED Chrome only — headless SwiftShader wedges the engine render loop.
 *
 * Usage:  node script/lan-e2e.mjs [baseUrl]
 * Needs:  a running dev server (pnpm dev:lan) on baseUrl (default 13000).
 * Writes: .scratch/lan-e2e.png, .scratch/lan-e2e-report.json
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = path.join(ROOT, ".scratch");
mkdirSync(SCRATCH, { recursive: true });

const BASE = process.argv[2] || "http://127.0.0.1:13000";
const RELAY_PORT = Number(process.env.E2E_PORT || 13995);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const LOBBY_URL = `${BASE}/lobby?red=argentina&blue=portugal&side=red&ai=3&time=6`;
const SHOT = path.join(SCRATCH, "lan-e2e.png");
const REPORT = path.join(SCRATCH, "lan-e2e-report.json");

const N_PHONES = 8;
const SQUAD = 7;
const GK_NUMBER = 1;
const expectPlayerId = (side, n) => (side === "blue" ? SQUAD + n - 1 : n - 1);

const failures = [];
let checks = 0;
function ok(label, cond, extra) {
  checks += 1;
  if (cond) console.log("  \u2713 " + label);
  else {
    failures.push(label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
    console.log("  \u2717 " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : ""));
  }
}
function eq(label, actual, expected) {
  ok(label + " === " + JSON.stringify(expected), actual === expected, { actual });
}

// ---------------------------------------------------------------------------
// scratch relay
// ---------------------------------------------------------------------------
const relay = spawn(process.execPath, [path.join(ROOT, "script", "lan-server.mjs")], {
  env: { ...process.env, LAN_PORT: String(RELAY_PORT), LAN_IP: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relay.stdout.on("data", (b) => { relayLog += String(b); });
relay.stderr.on("data", (b) => { relayLog += String(b); });
process.on("exit", () => { try { relay.kill(); } catch {} });

// ---------------------------------------------------------------------------
// a phone: joins by room code, then streams input like a real page would
// ---------------------------------------------------------------------------
function phone(k) {
  const ws = new WebSocket(RELAY);
  const inbox = [];
  const waiters = [];
  let settle = null;
  const opened = new Promise((r) => { settle = r; });
  ws.on("open", () => settle(true));
  ws.on("error", () => settle(false));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  let seq = 0;
  return {
    k,
    opened,
    inbox,
    send(d) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "input", seq: ++seq, d }));
    },
    wait(pred, ms = 8000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    last(pred) {
      for (let i = inbox.length - 1; i >= 0; i -= 1) if (pred(inbox[i])) return inbox[i];
      return null;
    },
    async join(room) {
      if (!(await opened)) return null;
      ws.send(JSON.stringify({ t: "join", room, name: "E" + k, clientId: "e2e-" + k }));
      return this.wait((m) => m.t === "joined" || m.t === "joinErr");
    },
    close() { try { ws.close(); } catch {} },
  };
}

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: "hard timeout" }, null, 1));
  try { relay.kill(); } catch {}
  process.exit(1);
}, 300_000);

const report = { ok: false, relay: RELAY, lobby: LOBBY_URL };
const phones = [];
let browser = null;

try {
  // --- scratch relay up -----------------------------------------------------
  {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      up = await new Promise((r) => {
        const p = new WebSocket(RELAY);
        let s = false;
        const fin = (v) => { if (s) return; s = true; try { p.close(); } catch {} r(v); };
        p.on("open", () => fin(true));
        p.on("error", () => fin(false));
        setTimeout(() => fin(false), 1200);
      });
      if (!up) {
        if (relay.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!up) {
      console.error(JSON.stringify({ ok: false, reason: "scratch relay did not start", relayLog: relayLog.slice(-1200) }, null, 1));
      process.exit(1);
    }
  }

  browser = await chromium.launch({ channel: "chrome", headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text().slice(0, 260)); });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.addInitScript((port) => { window.__lanPort = port; }, RELAY_PORT);

  // =======================================================================
  console.log("\n### T0: the lobby mints a room of its own");
  // =======================================================================
  await page.goto(LOBBY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => {
    const b = document.querySelector(".lb-code b");
    return !!b && /^[A-Z0-9]{4}$/.test((b.textContent || "").trim());
  }, null, { timeout: 40_000 });
  const room = ((await page.textContent(".lb-code b")) || "").trim();
  report.room = room;
  ok("the lobby published a room code", /^[A-Z0-9]{4}$/.test(room), room);
  const seatsBefore = await page.$$eval(".lb-seat", (els) => els.length);
  eq("the board starts as 14 AI seats", seatsBefore, 14);
  const gateBefore = await page.getAttribute(".lb-btn--go", "disabled");
  ok("Start is refused with no phone connected", gateBefore !== null, gateBefore);

  // =======================================================================
  console.log("\n### T1: 8 phones walk in through the room code");
  // =======================================================================
  for (let k = 0; k < N_PHONES; k += 1) phones.push(phone(k));
  const joins = await Promise.all(phones.map((p) => p.join(room)));
  report.joins = joins.map((m) => (m ? { t: m.t, side: m.side, number: m.number, playerId: m.playerId, color: m.color } : null));
  ok("all 8 phones were seated", joins.every((m) => m && m.t === "joined"), report.joins);
  const perSide = { red: [], blue: [] };
  for (const j of joins) if (j && j.side) perSide[j.side].push(j.number);
  report.perSide = perSide;
  eq("red filled all four human seats", perSide.red.length, 4);
  eq("blue filled all four human seats", perSide.blue.length, 4);
  ok("no side handed out the goalkeeper number",
    !perSide.red.includes(GK_NUMBER) && !perSide.blue.includes(GK_NUMBER), perSide);
  ok("numbers are unique inside a side",
    new Set(perSide.red).size === 4 && new Set(perSide.blue).size === 4, perSide);
  ok("the playerIds follow the side+number mapping the labels invert",
    joins.every((j) => j && j.playerId === expectPlayerId(j.side, j.number)),
    joins.map((j) => ({ side: j.side, number: j.number, playerId: j.playerId })));
  ok("every seat got its own colour", new Set(joins.map((j) => j.color)).size === N_PHONES,
    joins.map((j) => j.color));

  await page.waitForFunction(() => document.querySelectorAll(".lb-seat.is-human").length === 8,
    null, { timeout: 15_000 }).catch(() => {});
  const cells = await page.$$eval(".lb-seat", (els) => els.map((e) => e.className));
  report.board = {
    total: cells.length,
    human: cells.filter((c) => c.includes("is-human")).length,
    // the two goalkeepers are their own state, not "AI": TeamSeats marks them
    // `is-gk` so the lobby can say 门将 rather than a bare AI
    gk: cells.filter((c) => c.includes("is-gk")).length,
    ai: cells.filter((c) => c.includes("is-ai")).length,
  };
  eq("the board shows all 8 phones as humans", report.board.human, 8);
  eq("both goalkeepers keep their own seat", report.board.gk, 2);
  eq("leaving 4 AI outfield seats per the 4-humans-a-side cap", report.board.ai, 4);
  eq("the board still adds up to the full squad", report.board.human + report.board.gk + report.board.ai, 14);
  const gateNow = await page.getAttribute(".lb-btn--go", "disabled");
  ok("Start is now available", gateNow === null, gateNow);

  // =======================================================================
  console.log("\n### T2: kick-off hands the room to the match page");
  // =======================================================================
  await page.click(".lb-btn--go");
  await page.waitForURL((u) => u.pathname === "/match", { timeout: 30_000 }).catch(() => {});
  const url = page.url();
  report.matchUrl = url;
  ok("the big screen navigated into /match carrying the room",
    url.includes("/match") && url.includes("lan=" + room), url);
  ok("the phones were told to start",
    phones.every((p) => !!p.wait((m) => m.t === "start", 6000)),
    phones.map((p) => !!p.last((m) => m.t === "start")));

  const bootDeadline = Date.now() + 90_000;
  for (;;) {
    const probe = await Promise.race([
      page.evaluate(() => ({
        mg: !!window.__matchGame,
        st: !!(window.__matchGame && window.__matchGame.stadium),
        lab: !!window.__acLabels,
      })),
      new Promise((r) => setTimeout(() => r("wedged"), 20_000)),
    ]);
    if (probe === "wedged") {
      failures.push("the match page wedged (needs headed Chrome)");
      throw new Error("wedged");
    }
    if (probe.mg && probe.st && probe.lab) break;
    if (Date.now() > bootDeadline) throw new Error("match page boot stalled");
    await page.waitForTimeout(1_500);
  }
  await page.waitForFunction(() => (window.__acPads || []).length === 8, null, { timeout: 45_000 }).catch(() => {});
  for (const p of phones) p.send({ vx: 0, vy: 0 });
  await page.waitForTimeout(2_000);
  // "did the match actually start" — `pitch.matchStarted` is only flipped by one
  // of the kick-off paths, so accept either it or the pitch state machine
  // sitting in the engine's own playing state. Both are checked below.
  await page.waitForFunction(() => {
    const p = window.__matchGame.pitch;
    const st = p.states && p.states.current;
    const name = st && st.constructor ? st.constructor.name : "";
    return !!p.matchStarted || name === "Match";
  }, null, { timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(1_200);
  // the seat driver holds every seat until kick-off finishes, then binds them
  // all — so "pending" must drain to zero right after the whistle
  await page.waitForFunction(() => {
    const s = window.__acPadsState;
    return !!s && s.live === true && s.pending === 0;
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(600);

  // `pitch.elapsed` is a per-frame DELTA (timeScale * dt), not a clock — the
  // accumulating ones are `pitch.time` (the scoreboard clock) and
  // `pitch.simulationTime`.
  const clockA = await page.evaluate(() => ({
    t: window.__matchGame.pitch.time,
    sim: window.__matchGame.pitch.simulationTime,
  }));
  await page.waitForTimeout(1_500);
  const clockB = await page.evaluate(() => ({
    t: window.__matchGame.pitch.time,
    sim: window.__matchGame.pitch.simulationTime,
  }));

  const live = await page.evaluate(() => {
    const p = window.__matchGame.pitch;
    const stateName = (s) => (s && s.current && s.current.constructor ? s.current.constructor.name : null);
    return {
      matchStarted: !!p.matchStarted,
      paused: !!p.paused,
      ballOut: !!p.ballOutOfPlay,
      state: stateName(p.states),
      playerStates: (p.players || []).map((x) => stateName(x.states)),
      pads: (window.__acPads || []).map((p2) => ({
        padId: p2.padId, side: p2.side, number: p2.number, playerId: p2.playerId,
        ready: p2.ready, suspended: !!p2.suspended, err: p2.__err || null,
      })),
      padState: window.__acPadsState,
      // Why the pitch might be sitting in Kickoff instead of Match: the engine's
      // WaitForPlayers.update needs allPlayersCanPlay, then a prepare(), then
      // allPlayersReady && play, then readyTime >= delay. Report all of them.
      kickoff: (() => {
        const st = p.states && p.states.current;
        if (!st) return null;
        const names = (p.players || []).map((x) => (x.states && x.states.current && x.states.current.constructor.name) || "?");
        const tally = {};
        for (const n of names) tally[n] = (tally[n] || 0) + 1;
        return {
          name: (st.constructor && st.constructor.name) || "?",
          prepared: !!st.prepared,
          play: !!st.play,
          readyTime: st.readyTime,
          delay: st.delay,
          canPlay: !!p.allPlayersCanPlay,
          allReady: !!p.allPlayersReady,
          playerStateTally: tally,
        };
      })(),
      labels: (() => { const s = window.__acLabels.state(); return { humans: s.humans, ai: s.ai, built: s.built, errors: s.errors }; })(),
    };
  });
  report.live = {
    matchStarted: live.matchStarted, paused: live.paused, ballOut: live.ballOut,
    pitchState: live.state, playerStates: live.playerStates,
    clock: { from: +clockA.t.toFixed(3), to: +clockB.t.toFixed(3) },
    simFrom: +clockA.sim.toFixed(3), simTo: +clockB.sim.toFixed(3),
  };
  report.kickoff = live.kickoff;
  // the match is live: the engine clock is turning over and it is not on pause
  ok("the match clock is running", clockB.t > clockA.t, { from: clockA.t, to: clockB.t });
  ok("the engine is simulating", clockB.sim > clockA.sim, { from: clockA.sim, to: clockB.sim });
  ok("the pitch is not paused", live.paused === false, live.paused);
  ok("the engine reached its playing state (matchStarted or states.Match)",
    live.matchStarted === true || live.state === "Match",
    { matchStarted: live.matchStarted, state: live.state });
  eq("all 8 seats are attached to the engine", live.pads.length, 8);
  ok("all 8 seats are live (none suspended)", live.pads.every((p) => p.ready !== false && !p.suspended),
    live.pads.map((p) => ({ n: p.number, ready: p.ready, susp: p.suspended })));
  ok("the 8 seats bind 8 distinct players",
    new Set(live.pads.map((p) => p.playerId)).size === 8, live.pads.map((p) => p.playerId));
  eq("the seat driver reported no errors", live.padState.errors.length, 0);
  ok("seat numbers still match the players the relay picked",
    live.pads.every((p) => p.playerId === expectPlayerId(p.side, p.number)),
    live.pads.map((p) => ({ side: p.side, n: p.number, id: p.playerId })));
  eq("the label layer found 8 humans", live.labels.humans, 8);
  eq("and 6 AI", live.labels.ai, 6);
  eq("the label layer reported no errors", live.labels.errors.length, 0);

  // =======================================================================
  console.log("\n### T3: all 8 phones drive at once");
  // =======================================================================
  const dirs = phones.map((_, k) => {
    const a = (2 * Math.PI * k) / N_PHONES;
    return { vx: Math.round(Math.cos(a) * 1000) / 1000, vy: Math.round(Math.sin(a) * 1000) / 1000 };
  });
  const dirByPad = new Map(live.pads.map((p, k) => [p.padId, dirs[k]]));
  const push = () => { for (let k = 0; k < phones.length; k += 1) phones[k].send(dirs[k]); };
  const snap = () =>
    page.evaluate(() => ({
      frozen: !!(window.__matchGame.pitch && window.__matchGame.pitch.paused),
      rows: (window.__acPads || []).map((p) => ({
        padId: p.padId,
        x: p.__player ? p.__player.position.x : null,
        y: p.__player ? p.__player.position.y : null,
      })),
    }));

  push();
  const t0 = await snap();
  for (let s = 0; s < 8; s += 1) {
    push();
    await page.waitForTimeout(400);
    if (s === 4) await page.screenshot({ path: SHOT });
  }
  push();
  const t1 = await snap();
  report.drive = { frozen: t1.frozen, rows: t1.rows };

  const moved = t0.rows.map((a) => {
    const b = t1.rows.find((r) => r.padId === a.padId);
    if (!b || a.x == null || b.x == null) return null;
    return { padId: a.padId, dx: b.x - a.x, dy: b.y - a.y, len: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  report.moved = moved.map((m) => (m ? { padId: m.padId, len: +m.len.toFixed(2) } : null));
  ok("every seat had a player at both ends of the window", moved.every(Boolean), moved);
  ok("every player actually travelled", moved.every((m) => m && m.len > 1.5), report.moved);
  const aligned = moved.map((m) => {
    const d = m && dirByPad.get(m.padId);
    if (!m || !d || m.len < 0.05) return null;
    return { padId: m.padId, dot: +(m.dx / m.len * d.vx + m.dy / m.len * d.vy).toFixed(3) };
  });
  report.aligned = aligned;
  ok("every player moved along its own phone's stick", aligned.every((a) => a && a.dot > 0.5), aligned);

  // liveness: sweep a circle so nobody pins against a touchline and stalls
  let ang = 0;
  const phase = phones.map((_, k) => (2 * Math.PI * k) / N_PHONES);
  const sweep = () => {
    ang += 0.5;
    for (let k = 0; k < phones.length; k += 1) {
      phones[k].send({
        vx: Math.round(Math.cos(ang + phase[k]) * 1000) / 1000,
        vy: Math.round(Math.sin(ang + phase[k]) * 1000) / 1000,
      });
    }
  };
  sweep();
  const frames = [await snap()];
  for (let s = 0; s < 16; s += 1) {
    sweep();
    await page.waitForTimeout(200);
    frames.push(await snap());
  }
  const still = new Map(live.pads.map((p) => [p.padId, 0]));
  for (let s = 1; s < frames.length; s += 1) {
    for (const cur of frames[s].rows) {
      const prev = frames[s - 1].rows.find((r) => r.padId === cur.padId);
      if (!prev || prev.x == null || cur.x == null) continue;
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) < 0.002) still.set(cur.padId, (still.get(cur.padId) || 0) + 1);
    }
  }
  const worst = [...still.entries()].sort((a, b) => b[1] - a[1])[0];
  report.still = Object.fromEntries(still);
  ok("no seat stalled for long stretches while its phone kept pushing",
    !worst || worst[1] <= 6, { worst, still: report.still });

  // =======================================================================
  console.log("\n### T4: health after the handoff");
  // =======================================================================
  await page.screenshot({ path: SHOT, type: "png" });
  const labels = await page.evaluate(() => {
    const s = window.__acLabels.state();
    const shown = s.items.filter((i) => i.visible);
    return { shown: shown.length, humans: s.humans, lift: s.lift, headMax: s.headMax, errors: s.errors };
  });
  report.labels = labels;
  ok("the label layer is still healthy after the lobby handoff",
    labels.errors.length === 0 && labels.lift > 25 && labels.lift < 90, labels);

  const controlThrows = pageErrors.filter((e) => /take control|already controlled|Cannot take/i.test(e));
  report.pageErrors = pageErrors.slice(0, 20);
  eq("no 'Cannot take control' throw anywhere in the flow", controlThrows.length, 0);
  const hard = pageErrors.filter((e) =>
    /is not a function|is not defined|Cannot read|TypeError|ReferenceError/.test(e) && !/favicon/i.test(e));
  eq("no hard page errors", hard.length, 0);
  eq("the seat driver still reports no errors",
    (await page.evaluate(() => window.__acPadsState.errors)).length, 0);
} catch (e) {
  failures.push("threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
  console.error("  ! " + ((e && e.message) || e));
} finally {
  clearTimeout(hardTimer);
  report.ok = failures.length === 0;
  report.checks = checks;
  report.failures = failures;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n" + (failures.length === 0 ? `ALL PASS — ${checks}/${checks}` : `FAILURES — ${checks - failures.length}/${checks}`));
  for (const f of failures) console.log("  - " + f);
  console.log("report: " + REPORT);
  console.log("shot:   " + SHOT);
  for (const p of phones) p.close();
  if (browser) await browser.close().catch(() => {});
  try { relay.kill(); } catch {}
  process.exit(failures.length === 0 ? 0 : 1);
}
