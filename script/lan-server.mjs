// LAN relay server for Animal Cup local-versus / 局域网联机.
//
// Topology (owner-approved): ONE big screen runs the actual match; each phone
// is a wireless gamepad. This server is a thin JSON relay over WebSocket —
// it never touches game state, it just routes pad input to the host screen
// and start/roster signals back to the pads. Runs on the host machine's LAN
// only (plain ws://, no auth — see note below), alongside `next dev`.
//
// SEAT MODEL (4v4, see docs/multiplayer-4v4-design.md §3.1 / §3.5)
//   Each side fields a fixed 7-player squad: jersey #1 is the goalkeeper and is
//   PERMANENTLY AI, #2..#7 are bindable. At most HUMANS_PER_SIDE phones may hold
//   a seat on a side; every unfilled seat is played by AI. So 4 humans + 3 AI per
//   side, 8 humans + 6 AI on the pitch at most.
//
//   A seat is (side, number) and it is assigned BY THIS SERVER — a phone may ask
//   for a side, never for a number. Once the host sends `lock` (kickoff) the
//   assignment is frozen: further `pick`/re-join requests are refused, which is
//   what makes "scan, get a player, keep that player" true.
//
//   `slot` (0 = red, 1 = blue) is still emitted for the legacy two-gamepad host
//   bridge and lobby; `side`/`number`/`playerId` are the new, complete binding.
//
// SECURITY: intentionally unauthenticated and bound to 0.0.0.0 so phones on
// the same Wi-Fi can reach it. It carries only gamepad input + display names —
// no secrets, no file/system access. Do NOT expose this port to the internet;
// it is a same-LAN convenience server, not a public service.
import { WebSocketServer } from "ws";
import os from "node:os";

const PORT = Number(process.env.LAN_PORT || 13001);
const SLOTS = 2; // legacy slot count = number of sides (kept for the old 2-way bridge)
const HOST_GRACE_MS = 25000; // keep room alive across lobby -> match navigation

// --- seat model ------------------------------------------------------------
const SIDES = ["red", "blue"];
const SIDE_SLOT = { red: 0, blue: 1 }; // legacy `slot` value per side
const SQUAD = 7; // players per side in the engine (fixed)
const GK_NUMBER = 1; // goalkeeper — never bindable, always AI
const BINDABLE = [2, 3, 4, 5, 6, 7]; // outfield jersey numbers
const HUMANS_PER_SIDE = 4; // owner's cap: at most 4 phones per side
const SEAT_HOLD_MS = 20000; // keep a dropped phone's seat this long

// Jersey number -> engine player id (see standalone-match.js createGame:
// red GK id 0 then ids 1..6, blue GK id SQUAD then ids SQUAD+1..SQUAD+6).
function playerIdFor(side, number) {
  return side === "blue" ? SQUAD + number - 1 : number - 1;
}

// Human label colours. The engine ships USER_COLORS with only FIVE entries
// (settings("USER_COLORS")) because its prototype supported 5 local players; the
// first five here are those exact values so 1v1/2v2 labels match the engine's
// own control indicator, then three more high-contrast hues cover 4v4.
const PAD_COLORS = [
  0xffc233, // 1 amber
  0xfe653e, // 2 orange-red
  0xbb00ff, // 3 purple
  0x44ff00, // 4 green
  0xff7cbb, // 5 pink
  0x00e0ff, // 6 cyan   (added)
  0x4da3ff, // 7 blue   (added)
  0xd4ff3f, // 8 lime   (owner-visible only; added)
];

// lanIP: best-guess LAN IPv4 for the phone to reach — what the QR encodes.
//
// Heuristic (avoids the common trap of advertising a VM/virtual-switch address
// the phone can't route to): weight real Wi-Fi/home ranges above the
// 172.16/12 block, which Docker / Hyper-V / WSL virtually always occupy.
//   - 192.168.*            -> weight 3  (home Wi-Fi, strongest)
//   - 10.*                 -> weight 2  (private)
//   - 172.16-31.*          -> weight 1  (Docker/VM — weakest)
//   - anything else        -> skipped
// Higher weight wins; ties keep interface iteration order. Set LAN_IP to force
// a specific address (handy if auto-detection ever picks a wrong adapter).
function lanIP() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const a = ni.address;
      let w = 0;
      if (/^192\.168\./.test(a)) w = 3;
      else if (/^10\./.test(a)) w = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) w = 1;
      if (w) cands.push({ ip: a, w });
    }
  }
  if (!cands.length) return "127.0.0.1";
  cands.sort((x, y) => y.w - x.w); // highest weight first (stable within weight)
  return cands[0].ip;
}

// rooms: code -> { host, pads:Map<padId,pad>, held:Map<clientId,pad>, graceTimer, locked }
const rooms = new Map();
let padSeq = 1;

function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 ambiguity
  let c = "";
  do {
    c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join("");
  } while (rooms.get(c));
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

// --- seat allocation -------------------------------------------------------

function padsOfSide(room, side) {
  return [...room.pads.values()].filter((p) => p.side === side);
}

/**
 * Smallest bindable jersey number still free on `side`, or -1 when there is no
 * seat left. "No seat" means EITHER the per-side human cap is reached OR every
 * bindable number is taken — the two are different reasons but the same answer,
 * and checking only the numbers would let a 5th phone onto a 4-human side.
 */
function freeNumber(room, side) {
  const pads = padsOfSide(room, side);
  if (pads.length >= HUMANS_PER_SIDE) return -1; // per-side human cap
  const used = new Set(pads.map((p) => p.number));
  for (const n of BINDABLE) if (n !== GK_NUMBER && !used.has(n)) return n;
  return -1; // every bindable number taken
}

/** Lowest colour index not currently in use, so two humans never share a label colour. */
function freeColor(room) {
  const used = new Set([...room.pads.values()].map((p) => p.color));
  for (const c of PAD_COLORS) if (!used.has(c)) return c;
  return PAD_COLORS[room.pads.size % PAD_COLORS.length];
}

/**
 * Pick the side for a joining phone.
 *   - An EXPLICIT request is honoured strictly: if that side is full we refuse
 *     (`side-full`) rather than quietly dumping the player on the other team —
 *     for a 4-a-side game "I want blue" must never silently become red.
 *   - No request  -> balance: take the side with fewer humans (ties -> red),
 *     which reproduces the old "first pad = P1/red, second = P2/blue" behaviour.
 */
function pickSide(room, requested) {
  const free = (s) => freeNumber(room, s) >= 0;
  if (SIDES.includes(requested)) return free(requested) ? requested : null;
  const open = SIDES.filter(free);
  if (!open.length) return null;
  open.sort((a, b) => padsOfSide(room, a).length - padsOfSide(room, b).length);
  return open[0];
}

function counts(room) {
  const out = {};
  for (const side of SIDES) {
    const humans = padsOfSide(room, side).length;
    out[side] = { humans, ai: SQUAD - humans };
  }
  return out;
}

function roster(room) {
  return [...room.pads.entries()].map(([padId, p]) => ({
    padId,
    name: p.name,
    // legacy fields (lobby slot cards + old 2-way host bridge read these)
    slot: p.slot,
    ready: p.ready,
    // seat binding
    side: p.side,
    number: p.number,
    playerId: p.playerId,
    color: p.color,
  }));
}

function pushRoster(room) {
  send(room.host, { t: "roster", pads: roster(room), counts: counts(room), locked: !!room.locked });
  pushOccupancy(room);
}

/**
 * The phone-side picker needs to grey out numbers its own side already wears,
 * and pads only ever hear about themselves otherwise. So every roster change
 * also pushes a compact per-side occupancy to each pad — numbers only, no names
 * of other players, and `me` so a pad can render its own bind badge.
 */
function occupancy(room) {
  const out = {};
  for (const side of SIDES) out[side] = padsOfSide(room, side).map((p) => p.number).sort((a, b) => a - b);
  return out;
}

function pushOccupancy(room) {
  const occ = occupancy(room);
  for (const pad of room.pads.values()) {
    send(pad.ws, {
      t: "occupancy",
      locked: !!room.locked,
      red: occ.red,
      blue: occ.blue,
      bindable: BINDABLE,
      gkNumber: GK_NUMBER,
      me: { padId: pad.padId, ...bindingOf(pad) },
    });
  }
}

function bindingOf(pad) {
  return {
    side: pad.side,
    slot: pad.slot,
    number: pad.number,
    playerId: pad.playerId,
    color: pad.color,
    name: pad.name,
  };
}

/** Tell a host-side pick: the pad learns its new seat, everyone re-renders. */
function seatPad(room, pad, number) {
  pad.number = number;
  pad.playerId = playerIdFor(pad.side, number);
  send(pad.ws, { t: "bind", ...bindingOf(pad) });
}

function bindNewSeat(room, pad, requestedSide) {
  const side = pickSide(room, requestedSide);
  if (!side) return null;
  const number = freeNumber(room, side);
  if (number < 0) return null;
  pad.side = side;
  pad.slot = SIDE_SLOT[side];
  pad.number = number;
  pad.playerId = playerIdFor(side, number);
  pad.color = freeColor(room);
  return pad;
}

/** Drop a pad's seat for good (its socket is gone past the hold window). */
function releaseSeat(room, pad) {
  if (pad.heldTimer) { clearTimeout(pad.heldTimer); pad.heldTimer = null; }
  if (room.pads.get(pad.padId) === pad) room.pads.delete(pad.padId);
  if (pad.clientId && room.held.get(pad.clientId) === pad) room.held.delete(pad.clientId);
}

/** Park a dropped pad's seat so the same device can reclaim its player later. */
function holdSeat(room, pad) {
  // Only a device we can recognise again is worth reserving a seat for.
  if (!pad.clientId) { releaseSeat(room, pad); return; }
  // keep it in `pads` (so the number stays taken and the roster still shows the
  // seat) but flag it detached: `ready:false` means "reserved, no live phone",
  // which is how the host bridge knows to hand that player back to the AI.
  pad.ws = null;
  pad.ready = false;
  pad.heldTimer = setTimeout(() => { releaseSeat(room, pad); pushRoster(room); }, SEAT_HOLD_MS);
  room.held.set(pad.clientId, pad);
}

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("connection", (ws) => {
  // Connection identity is established by the first message (hello/host or
  // hello/pad). Until then the socket is anonymous.
  ws.__role = null; // "host" | "pad"
  ws.__room = null;
  ws.__padId = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    // --- big screen registers / re-attaches as the room host ---
    if (msg.t === "host") {
      let code = (msg.room || "").toUpperCase();
      let room = code && rooms.get(code);
      if (room) {
        // re-attach (lobby -> match navigation): cancel the grace timer
        if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
        const old = room.host;
        room.host = ws;
        if (old && old !== ws) try { old.close(4000, "host-replaced"); } catch {}
      } else {
        code = code || makeCode();
        room = { host: ws, pads: new Map(), held: new Map(), graceTimer: null, locked: false };
        rooms.set(code, room);
      }
      ws.__role = "host";
      ws.__room = code;
      send(ws, {
        t: "hosted",
        room: code,
        ip: lanIP(),
        port: 13000,
        // legacy
        slots: SLOTS,
        // seat model
        sides: SIDES,
        squad: SQUAD,
        bindable: BINDABLE,
        gkNumber: GK_NUMBER,
        humansPerSide: HUMANS_PER_SIDE,
      });
      pushRoster(room);
      return;
    }

    // --- phone joins a room as a gamepad ---
    if (msg.t === "join") {
      const code = (msg.room || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: "joinErr", reason: "no-room" }); return; }

      const clientId = String(msg.clientId || "").slice(0, 48) || null;
      const requestedSide = SIDES.includes(msg.side) ? msg.side : null;
      const name = String(msg.name || "").slice(0, 16) || "Pad";

      // 1) same device reconnecting -> reclaim the seat it already holds
      const held = clientId ? room.held.get(clientId) : null;
      if (held) {
        if (held.heldTimer) { clearTimeout(held.heldTimer); held.heldTimer = null; }
        room.held.delete(clientId);
        const old = held.ws;
        held.ws = ws;
        held.name = name;
        held.ready = true;
        if (old && old !== ws) try { old.close(4001, "pad-replaced"); } catch {}
        ws.__role = "pad";
        ws.__room = code;
        ws.__padId = held.padId;
        // `started` tells the pad app to jump straight to LIVE. A phone that drops
        // mid-match and re-enters never receives the host's kickoff `start`
        // (that broadcast only reaches pads connected AT kickoff), so without this
        // flag the reconnected pad stays in "ready" and gates ALL input off —
        // the reclaimed player can't move. `room.locked` is set true at kickoff
        // (host sends lock:true) and stays true for the whole match.
        send(ws, { t: "joined", padId: held.padId, room: code, resumed: true, started: !!room.locked, ...bindingOf(held) });
        pushRoster(room);
        if (room.locked) send(ws, { t: "start", slot: held.slot, side: held.side, number: held.number, playerId: held.playerId, info: null });
        return;
      }

      // 2) fresh seat
      const pad = {
        padId: padSeq++,
        ws,
        name,
        side: null,
        slot: -1,
        number: -1,
        playerId: -1,
        color: 0,
        ready: true,
        clientId,
        heldTimer: null,
      };
      if (!bindNewSeat(room, pad, requestedSide)) {
        // "side-full" = the side you asked for is full but a seat exists elsewhere
        // (so retrying without `side` would work); "full" = nothing left anywhere.
        const anyFree = SIDES.some((s) => freeNumber(room, s) >= 0);
        send(ws, { t: "joinErr", reason: anyFree ? "side-full" : "full" });
        return;
      }
      room.pads.set(pad.padId, pad);
      ws.__role = "pad";
      ws.__room = code;
      ws.__padId = pad.padId;
      send(ws, { t: "joined", padId: pad.padId, room: code, started: !!room.locked, ...bindingOf(pad) });
      pushRoster(room);
      // See the reconnect branch above: a pad joining while the match is already
      // locked (mid-match, or a late lobby join after kickoff) must get `start`
      // or it will sit in "ready" and never stream input.
      if (room.locked) send(ws, { t: "start", slot: pad.slot, side: pad.side, number: pad.number, playerId: pad.playerId, info: null });
      return;
    }

    const room = ws.__room && rooms.get(ws.__room);
    if (!room) return;

    // --- pad -> host: per-frame input state ---
    if (msg.t === "input" && ws.__role === "pad") {
      const pad = room.pads.get(ws.__padId);
      if (pad && pad.ws === ws) {
        send(room.host, {
          t: "input",
          // legacy
          slot: pad.slot,
          // seat binding, so the host bridge never has to guess
          side: pad.side,
          number: pad.number,
          playerId: pad.playerId,
          padId: ws.__padId,
          d: msg.d,
        });
      }
      return;
    }

    // --- host -> pads: start the match (carries match params for display) ---
    if (msg.t === "start" && ws.__role === "host") {
      for (const p of room.pads.values()) {
        if (!p.ws) continue;
        send(p.ws, { t: "start", slot: p.slot, side: p.side, number: p.number, playerId: p.playerId, info: msg.info || null });
      }
      return;
    }

    // --- host: freeze every seat (kickoff) — no more re-picks or re-binds ---
    // NOTE: a locked room still reserves a dropped phone's seat for SEAT_HOLD_MS;
    // that is exactly when the "keep your player" promise matters most.
    if (msg.t === "lock" && ws.__role === "host") {
      room.locked = msg.locked !== false;
      for (const p of room.pads.values()) send(p.ws, { t: "locked", locked: room.locked });
      pushRoster(room);
      return;
    }

    // --- phone picks its OWN number (the seat picker on /pad) ---------------
    // No swapping here. A phone must never be able to take a number another
    // phone is already wearing, so the only answer is `taken`; the picker greys
    // occupied numbers out, which makes this a race guard rather than a path.
    if (msg.t === "pick" && ws.__role === "pad") {
      const pad = room.pads.get(ws.__padId);
      if (!pad) return;
      if (room.locked) { send(ws, { t: "pickErr", padId: pad.padId, reason: "locked" }); return; }
      const number = Number(msg.number);
      if (!BINDABLE.includes(number)) { send(ws, { t: "pickErr", padId: pad.padId, reason: "bad-number" }); return; }
      if (number === pad.number) { send(ws, { t: "bind", ...bindingOf(pad) }); return; }
      if (padsOfSide(room, pad.side).some((p) => p !== pad && p.number === number)) {
        send(ws, { t: "pickErr", padId: pad.padId, reason: "taken" });
        return;
      }
      seatPad(room, pad, number);
      pushRoster(room);
      return;
    }

    // --- host: assign a specific number to a pad (lobby-only convenience) ---
    if (msg.t === "pick" && ws.__role === "host") {
      const pad = room.pads.get(msg.padId);
      if (!pad) return;
      if (room.locked) { send(ws, { t: "pickErr", padId: msg.padId, reason: "locked" }); return; }
      const number = Number(msg.number);
      if (!BINDABLE.includes(number)) { send(ws, { t: "pickErr", padId: msg.padId, reason: "bad-number" }); return; }
      const other = padsOfSide(room, pad.side).find((p) => p !== pad && p.number === number);
      if (other) {
        // swap: the other phone takes over the number we're leaving
        seatPad(room, other, pad.number);
      }
      seatPad(room, pad, number);
      pushRoster(room);
      return;
    }

    // --- host moves a pad to the other side (lobby-only) ---
    // A side change is just "release the seat, take the smallest free seat on the
    // other side" — there is no slot to swap any more, `slot` is derived from side.
    if (msg.t === "assign" && ws.__role === "host") {
      const pad = room.pads.get(msg.padId);
      if (!pad || room.locked) return;
      const want = SIDES.includes(msg.side) ? msg.side : SIDES[msg.slot];
      if (!want || want === pad.side) return;
      const from = pad.side;
      const fromNumber = pad.number;
      pad.side = want;
      pad.slot = SIDE_SLOT[want];
      pad.number = -1; // our own old number must not block the pick on the new side
      const n = freeNumber(room, want);
      if (n < 0) {
        pad.side = from;
        pad.slot = SIDE_SLOT[from];
        pad.number = fromNumber;
        pad.playerId = playerIdFor(from, fromNumber);
        send(ws, { t: "pickErr", padId: pad.padId, reason: "side-full" });
        return;
      }
      pad.color = freeColor(room); // pad.color is still the old one, so it won't be reused
      seatPad(room, pad, n);
      send(pad.ws, { t: "slot", ...bindingOf(pad) });
      pushRoster(room);
      return;
    }

    // --- host signals match ended -> pads return to standby ---
    if (msg.t === "ended" && ws.__role === "host") {
      room.locked = false;
      for (const p of room.pads.values()) send(p.ws, { t: "ended" });
      pushRoster(room);
      return;
    }

    // --- host -> a single pad: live camera feed (Req #3) ----------------------
    // `data` is a JPEG data URL cropped around that pad's own player. Routed to
    // the specific pad; dropped silently if the phone has since disconnected.
    if (msg.t === "view" && ws.__role === "host") {
      const pad = room.pads.get(msg.padId);
      if (pad && pad.ws && typeof msg.data === "string") {
        send(pad.ws, { t: "view", data: msg.data });
      }
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.__room && rooms.get(ws.__room);
    if (!room) return;
    if (ws.__role === "pad") {
      const pad = room.pads.get(ws.__padId);
      if (pad && pad.ws === ws) { holdSeat(room, pad); pushRoster(room); }
    } else if (ws.__role === "host" && room.host === ws) {
      // host vanished — hold the room briefly so a lobby->match reload re-attaches,
      // then tear it down and disconnect the pads.
      room.graceTimer = setTimeout(() => {
        for (const p of room.pads.values()) { send(p.ws, { t: "closed" }); try { p.ws && p.ws.close(); } catch {} }
        rooms.delete(ws.__room);
      }, HOST_GRACE_MS);
    }
  });
});

const ip = lanIP();
console.log(`[lan] relay listening on ws://${ip}:${PORT}  (phones join via http://${ip}:13000/pad)`);
console.log(`[lan] seat model: ${SIDES.join("/")} × ${HUMANS_PER_SIDE} humans, squad ${SQUAD} (GK #${GK_NUMBER} always AI), bindable #${BINDABLE.join("/")}`);

export { playerIdFor, BINDABLE, HUMANS_PER_SIDE, SQUAD, PAD_COLORS };
