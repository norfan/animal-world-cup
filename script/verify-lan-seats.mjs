#!/usr/bin/env node
/**
 * verify-lan-seats — P1 acceptance test for the LAN relay seat model.
 * See docs/multiplayer-4v4-design.md §3.1 / §3.5 and §4 "P1 验收".
 *
 * Spins up a scratch relay on its own port and drives it with plain WebSocket
 * clients (no browser, no game). It asserts:
 *
 *   1. auto side split      — 8 phones that ask for nothing land 4 red / 4 blue,
 *                             distinct jersey numbers, correct engine player ids
 *                             (red #n -> n-1, blue #n -> SQUAD+n-1), GK #1 never
 *                             handed out, all label colours distinct.
 *   2. side-full / full     — a 9th phone is refused with reason "side-full"
 *                             ("full" once nothing is free at all); four phones
 *                             that all demand "blue" keep the cap and a fifth
 *                             demanding blue is refused while red is still open.
 *   3. pick / lock          — host `pick` re-seats a phone and swaps the number it
 *                             took; after `lock` every further pick is refused.
 *   4. seat hold            — a dropped phone's seat stays reserved (ready:false)
 *                             so the SAME clientId gets its exact player back,
 *                             while a different phone can never steal that number.
 *   5. roster counts        — humans + ai === SQUAD on each side, always.
 *
 * Usage: node script/verify-lan-seats.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SEAT_TEST_PORT || 13901);
const URL = `ws://127.0.0.1:${PORT}`;

const SQUAD = 7;
const BINDABLE = [2, 3, 4, 5, 6, 7];
const HUMANS_PER_SIDE = 4;
const expectPlayerId = (side, n) => (side === "blue" ? SQUAD + n - 1 : n - 1);

const failures = [];
let checks = 0;
function ok(label, cond, extra) {
  checks += 1;
  if (cond) {
    console.log("  \u2713 " + label);
  } else {
    failures.push(label + (extra ? "  -> " + JSON.stringify(extra) : ""));
    console.log("  \u2717 " + label + (extra ? "  -> " + JSON.stringify(extra) : ""));
  }
}
function eq(label, actual, expected) {
  ok(label + " === " + JSON.stringify(expected), actual === expected, { actual });
}

// --- tiny client -----------------------------------------------------------
function open() {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];
  ws.on("error", () => {}); // a refused connect must not crash the harness
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
  const cli = {
    ws,
    inbox,
    send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)),
    /** wait for the next message matching pred (also scans what already arrived). */
    wait(pred, ms = 1500) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve) => {
        const w = { pred, resolve };
        w.timer = setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) waiters.splice(j, 1);
          resolve(null);
        }, ms);
        waiters.push(w);
      });
    },
    /** wait for the roster whose pads satisfy pred — rosters arrive in bursts. */
    async roster(pred, ms = 1500) {
      const deadline = Date.now() + ms;
      for (;;) {
        const m = await cli.wait((x) => x.t === "roster" && pred(x), Math.max(50, deadline - Date.now()));
        if (m) return m;
        if (Date.now() >= deadline) return null;
      }
    },
    /** true once connected; false on refusal/timeout instead of throwing. */
    ready(ms = 3000) {
      if (ws.readyState === 1) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (v) => { clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(false), ms);
        ws.once("open", () => done(true));
        ws.once("error", () => done(false));
        ws.once("close", () => done(false));
      });
    },
    close: () => { try { ws.close(); } catch {} },
  };
  return cli;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bySide = (pads, side) => pads.filter((p) => p.side === side);

// --- harness ---------------------------------------------------------------
let relay;
async function startRelay() {
  relay = spawn(process.execPath, [path.join(ROOT, "script", "lan-server.mjs")], {
    env: { ...process.env, LAN_PORT: String(PORT), LAN_IP: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout.on("data", () => {});
  relay.stderr.on("data", (d) => process.stderr.write("[relay] " + d));
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    const probe = open();
    const up = await probe.ready(400);
    probe.close();
    if (up) return;
  }
  throw new Error("relay did not come up on port " + PORT);
}

async function newRoom(label) {
  const host = open();
  await host.ready();
  host.send({ t: "host", room: "" });
  const hosted = await host.wait((m) => m.t === "hosted");
  if (!hosted) throw new Error("no `hosted` for " + label);
  console.log("\n### " + label + "  (room " + hosted.room + ")");
  return { host, room: hosted.room, hosted };
}

try {
  await startRelay();

  // ============ TEST 1: auto split of 8 phones ============
  {
    const { host, room, hosted } = await newRoom("T1 auto split");
    eq("hosted.humansPerSide", hosted.humansPerSide, HUMANS_PER_SIDE);
    eq("hosted.squad", hosted.squad, SQUAD);
    ok("hosted.bindable excludes the keeper", !hosted.bindable.includes(1) && hosted.bindable.length === 6, hosted.bindable);

    const pads = [];
    for (let i = 0; i < 8; i += 1) {
      const c = open();
      await c.ready();
      c.send({ t: "join", room, name: "P" + (i + 1), clientId: "dev" + i });
      const joined = await c.wait((m) => m.t === "joined" || m.t === "joinErr");
      pads.push({ c, joined });
    }
    ok("all 8 joined", pads.every((p) => p.joined && p.joined.t === "joined"),
      pads.map((p) => p.joined && p.joined.t));

    const last = await host.roster((m) => m.pads.length === 8);
    ok("roster carries 8 pads", !!last, last && last.pads.length);

    const r = bySide(last.pads, "red");
    const b = bySide(last.pads, "blue");
    eq("red humans", r.length, 4);
    eq("blue humans", b.length, 4);
    eq("counts.red.ai", last.counts.red.ai, SQUAD - 4);
    eq("counts.blue.ai", last.counts.blue.ai, SQUAD - 4);

    for (const side of ["red", "blue"]) {
      const sidePads = bySide(last.pads, side);
      const nums = sidePads.map((p) => p.number).sort((x, y) => x - y);
      ok(side + " numbers are 4 distinct bindable ones", new Set(nums).size === 4 && nums.every((n) => BINDABLE.includes(n)), nums);
      ok(side + " playerId matches number", sidePads.every((p) => p.playerId === expectPlayerId(side, p.number)),
        sidePads.map((p) => [p.number, p.playerId]));
      const slots = new Set(sidePads.map((p) => p.slot));
      eq(side + " legacy slot", [...slots][0], side === "red" ? 0 : 1);
    }
    const colors = last.pads.map((p) => p.color);
    ok("all 8 label colours are distinct", new Set(colors).size === 8, colors);
    ok("no one was given the keeper", last.pads.every((p) => p.number !== 1), last.pads.map((p) => p.number));
    ok("counts always add up to the squad", last.counts.red.humans + last.counts.red.ai === SQUAD && last.counts.blue.humans + last.counts.blue.ai === SQUAD, last.counts);
    ok("all 8 playerIds are distinct", new Set(last.pads.map((p) => p.playerId)).size === 8);

    // input relay carries the seat binding
    const p0 = last.pads[0];
    const cli0 = pads.find((p) => p.joined && p.joined.padId === p0.padId).c;
    cli0.send({ t: "input", d: { vx: 1, vy: 0 } });
    const inp = await host.wait((m) => m.t === "input");
    ok("input echoes side/number/playerId", !!inp && inp.side === p0.side && inp.number === p0.number && inp.playerId === p0.playerId, inp);

    // 9th is refused (nothing free anywhere -> "full"; see T2 for "side-full")
    const p9 = open();
    await p9.ready();
    p9.send({ t: "join", room, name: "P9", clientId: "dev9" });
    const err9 = await p9.wait((m) => m.t === "joinErr");
    eq("9th phone refused with full", err9 && err9.reason, "full");

    // ...and asking for either side explicitly is refused too
    const p9r = open();
    await p9r.ready();
    p9r.send({ t: "join", room, name: "P9r", side: "red", clientId: "dev9r" });
    const err9r = await p9r.wait((m) => m.t === "joinErr");
    eq("9th phone asking for red is refused with full", err9r && err9r.reason, "full");

    pads.forEach((p) => p.c.close());
    p9.close();
    p9r.close();
    host.close();
    await sleep(150);
  }

  // ============ TEST 2: explicit side + side cap ============
  {
    const { host, room } = await newRoom("T2 explicit side");
    const blues = [];
    for (let i = 0; i < 4; i += 1) {
      const c = open();
      await c.ready();
      c.send({ t: "join", room, name: "B" + (i + 1), side: "blue", clientId: "blue" + i });
      blues.push({ c, joined: await c.wait((m) => m.t === "joined" || m.t === "joinErr") });
    }
    ok("4 blue requests all joined blue", blues.every((p) => p.joined && p.joined.side === "blue"),
      blues.map((p) => p.joined && [p.joined.t, p.joined.side]));
    const last = await host.roster((m) => m.pads.length === 4);
    const bnums = bySide(last.pads, "blue").map((p) => p.number).sort((x, y) => x - y);
    eq("blue took the 4 lowest bindable numbers", JSON.stringify(bnums), JSON.stringify([2, 3, 4, 5]));

    const fifth = open();
    await fifth.ready();
    fifth.send({ t: "join", room, name: "B5", side: "blue", clientId: "blue9" });
    const err5 = await fifth.wait((m) => m.t === "joinErr");
    eq("5th blue phone refused with side-full", err5 && err5.reason, "side-full");

    const noSide = open();
    await noSide.ready();
    noSide.send({ t: "join", room, name: "Any", clientId: "auto0" });
    const j = await noSide.wait((m) => m.t === "joined" || m.t === "joinErr");
    ok("a side-less phone is balanced onto the open side (red)", j && j.t === "joined" && j.side === "red", j);

    // an explicit request must NEVER be silently re-homed
    const strict = open();
    await strict.ready();
    strict.send({ t: "join", room, name: "Strict", side: "blue", clientId: "strict0" });
    const js = await strict.wait((m) => m.t === "joined" || m.t === "joinErr");
    ok("an explicit blue request is not silently moved to red", js && js.t === "joinErr" && js.reason === "side-full", js);

    blues.forEach((p) => p.c.close());
    fifth.close();
    noSide.close();
    strict.close();
    host.close();
    await sleep(150);
  }

  // ============ TEST 3: pick / lock ============
  {
    const { host, room } = await newRoom("T3 pick + lock");
    const a = open();
    await a.ready();
    a.send({ t: "join", room, name: "A", side: "red", clientId: "a" });
    const ja = await a.wait((m) => m.t === "joined");
    const b = open();
    await b.ready();
    b.send({ t: "join", room, name: "B", side: "red", clientId: "b" });
    const jb = await b.wait((m) => m.t === "joined");
    eq("A got red #2", ja.number, 2);
    eq("B got red #3", jb.number, 3);

    host.send({ t: "pick", padId: ja.padId, number: 7 });
    const bindA = await a.wait((m) => m.t === "bind" && m.number === 7);
    ok("pick re-seats A to #7", !!bindA && bindA.playerId === expectPlayerId("red", 7), bindA);
    host.send({ t: "pick", padId: jb.padId, number: 2 });
    const bindB = await b.wait((m) => m.t === "bind" && m.number === 2);
    ok("A's vacated #2 is now free for B", !!bindB && bindB.playerId === expectPlayerId("red", 2), bindB);

    // 1 is the keeper (never bindable) and 9 does not exist in a 7-player squad
    host.send({ t: "pick", padId: ja.padId, number: 1 });
    const errKeeper = await host.wait((m) => m.t === "pickErr" && m.reason === "bad-number");
    ok("the keeper's #1 can never be picked", !!errKeeper, errKeeper);
    host.send({ t: "pick", padId: ja.padId, number: 9 });
    const errRange = await host.wait((m) => m.t === "pickErr" && m.reason === "bad-number");
    ok("out-of-range numbers are refused", !!errRange, errRange);

    host.send({ t: "lock", locked: true });
    const lockedMsg = await a.wait((m) => m.t === "locked");
    ok("pads learn about the lock", !!lockedMsg && lockedMsg.locked === true, lockedMsg);
    host.send({ t: "pick", padId: jb.padId, number: 5 });
    const errLocked = await host.wait((m) => m.t === "pickErr" && m.reason === "locked");
    ok("pick after lock is refused", !!errLocked, errLocked);

    a.close();
    b.close();
    host.close();
    await sleep(150);
  }

  // ============ TEST 4: seat hold across a phone reconnect ============
  {
    const { host, room } = await newRoom("T4 seat hold");
    const a = open();
    await a.ready();
    a.send({ t: "join", room, name: "A", side: "red", clientId: "phone-a" });
    const ja = await a.wait((m) => m.t === "joined");

    // A drops mid-match
    a.close();
    const held = await host.roster((m) => m.pads.some((p) => p.padId === ja.padId && p.ready === false));
    ok("dropped seat stays reserved (ready:false)", !!held, held && held.pads);
    ok("reserved seat keeps its number", !!held && held.pads.find((p) => p.padId === ja.padId).number === ja.number, held && held.pads);

    // a DIFFERENT phone must not be able to take that number
    const c = open();
    await c.ready();
    c.send({ t: "join", room, name: "C", side: "red", clientId: "phone-c" });
    const jc = await c.wait((m) => m.t === "joined" || m.t === "joinErr");
    ok("another phone cannot steal the reserved number", jc && jc.t === "joined" && jc.number !== ja.number, jc);

    // ...but the SAME device gets its exact player back
    const a2 = open();
    await a2.ready();
    a2.send({ t: "join", room, name: "A", side: "red", clientId: "phone-a" });
    const back = await a2.wait((m) => m.t === "joined" || m.t === "joinErr");
    ok("same clientId resumes its own seat", !!back && back.t === "joined" && back.resumed === true, back);
    eq("resumed jersey number", back && back.number, ja.number);
    eq("resumed playerId", back && back.playerId, ja.playerId);
    eq("resumed padId", back && back.padId, ja.padId);

    a2.close();
    c.close();
    host.close();
    await sleep(150);
  }

  // ============ TEST 5: the legacy two-gamepad contract still holds ============
  // The lobby slot cards and the current host bridge read `slot` and nothing
  // else. If this block ever fails, today's 1v1 LAN play is broken.
  {
    const { host, room } = await newRoom("T5 legacy 2-gamepad contract");
    const a = open();
    await a.ready();
    a.send({ t: "join", room, name: "Pad1" }); // exactly what PadController sends today
    const ja = await a.wait((m) => m.t === "joined" || m.t === "joinErr");
    const b = open();
    await b.ready();
    b.send({ t: "join", room, name: "Pad2" });
    const jb = await b.wait((m) => m.t === "joined" || m.t === "joinErr");

    eq("first legacy pad -> red", ja && ja.side, "red");
    eq("first legacy pad slot", ja && ja.slot, 0);
    eq("first legacy pad jersey", ja && ja.number, 2);
    eq("first legacy pad playerId", ja && ja.playerId, 1);
    eq("second legacy pad -> blue", jb && jb.side, "blue");
    eq("second legacy pad slot", jb && jb.slot, 1);
    eq("second legacy pad jersey", jb && jb.number, 2);
    eq("second legacy pad playerId", jb && jb.playerId, 8);

    const r = await host.roster((m) => m.pads.length === 2);
    ok("roster still exposes padId/name/slot/ready", !!r && r.pads.every((p) => "padId" in p && "name" in p && "slot" in p && "ready" in p),
      r && r.pads);
    eq("roster slots are 0 and 1", JSON.stringify(r.pads.map((p) => p.slot).sort()), JSON.stringify([0, 1]));

    a.send({ t: "input", d: { vx: 0, vy: -1 } });
    const inp = await host.wait((m) => m.t === "input");
    ok("input still carries slot (the old bridge reads only this)", !!inp && inp.slot === 0, inp);

    host.send({ t: "start", info: { red: "argentina", blue: "portugal" } });
    const sa = await a.wait((m) => m.t === "start");
    const sb = await b.wait((m) => m.t === "start");
    eq("start reaches pad 1 with slot", sa && sa.slot, 0);
    eq("start reaches pad 2 with slot", sb && sb.slot, 1);

    host.send({ t: "ended" });
    const ea = await a.wait((m) => m.t === "ended");
    const eb = await b.wait((m) => m.t === "ended");
    ok("ended reaches both pads", !!ea && !!eb);

    a.close();
    b.close();
    host.close();
    await sleep(150);
  }

  // ============ TEST 6: no-room ============
  {
    const c = open();
    await c.ready();
    c.send({ t: "join", room: "ZZZZ", name: "x", clientId: "z" });
    const err = await c.wait((m) => m.t === "joinErr");
    eq("unknown room -> no-room", err && err.reason, "no-room");
    c.close();
  }
} catch (e) {
  failures.push("harness: " + ((e && e.stack) || e));
  console.error(e);
} finally {
  if (relay) { try { relay.kill(); } catch {} }
}

const summary = { checks, failures };
console.log("\n" + (failures.length ? "\u2717 FAIL" : "\u2713 PASS") + " — " + (checks - failures.length) + "/" + checks + " assertions");
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log("  - " + f);
}
process.exit(failures.length ? 1 : 0);
