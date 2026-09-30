import http from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  ONLINE_RECONNECT_GRACE_MS,
  ONLINE_ROOM_ALPHABET,
  ONLINE_ROOM_CODE_LENGTH,
  ONLINE_ROOM_TTL_MS,
  canStartOnlineRoom,
  normalizeOnlineConfig,
  normalizeRoomCode,
  sanitizeOnlineInput,
} from "../online/shared.js";

const PORT = Number(process.env.ONLINE_PORT || 13002);
const MAX_JSON_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_ROOM_SOCKETS = 8;
const MAX_MESSAGES_PER_SECOND = 90;
const rooms = new Map();
const createRates = new Map();
const connectRates = new Map();

function token() {
  return randomBytes(24).toString("base64url");
}

function roomCode() {
  let code = "";
  do {
    code = Array.from(
      { length: ONLINE_ROOM_CODE_LENGTH },
      () => ONLINE_ROOM_ALPHABET[randomBytes(1)[0] % ONLINE_ROOM_ALPHABET.length],
    ).join("");
  } while (rooms.has(code));
  return code;
}

function allowedOrigin(req) {
  const configured = String(process.env.ONLINE_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured.length) return true;
  return configured.includes(req.headers.origin || "");
}

function corsHeaders(req) {
  const origin = req.headers.origin || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    Vary: "Origin",
  };
}

function json(res, req, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("body-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad-json"));
      }
    });
    req.on("error", reject);
  });
}

function createRoom(config) {
  const code = roomCode();
  const hostToken = token();
  const now = Date.now();
  rooms.set(code, {
    code,
    config: normalizeOnlineConfig(config),
    hostToken,
    createdAt: now,
    expiresAt: now + ONLINE_ROOM_TTL_MS,
    lastActiveAt: now,
    started: false,
    hostReservedUntil: 0,
    sockets: new Set(),
    screenToken: null,
    screenReservedUntil: 0,
    padInviteTokens: [token(), token()],
    padTokens: [null, null],
    padReservedUntil: [0, 0],
  });
  return { code, hostToken };
}

function allowRate(store, key, limit) {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    store.set(key, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

const server = http.createServer(async (req, res) => {
  if (!allowedOrigin(req)) return json(res, req, 403, { ok: false, reason: "origin" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, req, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/create") {
    if (!allowRate(createRates, req.socket.remoteAddress || "local", 30)) {
      return json(res, req, 429, { ok: false, reason: "rate-limit" });
    }
    try {
      const body = await readJson(req);
      const created = createRoom(body && body.config);
      return json(res, req, 201, {
        ok: true,
        room: created.code,
        hostToken: created.hostToken,
        padInvites: rooms.get(created.code).padInviteTokens,
        config: rooms.get(created.code).config,
      });
    } catch (error) {
      return json(res, req, 400, { ok: false, reason: error.message || "invalid" });
    }
  }
  return json(res, req, 404, { ok: false, reason: "not-found" });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

function safeSend(ws, value, binary = false) {
  if (!ws || ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    if (!binary) try { ws.close(1013, "slow-client"); } catch {}
    return false;
  }
  try {
    ws.send(value, { binary });
    return true;
  } catch {
    return false;
  }
}

function sendJson(ws, value) {
  return safeSend(ws, JSON.stringify(value));
}

function active(room, role, slot = null) {
  return [...room.sockets].find(
    (socket) => socket.meta && socket.meta.role === role && (slot == null || socket.meta.slot === slot),
  );
}

function roster(room) {
  const pads = [];
  for (const socket of room.sockets) {
    if (socket.meta && socket.meta.role === "pad") pads.push({ slot: socket.meta.slot });
  }
  pads.sort((a, b) => a.slot - b.slot);
  return { host: !!active(room, "host"), screen: !!active(room, "screen"), pads };
}

function broadcast(room, value, predicate = () => true) {
  const text = JSON.stringify(value);
  for (const socket of room.sockets) if (socket.meta && predicate(socket)) safeSend(socket, text);
}

function pushRoster(room) {
  broadcast(room, { t: "roster", roster: roster(room) });
}

function replaceSocket(room, role, slot, current) {
  const old = active(room, role, slot);
  if (old && old !== current) {
    try { old.close(4000, "replaced"); } catch {}
  }
}

function acceptHello(ws, room, msg) {
  const role = msg.role;
  const resumeToken = String(msg.token || "");
  const now = Date.now();

  if (role === "host") {
    if (!resumeToken || resumeToken !== room.hostToken) return { error: "host-token" };
    room.hostReservedUntil = 0;
    room.expiresAt = Math.max(room.expiresAt || 0, now + ONLINE_ROOM_TTL_MS);
    replaceSocket(room, "host", null, ws);
    ws.meta = { role: "host", token: resumeToken, lastSeq: -1 };
    return { token: resumeToken };
  }

  if (role === "screen") {
    const old = active(room, "screen");
    if (old && (!resumeToken || resumeToken !== room.screenToken)) return { error: "screen-full" };
    if (!old && room.screenToken && now < room.screenReservedUntil && resumeToken !== room.screenToken) {
      return { error: "screen-reserved" };
    }
    const nextToken = resumeToken && resumeToken === room.screenToken ? resumeToken : token();
    room.screenToken = nextToken;
    room.screenReservedUntil = 0;
    replaceSocket(room, "screen", null, ws);
    ws.meta = { role: "screen", token: nextToken, lastSeq: -1 };
    return { token: nextToken };
  }

  if (role === "pad" && room.config.mode === "controllers") {
    let slot = Number(msg.slot);
    if (slot !== 0 && slot !== 1) slot = active(room, "pad", 0) ? 1 : 0;
    const old = active(room, "pad", slot);
    const stored = room.padTokens[slot];
    const invited = String(msg.invite || "") === room.padInviteTokens[slot];
    if (old && (!resumeToken || resumeToken !== stored)) return { error: "slot-full" };
    if (!old && stored && now < room.padReservedUntil[slot] && resumeToken !== stored) {
      return { error: "slot-reserved" };
    }
    if ((!resumeToken || resumeToken !== stored) && !invited) return { error: "slot-invite" };
    const nextToken = resumeToken && resumeToken === stored ? resumeToken : token();
    room.padTokens[slot] = nextToken;
    room.padReservedUntil[slot] = 0;
    replaceSocket(room, "pad", slot, ws);
    ws.meta = { role: "pad", slot, token: nextToken, lastSeq: -1 };
    return { token: nextToken, slot };
  }

  return { error: "role" };
}

function hostSocket(room) {
  return active(room, "host");
}

function handleJson(ws, room, msg) {
  if (!ws.meta) {
    if (msg.t !== "hello") return ws.close(4001, "hello-required");
    const accepted = acceptHello(ws, room, msg);
    if (accepted.error) {
      sendJson(ws, { t: "joinErr", reason: accepted.error });
      return ws.close(4003, accepted.error);
    }
    room.lastActiveAt = Date.now();
    sendJson(ws, {
      t: ws.meta.role === "host" ? "hosted" : "joined",
      room: room.code,
      role: ws.meta.role,
      slot: ws.meta.slot,
      token: accepted.token,
      padInvites: ws.meta.role === "host"
        ? room.padInviteTokens
        : ws.meta.role === "screen" && room.config.mode === "controllers"
          ? [null, room.padInviteTokens[1]]
          : undefined,
      config: room.config,
      started: room.started,
      roster: roster(room),
    });
    pushRoster(room);
    return;
  }

  room.lastActiveAt = Date.now();
  const role = ws.meta.role;

  if (msg.t === "input" && (role === "screen" || role === "pad")) {
    if (role === "screen" && room.config.mode !== "direct") return;
    const seq = Number(msg.seq) || 0;
    if (seq <= ws.meta.lastSeq) return;
    ws.meta.lastSeq = seq;
    const slot = role === "screen" ? 1 : ws.meta.slot;
    sendJson(hostSocket(room), { t: "input", slot, seq, d: sanitizeOnlineInput(msg.d) });
    return;
  }

  if (msg.t === "rematchRequest" && role === "screen") {
    sendJson(hostSocket(room), { t: "rematchRequest" });
    return;
  }

  if (role !== "host") return;

  if (msg.t === "start") {
    const currentRoster = roster(room);
    if (!canStartOnlineRoom(room.config, currentRoster)) {
      sendJson(ws, { t: "startErr", reason: "not-ready" });
      return;
    }
    room.started = true;
    broadcast(room, { t: "start", config: room.config });
    return;
  }

  if (["event", "stats", "ended", "rematch", "stream"].includes(msg.t)) {
    if (msg.t === "ended") room.started = false;
    if (msg.t === "rematch") room.started = true;
    broadcast(room, msg, (socket) => socket !== ws);
  }
}

wss.on("connection", (ws, req, room) => {
  ws.meta = null;
  ws.isAlive = true;
  ws.rateAt = Date.now();
  ws.rateCount = 0;
  room.sockets.add(ws);
  const helloTimer = setTimeout(() => {
    if (!ws.meta) try { ws.close(4001, "hello-timeout"); } catch {}
  }, 10_000);

  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data, isBinary) => {
    const now = Date.now();
    if (now - ws.rateAt >= 1000) {
      ws.rateAt = now;
      ws.rateCount = 0;
    }
    ws.rateCount += 1;
    if (ws.rateCount > MAX_MESSAGES_PER_SECOND) return ws.close(4008, "rate-limit");
    if (isBinary) {
      if (data.byteLength > MAX_FRAME_BYTES) return ws.close(1009, "frame-too-large");
      if (ws.meta && ws.meta.role === "host") {
        for (const socket of room.sockets) {
          if (socket.meta && socket.meta.role === "screen") safeSend(socket, data, true);
        }
      }
      return;
    }
    if (data.byteLength > MAX_JSON_BYTES) return ws.close(1009, "message-too-large");
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    handleJson(ws, room, msg);
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    room.sockets.delete(ws);
    const now = Date.now();
    if (ws.meta && ws.meta.role === "host" && !active(room, "host")) {
      room.hostReservedUntil = now + ONLINE_RECONNECT_GRACE_MS;
    }
    if (ws.meta && ws.meta.role === "screen") room.screenReservedUntil = now + ONLINE_RECONNECT_GRACE_MS;
    if (ws.meta && ws.meta.role === "pad") room.padReservedUntil[ws.meta.slot] = now + ONLINE_RECONNECT_GRACE_MS;
    pushRoster(room);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!allowedOrigin(req)) return socket.destroy();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/connect") return socket.destroy();
  const code = normalizeRoomCode(url.searchParams.get("room"));
  const remote = req.socket.remoteAddress || "local";
  if (!allowRate(connectRates, `${remote}:${code}`, 60)) return socket.destroy();
  const room = rooms.get(code);
  if (!room) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        ws.send(JSON.stringify({ t: "joinErr", reason: "no-room" }), () => ws.close(4004, "no-room"));
      } catch {
        try { ws.close(4004, "no-room"); } catch {}
      }
    });
    return;
  }
  if (room.sockets.size >= MAX_ROOM_SOCKETS) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        ws.send(JSON.stringify({ t: "joinErr", reason: "room-busy" }), () => ws.close(4008, "room-busy"));
      } catch {
        try { ws.close(4008, "room-busy"); } catch {}
      }
    });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, room));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.hostReservedUntil && now >= room.hostReservedUntil && !active(room, "host")) {
      broadcast(room, { t: "closed", reason: "host-left" });
      for (const socket of room.sockets) try { socket.close(4004, "host-left"); } catch {}
      rooms.delete(code);
      continue;
    }
    if (now >= room.expiresAt || (!room.sockets.size && now - room.lastActiveAt > 60_000)) {
      for (const socket of room.sockets) try { socket.close(4004, "room-expired"); } catch {}
      rooms.delete(code);
      continue;
    }
    for (const socket of room.sockets) {
      if (!socket.isAlive) {
        try { socket.terminate(); } catch {}
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch {}
    }
  }
}, 15_000);
heartbeat.unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[online] public-room relay listening on http://0.0.0.0:${PORT}`);
});
