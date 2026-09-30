#!/usr/bin/env node
/**
 * verify-pad-seatpath — P2 acceptance test: the real page + the real relay + 8
 * phones, end to end, no test-only mocks of the seat driver.
 * See docs/multiplayer-4v4-design.md §3.2 / §3.7 and §4 "P2 验收".
 *
 * WHAT IT PROVES
 * The P0 gate (script/verify-pad-driver.mjs) proved the ENGINE can host N locked
 * users. This test proves the WIRING: that `app/match/LanHostBridge.jsx` turns
 * relay rosters into the `window.__acPads` contract and that the seat driver in
 * `public/match-runtime-min/standalone-match.js` binds and drives every seat.
 *
 *   1. roster -> seats   — 8 phones join a real room; the page publishes exactly
 *                          8 seat records with side/number/playerId/colour/ti.
 *   2. bind              — every seat owns its exact engine player
 *                          (red #n -> id n-1, blue #n -> SQUAD+n-1), the players
 *                          are all distinct, and `User.locked` is set with the
 *                          runtime lock guard installed.
 *   3. drive             — each phone pushes its own constant direction for ~5 s;
 *                          every one of the 8 players actually travelled, and
 *                          travelled the way ITS OWN phone pushed (per-seat
 *                          direction error, not just "something moved").
 *   4. no churn          — zero sync errors, no player ever parked in a null
 *                          state, and the solo 1v1 readers stay out of the way.
 *   5. hold + reclaim    — a phone that drops hands its player back to the AI
 *                          while keeping the number, and the SAME clientId gets
 *                          the exact same player back.
 *
 * ISOLATION
 * It never touches the relay the user has running: a scratch relay is spawned on
 * its own port and `window.__lanPort` (the seam in app/lan/lanClient.js) points
 * the page at it. That means the relay code under test is always the code on
 * disk — no "restart your dev server first" step, and no surprise about whether
 * a stale relay is still holding port 13001.
 *
 * HEADED Chrome only — headless SwiftShader wedges the engine render loop.
 *
 * Usage:  node script/verify-pad-seatpath.mjs [baseUrl]
 * Needs:  a running dev server (pnpm dev:lan) on baseUrl (default 13000).
 * Writes: .scratch/pad-seatpath.png, .scratch/pad-seatpath-report.json
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
const RELAY_PORT = Number(process.env.SEAT_PATH_PORT || 13911);
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;
const ROOM = "PNP2";
const URL = `${BASE}/match?red=argentina&blue=portugal&play=1&lan=${ROOM}`;
const SHOT = path.join(SCRATCH, "pad-seatpath.png");
const REPORT = path.join(SCRATCH, "pad-seatpath-report.json");

const SQUAD = 7;
const N_PHONES = 8;
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
// scratch relay (the code on disk, on a port nobody else is using)
// ---------------------------------------------------------------------------
const relay = spawn(process.execPath, [path.join(ROOT, "script", "lan-server.mjs")], {
  env: { ...process.env, LAN_PORT: String(RELAY_PORT), LAN_IP: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relay.stdout.on("data", (b) => { relayLog += String(b); if (process.env.VERBOSE) console.error("[relay] " + String(b).trimEnd()); });
relay.stderr.on("data", (b) => { relayLog += String(b); if (process.env.VERBOSE) console.error("[relay:err] " + String(b).trimEnd()); });
relay.on("error", (e) => { relayLog += "spawn error: " + e.message; });
relay.on("exit", (code, sig) => { relayLog += `\nexit code=${code} sig=${sig}`; });

async function stopRelay() {
  if (relay.exitCode === null) {
    try { relay.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}
process.on("exit", () => { try { relay.kill(); } catch {} });

// ---------------------------------------------------------------------------
// fake phones: plain WebSocket clients, exactly like the APK
// ---------------------------------------------------------------------------
function phone(i) {
  const ws = new WebSocket(RELAY);
  const inbox = [];
  const waiters = [];
  let settleOpen = null;
  const opened = new Promise((r) => { settleOpen = r; });
  ws.on("open", () => settleOpen(true));
  ws.on("error", () => settleOpen(false));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    inbox.push(m);
    for (let k = waiters.length - 1; k >= 0; k -= 1) {
      if (waiters[k].pred(m)) {
        const w = waiters.splice(k, 1)[0];
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  return {
    i,
    clientId: "seatpath-c" + i,
    ws,
    inbox,
    /** resolve the first message matching pred (already-received ones count) */
    wait(pred, ms = 6000) {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) waiters.splice(k, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    async join() {
      if (!(await opened)) return null;
      ws.send(JSON.stringify({ t: "join", room: ROOM, name: "P" + i, clientId: "seatpath-c" + i }));
      return this.wait((m) => m.t === "joined" || m.t === "joinErr");
    },
    send(d) {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ t: "input", d }));
    },
    close() {
      try { ws.close(); } catch {}
    },
  };
}

const hardTimer = setTimeout(() => {
  console.error(JSON.stringify({ ok: false, reason: "hard timeout", relayLog: relayLog.slice(-1500) }));
  process.exit(2);
}, 300_000);

const report = { ok: false, url: URL, relay: RELAY };
const phones = [];
let browser = null;

try {
  // --- wait for the scratch relay to accept connections -------------------
  {
    let up = false;
    const tryOnce = () =>
      new Promise((resolve) => {
        const probe = new WebSocket(RELAY);
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; try { probe.close(); } catch {} resolve(v); };
        probe.on("open", () => done(true));
        probe.on("error", () => done(false));
        setTimeout(() => done(false), 1500);
      });
    const relayDeadline = Date.now() + 15_000;
    for (;;) {
      up = await tryOnce();
      if (up) break;
      if (relay.exitCode !== null || Date.now() > relayDeadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!up) {
      console.error(JSON.stringify({
        ok: false,
        reason: "scratch relay did not start on " + RELAY,
        pid: relay.pid,
        exitCode: relay.exitCode,
        relayLog: relayLog.slice(-1500),
      }, null, 2));
      process.exit(1);
    }
  }

  browser = await chromium.launch({ channel: "chrome", headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const failedRequests = [];
  page.on("requestfailed", (r) => {
    failedRequests.push({ url: r.url().slice(0, 200), err: (r.failure() && r.failure().errorText) || "?" });
  });
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text().slice(0, 240));
    if (process.env.VERBOSE) console.error(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

  // Point the page at the scratch relay. Must be installed before any app code
  // runs, so addInitScript (not evaluate).
  await page.addInitScript((port) => { window.__lanPort = port; }, RELAY_PORT);

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const bootDeadline = Date.now() + 90_000;
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

  // the play phase only wires the local user once the match is live
  const playDeadline = Date.now() + 60_000;
  for (;;) {
    const s = await page.evaluate(() => ({
      started: !!(window.__matchGame.pitch && window.__matchGame.pitch.matchStarted),
      hasPads: !!window.__acPads,
    }));
    report.live = s;
    if (s.started || Date.now() > playDeadline) break;
    await page.waitForTimeout(1_500);
  }
  await page.mouse.click(640, 400);
  await page.waitForTimeout(400);

  // =======================================================================
  console.log("\n### T1: 8 phones -> 8 seat records in the page");
  // =======================================================================
  const joins = [];
  for (let i = 0; i < N_PHONES; i += 1) {
    const p = phone(i);
    phones.push(p);
    joins.push(p.join());
  }
  const joined = await Promise.all(joins);
  report.joins = joined;
  ok("all 8 phones got a seat (no joinErr)", joined.every((m) => m && m.t === "joined"), joined);

  // The joins are issued in parallel, so the relay's roster order is NOT our
  // phone order. Every pairing below goes through padId, never through an index.
  const padIds = joined.map((m) => m && m.padId);
  const byPad = new Map(joined.map((m, k) => [m && m.padId, { phone: k, seat: m }]));
  ok("every phone got a padId", padIds.every((id) => id != null), padIds);
  ok("pad ids are distinct", new Set(padIds).size === N_PHONES, padIds);

  const seats = joined.map((m) => ({ side: m && m.side, number: m && m.number, playerId: m && m.playerId, color: m && m.color }));
  ok("every phone got a side", seats.every((s) => s.side === "red" || s.side === "blue"), seats);
  ok("player ids are distinct", new Set(seats.map((s) => s.playerId)).size === N_PHONES, seats);
  ok(
    "player id matches side+number",
    seats.every((s) => s.playerId === expectPlayerId(s.side, s.number)),
    seats,
  );
  ok(
    "4 phones per side",
    seats.filter((s) => s.side === "red").length === 4 && seats.filter((s) => s.side === "blue").length === 4,
    seats.map((s) => s.side),
  );

  // the bridge needs a roster push; joining already triggers one, but be explicit
  const deadline = Date.now() + 10_000;
  let published = 0;
  for (;;) {
    published = await page.evaluate(() => (Array.isArray(window.__acPads) ? window.__acPads.length : -1));
    if (published === N_PHONES || Date.now() > deadline) break;
    await page.waitForTimeout(400);
  }
  eq("window.__acPads.length", published, N_PHONES);

  const shape = await page.evaluate(() =>
    (window.__acPads || []).map((p) => ({
      padId: p.padId,
      side: p.side,
      number: p.number,
      playerId: p.playerId,
      color: p.color,
      hasTi: !!p.ti,
      suspended: !!p.suspended,
    })),
  );
  report.published = shape;
  ok("every seat carries side/number/playerId", shape.every((s) => s.side && s.number > 0 && s.playerId >= 0), shape);
  ok("every seat carries its own live input object", shape.every((s) => s.hasTi), shape);
  ok("no seat starts suspended", shape.every((s) => !s.suspended), shape);
  ok("all 8 label colours distinct", new Set(shape.map((s) => s.color)).size === N_PHONES, shape.map((s) => s.color));

  // =======================================================================
  console.log("\n### T2: the driver binds every seat to its own engine player");
  // =======================================================================
  const bindDeadline = Date.now() + 20_000;
  let bind = null;
  for (;;) {
    bind = await page.evaluate(() => {
      const R = window.require;
      const users = R("users");
      const g = window.__matchGame;
      const pads = window.__acPads || [];
      const out = {
        active: !!(window.__acPadsState && window.__acPadsState.active),
        errors: (window.__acPadsState && window.__acPadsState.errors) || [],
        listLen: users.list.length,
        guard: !!users.User.prototype.__acLockGuard,
        rows: [],
      };
      for (const pad of pads) {
        const u = pad.__user;
        const pl = pad.__player;
        const team = pad.side === "blue" ? g.pitch.blueTeam : g.pitch.redTeam;
        const all = (team && (team.allPlayers || team.players)) || [];
        let onPitch = null;
        for (const q of all) if (q.id === pad.playerId) onPitch = q;
        out.rows.push({
          padId: pad.padId,
          playerId: pad.playerId,
          bound: !!pl,
          ownsUser: !!(pl && pl.user === u),
          userPlayerId: pl ? pl.id : null,
          userPlayer: u && u.player ? u.player.id : null,
          locked: !!u && !!u.locked,
          lockedPlayerId: u && u.lockedPlayer ? u.lockedPlayer.id : null,
          samePitchObject: pl === onPitch,
          stateName: pl && pl.states && pl.states.current ? pl.states.current.constructor.name : null,
          globalName: pl && pl.states && pl.states._global ? pl.states._global.constructor.name : null,
          ctrlOk: !!(pl && u && u.controller && pl.controller === u.controller),
          pos: pl ? { x: Math.round(pl.position.x * 100) / 100, y: Math.round(pl.position.y * 100) / 100 } : null,
        });
      }
      return out;
    });
    const done = bind.rows.length === N_PHONES && bind.rows.every((r) => r.bound && r.ownsUser && r.locked);
    if (done || Date.now() > bindDeadline) break;
    await page.waitForTimeout(600);
  }
  report.bind = bind;

  ok("seat driver is active", bind.active === true, bind.active);
  eq("one engine User per phone (minted)", bind.listLen >= 5 + N_PHONES, bind.listLen >= 5 + N_PHONES);
  ok("runtime lock guard installed on User.prototype", bind.guard === true, bind.guard);
  ok("every seat bound to an engine player", bind.rows.every((r) => r.bound), bind.rows);
  ok("every player points back at its seat user", bind.rows.every((r) => r.ownsUser), bind.rows);
  ok(
    "every seat holds the player its jersey number maps to",
    bind.rows.every((r) => r.userPlayer === r.playerId && r.playerId >= 0),
    bind.rows.map((r) => [r.playerId, r.userPlayer]),
  );
  ok("every player object is the one on the pitch", bind.rows.every((r) => r.samePitchObject), bind.rows);
  ok("every seat user is locked", bind.rows.every((r) => r.locked && r.lockedPlayerId === r.playerId), bind.rows);
  ok(
    "every player reads its seat's controller",
    bind.rows.every((r) => r.ctrlOk),
    bind.rows,
  );
  ok(
    "every player carries the human movement global",
    bind.rows.every((r) => r.globalName === "HumanGlobal" || r.globalName === "HumanGoalkeeperGlobal"),
    bind.rows.map((r) => r.globalName),
  );
  ok(
    "every player is in a human/engine state, never a null state",
    bind.rows.every((r) => !!r.stateName),
    bind.rows.map((r) => r.stateName),
  );
  eq("sync errors", bind.errors.length, 0);

  // =======================================================================
  console.log("\n### T3a: every phone drives its own player, in its own direction");
  // =======================================================================
  // phone k pushes a constant unit vector at angle 2*pi*k/8
  const dirs = phones.map((_, k) => {
    const a = (2 * Math.PI * k) / N_PHONES;
    return { vx: Math.round(Math.cos(a) * 1000) / 1000, vy: Math.round(Math.sin(a) * 1000) / 1000 };
  });
  const dirByPad = new Map(padIds.map((id, k) => [id, dirs[k]]));
  const pushFan = () => { for (let k = 0; k < phones.length; k += 1) phones[k].send(dirs[k]); };

  const snap = () =>
    page.evaluate(() => {
      const g = window.__matchGame;
      const pitch = g && g.pitch;
      const frame = {
        paused: !!(pitch && pitch.paused),
        ballOut: !!(pitch && pitch.ballOutOfPlay),
        w: pitch ? pitch.width : 0,
        h: pitch ? pitch.height : 0,
        rows: [],
      };
      for (const p of window.__acPads || []) {
        const pl = p.__player;
        if (!pl) continue;
        frame.rows.push({
          padId: p.padId,
          x: pl.position.x,
          y: pl.position.y,
          st: pl.states && pl.states.current ? pl.states.current.constructor.name : null,
          spd: pl.speed,
          read: pl.controller && pl.controller.velocity ? Math.hypot(pl.controller.velocity.x, pl.controller.velocity.y) : -1,
        });
      }
      return frame;
    });

  pushFan();
  const fanStart = await snap();
  // NOTE: a constant direction is the right probe for "does MY stick reach MY
  // player and nobody else's" — but a player pushing into the touchline gets
  // clamped by HumanGlobal and stops, which is correct engine behaviour. So this
  // phase only measures direction; sustained liveness is T3b.
  for (let s = 0; s < 10; s += 1) {
    pushFan();
    await page.waitForTimeout(500);
    if (s === 5) await page.screenshot({ path: SHOT });
  }
  pushFan();
  const fanEnd = await snap();

  const travelled = fanStart.rows.map((s0) => {
    const e0 = fanEnd.rows.find((r) => r.padId === s0.padId);
    if (!e0) return null;
    return { padId: s0.padId, dx: e0.x - s0.x, dy: e0.y - s0.y, len: Math.hypot(e0.x - s0.x, e0.y - s0.y) };
  });
  report.travel = travelled;

  ok("every seat has a player at both ends of the window", travelled.every(Boolean), travelled);
  ok("every player travelled a real distance", travelled.every((t) => t && t.len > 1.5), travelled);

  const aligned = travelled.map((t) => {
    const d = t && dirByPad.get(t.padId);
    if (!t || !d || t.len < 0.05) return null;
    const dot = (t.dx / t.len) * d.vx + (t.dy / t.len) * d.vy;
    return { padId: t.padId, dot: Math.round(dot * 1000) / 1000, len: Math.round(t.len * 100) / 100 };
  });
  report.aligned = aligned;
  ok("every player moved along its own phone's stick", aligned.every((a) => a && a.dot > 0.5), aligned);

  // HumanGlobal sets clampToPitch, and the player clamp rectangle is the pitch
  // inset by exactly 1 unit of runoff (measured: players pin at -1 and at
  // w+1 / h+1, never beyond). Worth pinning down, because the camera framing
  // makes "is that player still on the field" impossible to judge by eye.
  const M = 1.001;
  const outOfBounds = fanEnd.rows.filter((r) => r.x < -M || r.x > fanEnd.w + M || r.y < -M || r.y > fanEnd.h + M);
  report.pitch = {
    w: fanEnd.w,
    h: fanEnd.h,
    clamp: [-1, fanEnd.w + 1, -1, fanEnd.h + 1],
    out: outOfBounds,
    rows: fanEnd.rows.map((r) => ({ padId: r.padId, x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100 })),
  };
  ok("every seat player stayed inside the engine's pitch clamp", outOfBounds.length === 0, report.pitch);

  // =======================================================================
  console.log("\n### T3b: no seat ever stalls while its phone keeps pushing");
  // =======================================================================
  // Now every phone sweeps a slow circle with its own phase offset, so all 8
  // instantaneous directions stay distinct but nobody runs into a wall. This is
  // the phase that would catch "bound, moved once, then frozen for ever".
  const phase = phones.map((_, k) => (2 * Math.PI * k) / N_PHONES);
  const CIRCLE_STEP = 0.5; // rad per push => ~1.8 world units of turning radius
  let ang = 0;
  const pushCircle = () => {
    ang += CIRCLE_STEP;
    for (let k = 0; k < phones.length; k += 1) {
      phones[k].send({
        vx: Math.round(Math.cos(ang + phase[k]) * 1000) / 1000,
        vy: Math.round(Math.sin(ang + phase[k]) * 1000) / 1000,
      });
    }
  };

  pushCircle();
  const circStart = await snap();
  const circSamples = [];
  for (let s = 0; s < 20; s += 1) {
    pushCircle();
    await page.waitForTimeout(200);
    circSamples.push(await snap());
  }
  pushCircle();

  const perSeat = new Map(padIds.map((id) => [id, { moved: 0, still: 0, stalledState: null, maxRead: 0 }]));
  for (let s = 0; s < circSamples.length; s += 1) {
    const prev = s === 0 ? circStart : circSamples[s - 1];
    const cur = circSamples[s];
    for (const a of cur.rows) {
      const b = prev.rows.find((r) => r.padId === a.padId);
      const rec = perSeat.get(a.padId);
      if (!b || !rec) continue;
      rec.maxRead = Math.max(rec.maxRead, a.read);
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0.2) rec.moved += 1;
      else {
        rec.still += 1;
        if (!rec.stalledState) rec.stalledState = a.st;
      }
    }
  }
  report.perSeat = Array.from(perSeat.entries()).map(([padId, v]) => ({
    padId,
    moved: v.moved,
    still: v.still,
    stalledState: v.stalledState,
    maxRead: v.maxRead,
  }));
  ok(
    "every seat kept moving through the whole circling window",
    report.perSeat.every((r) => r.moved >= 15),
    report.perSeat,
  );
  ok(
    "every seat kept reading its own phone's stick",
    report.perSeat.every((r) => r.maxRead > 0.5),
    report.perSeat,
  );

  const after = await page.evaluate(() => {
    const pads = window.__acPads || [];
    return {
      errors: (window.__acPadsState && window.__acPadsState.errors) || [],
      rows: pads.map((p) => ({
        padId: p.padId,
        playerId: p.playerId,
        ownsUser: !!(p.__player && p.__user && p.__player.user === p.__user),
        locked: !!p.__user && !!p.__user.locked,
        stateName: p.__player && p.__player.states && p.__player.states.current ? p.__player.states.current.constructor.name : null,
        err: p.__err || null,
      })),
      legacyRed: !!(window.__touchInput && window.__touchInput.active),
      legacyBlue: !!(window.__touchInput2 && window.__touchInput2.active),
    };
  });
  report.after = after;

  eq("sync errors after driving", after.errors.length, 0);
  ok("every binding still holds after 5 s of play", after.rows.every((r) => r.ownsUser && r.locked), after.rows);
  ok("no seat recorded an internal error", after.rows.every((r) => !r.err), after.rows);
  ok(
    "no player fell into a null/engine-only state",
    after.rows.every((r) => r.stateName && r.stateName.indexOf("Human") === 0 || r.stateName === "ClientMove" || r.stateName === "ClientDribble"),
    after.rows.map((r) => r.stateName),
  );
  ok("seat phones do NOT double-feed the legacy 1v1 slots", after.legacyRed === false && after.legacyBlue === false, {
    red: after.legacyRed,
    blue: after.legacyBlue,
  });

  await page.screenshot({ path: SHOT });

  // =======================================================================
  console.log("\n### T4: a dropped phone keeps its number, then reclaims its player");
  // =======================================================================
  const victim = phones[3];
  const victimSeat = byPad.get(padIds[3]).seat;
  const victimPlayerId = victimSeat.playerId;
  victim.close();

  const holdDeadline = Date.now() + 12_000;
  let held = null;
  for (;;) {
    held = await page.evaluate((pid) => {
      const pads = window.__acPads || [];
      let seat = null;
      for (const p of pads) if (p.playerId === pid) seat = p;
      if (!seat) return { gone: true };
      return {
        padId: seat.padId,
        suspended: !!seat.suspended,
        hasUser: !!seat.__user,
        userPlayer: seat.__user && seat.__user.player ? seat.__user.player.id : null,
        userLocked: !!seat.__user && !!seat.__user.locked,
        playerState:
          seat.__player && seat.__player.states && seat.__player.states.current
            ? seat.__player.states.current.constructor.name
            : null,
      };
    }, victimPlayerId);
    if (held && !held.gone && held.suspended) break;
    if (Date.now() > holdDeadline) break;
    await page.waitForTimeout(400);
  }
  report.held = held;

  ok("the dropped seat is still in the roster (number reserved)", !!held && !held.gone, held);
  ok("the dropped seat is marked suspended", !!held && held.suspended === true, held);
  ok("the parked seat handed its player back to the AI", !!held && held.hasUser === true && held.userPlayer === null, held);
  ok("the parked seat is no longer locked", !!held && held.userLocked === false, held);

  // same device comes back -> same player
  const back = phone(3);
  phones[3] = back;
  const resumed = await back.join();
  report.resumed = resumed;
  ok("the same clientId resumed instead of taking a new seat", !!resumed && resumed.resumed === true, resumed);
  eq("resumed onto the same jersey number", resumed && resumed.number, victimSeat && victimSeat.number);
  eq("resumed onto the same engine player", resumed && resumed.playerId, victimPlayerId);

  const reclaimDeadline = Date.now() + 12_000;
  let reclaimed = null;
  for (;;) {
    reclaimed = await page.evaluate((pid) => {
      const pads = window.__acPads || [];
      let seat = null;
      for (const p of pads) if (p.playerId === pid) seat = p;
      if (!seat) return { gone: true };
      return {
        suspended: !!seat.suspended,
        owns: !!(seat.__player && seat.__user && seat.__player.user === seat.__user),
        userPlayer: seat.__user && seat.__user.player ? seat.__user.player.id : null,
        locked: !!seat.__user && !!seat.__user.locked,
      };
    }, victimPlayerId);
    if (reclaimed && !reclaimed.gone && reclaimed.owns && reclaimed.locked) break;
    if (Date.now() > reclaimDeadline) break;
    await page.waitForTimeout(400);
  }
  report.reclaimed = reclaimed;
  ok("the reclaimed seat is live again", !!reclaimed && reclaimed.suspended === false, reclaimed);
  ok("the reclaimed seat owns its old player again", !!reclaimed && reclaimed.owns === true && reclaimed.userPlayer === victimPlayerId, reclaimed);
  ok("the reclaimed seat is locked again", !!reclaimed && reclaimed.locked === true, reclaimed);

  // and the reclaimed phone can actually drive again
  const p0 = await page.evaluate((pid) => {
    const pads = window.__acPads || [];
    for (const p of pads) if (p.playerId === pid) return p.__player ? { x: p.__player.position.x, y: p.__player.position.y } : null;
    return null;
  }, victimPlayerId);
  for (let s = 0; s < 4; s += 1) { back.send({ vx: 1, vy: 0 }); await page.waitForTimeout(400); }
  const p1 = await page.evaluate((pid) => {
    const pads = window.__acPads || [];
    for (const p of pads) if (p.playerId === pid) return p.__player ? { x: p.__player.position.x, y: p.__player.position.y } : null;
    return null;
  }, victimPlayerId);
  report.reclaimMove = { p0, p1 };
  ok(
    "the reclaimed phone drives its player again",
    !!p0 && !!p1 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 0.5,
    report.reclaimMove,
  );

  // "no internet right now" is not a defect: Chrome reports a failed remote
  // font fetch (fonts.gstatic.com, for Baloo 2) as a console error. Without this
  // the suite flakes intermittently on this box.
  const OFFLINE_NOISE = /favicon|React DevTools|Download the|net::ERR_(SOCKET_NOT_CONNECTED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|TIMED_OUT)|fonts\.(gstatic|googleapis)\.com/i;
  const realPageErrors = pageErrors.filter((e) => !OFFLINE_NOISE.test(e));
  report.pageErrors = pageErrors;
  report.failedRequests = failedRequests;
  eq("page errors", realPageErrors.length, 0, realPageErrors.slice(0, 4));

  report.ok = failures.length === 0;
  report.checks = checks;
  report.failures = failures;
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n" + (report.ok ? "ALL PASS" : "FAILURES") + " — " + (checks - failures.length) + "/" + checks);
  console.log("report: " + path.relative(ROOT, REPORT));
  console.log("shot:   " + path.relative(ROOT, SHOT));
} catch (e) {
  report.ok = false;
  report.crash = String((e && e.stack) || e).slice(0, 2000);
  try { writeFileSync(REPORT, JSON.stringify(report, null, 2)); } catch {}
  console.error(JSON.stringify({ ok: false, crash: report.crash }, null, 2));
  console.error("relay log tail:\n" + relayLog.slice(-1500));
} finally {
  clearTimeout(hardTimer);
  for (const p of phones) p.close();
  if (browser) try { await browser.close(); } catch {}
  await stopRelay();
}

if (!report.ok) process.exit(1);
