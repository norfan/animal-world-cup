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

const MAX_JSON_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const MAX_ROOM_SOCKETS = 8;
const MAX_MESSAGES_PER_SECOND = 90;

function randomCode() {
  const bytes = new Uint8Array(ONLINE_ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ONLINE_ROOM_ALPHABET[value % ONLINE_ROOM_ALPHABET.length]).join("");
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    Vary: "Origin",
  };
}

function json(body, status = 200, origin = "*") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) },
  });
}

function originAllowed(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return !allowed.length || allowed.includes(request.headers.get("Origin") || "");
}

async function readSmallJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_JSON_BYTES) throw new Error("body-too-large");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new Error("body-too-large");
  return JSON.parse(text || "{}");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true }, 200, origin);
    if (!originAllowed(request, env)) return json({ ok: false, reason: "origin" }, 403, origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    if (request.method === "POST" && url.pathname === "/create") {
      if (env.CREATE_RATE_LIMITER) {
        const key = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "local";
        const limited = await env.CREATE_RATE_LIMITER.limit({ key });
        if (!limited.success) return json({ ok: false, reason: "rate-limit" }, 429, origin);
      }
      let body;
      try { body = await readSmallJson(request); } catch (error) {
        return json({ ok: false, reason: error.message || "bad-json" }, 400, origin);
      }
      const config = normalizeOnlineConfig(body && body.config);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const room = randomCode();
        const hostToken = randomToken();
        const padInvites = [randomToken(), randomToken()];
        const id = env.ONLINE_ROOMS.idFromName(room);
        const response = await env.ONLINE_ROOMS.get(id).fetch("https://room.internal/create", {
          method: "POST",
          body: JSON.stringify({ room, hostToken, padInvites, config }),
        });
        if (response.status === 201) return json({ ok: true, room, hostToken, padInvites, config }, 201, origin);
      }
      return json({ ok: false, reason: "create-collision" }, 503, origin);
    }

    if (request.method === "GET" && url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ ok: false, reason: "upgrade-required" }, 426, origin);
      }
      const room = normalizeRoomCode(url.searchParams.get("room"));
      if (room.length !== ONLINE_ROOM_CODE_LENGTH) return json({ ok: false, reason: "room" }, 400, origin);
      if (env.CONNECT_RATE_LIMITER) {
        const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "local";
        const limited = await env.CONNECT_RATE_LIMITER.limit({ key: `${ip}:${room}` });
        if (!limited.success) return json({ ok: false, reason: "rate-limit" }, 429, origin);
      }
      const id = env.ONLINE_ROOMS.idFromName(room);
      return env.ONLINE_ROOMS.get(id).fetch(request);
    }

    return json({ ok: false, reason: "not-found" }, 404, origin);
  },
};

export class OnlineRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") {
      if (await this.state.storage.get("room")) return new Response(null, { status: 409 });
      const body = await request.json();
      const now = Date.now();
      const record = {
        code: body.room,
        hostToken: body.hostToken,
        config: normalizeOnlineConfig(body.config),
        createdAt: now,
        expiresAt: now + ONLINE_ROOM_TTL_MS,
        started: false,
        hostReservedUntil: 0,
        screenToken: null,
        screenReservedUntil: 0,
        padInviteTokens: body.padInvites,
        padTokens: [null, null],
        padReservedUntil: [0, 0],
      };
      await this.state.storage.put("room", record);
      await this.scheduleAlarm(record);
      return new Response(null, { status: 201 });
    }

    const room = await this.state.storage.get("room");
    const socketCount = this.sockets().length;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    if (!room) {
      server.serializeAttachment({ role: "rejected", connectedAt: Date.now(), lastSeq: -1 });
      server.send(JSON.stringify({ t: "joinErr", reason: "no-room" }));
      server.close(4004, "no-room");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (socketCount >= MAX_ROOM_SOCKETS) {
      server.serializeAttachment({ role: "rejected", connectedAt: Date.now(), lastSeq: -1 });
      server.send(JSON.stringify({ t: "joinErr", reason: "room-busy" }));
      server.close(4008, "room-busy");
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ role: "pending", connectedAt: Date.now(), lastSeq: -1 });
    setTimeout(() => {
      if (this.attachment(server).role === "pending") {
        try { server.close(4001, "hello-timeout"); } catch {}
      }
    }, 10_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async scheduleAlarm(room) {
    const expiresAt = room.expiresAt || room.createdAt + ONLINE_ROOM_TTL_MS;
    const deadlines = [expiresAt];
    if (room.hostReservedUntil) deadlines.push(room.hostReservedUntil);
    await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  sockets() {
    return this.state.getWebSockets();
  }

  attachment(ws) {
    try { return ws.deserializeAttachment() || { role: "pending", lastSeq: -1 }; } catch {
      return { role: "pending", lastSeq: -1 };
    }
  }

  find(role, slot = null) {
    return this.sockets().find((ws) => {
      const item = this.attachment(ws);
      return item.role === role && (slot == null || item.slot === slot);
    });
  }

  send(ws, value, droppable = false) {
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!droppable) try { ws.close(1013, "slow-client"); } catch {}
      return;
    }
    try { ws.send(value); } catch {}
  }

  sendJson(ws, value) {
    this.send(ws, JSON.stringify(value));
  }

  broadcast(value, predicate = () => true) {
    const text = JSON.stringify(value);
    for (const ws of this.sockets()) {
      const item = this.attachment(ws);
      if (item.role === "pending" || item.role === "rejected") continue;
      if (predicate(ws, item)) this.send(ws, text);
    }
  }

  roster() {
    const pads = [];
    for (const ws of this.sockets()) {
      const item = this.attachment(ws);
      if (item.role === "pad") pads.push({ slot: item.slot });
    }
    pads.sort((a, b) => a.slot - b.slot);
    return { host: !!this.find("host"), screen: !!this.find("screen"), pads };
  }

  pushRoster() {
    this.broadcast({ t: "roster", roster: this.roster() });
  }

  replace(role, slot, current) {
    const old = this.find(role, slot);
    if (old && old !== current) try { old.close(4000, "replaced"); } catch {}
  }

  async acceptHello(ws, room, msg) {
    const role = msg.role;
    const supplied = String(msg.token || "");
    const now = Date.now();

    if (role === "host") {
      if (!supplied || supplied !== room.hostToken) return { error: "host-token" };
      room.hostReservedUntil = 0;
      room.expiresAt = Math.max(room.expiresAt || 0, now + ONLINE_ROOM_TTL_MS);
      this.replace("host", null, ws);
      return { attachment: { role: "host", token: supplied, lastSeq: -1 }, token: supplied };
    }

    if (role === "screen") {
      const old = this.find("screen");
      if (old && (!supplied || supplied !== room.screenToken)) return { error: "screen-full" };
      if (!old && room.screenToken && now < room.screenReservedUntil && supplied !== room.screenToken) {
        return { error: "screen-reserved" };
      }
      const nextToken = supplied && supplied === room.screenToken ? supplied : randomToken();
      room.screenToken = nextToken;
      room.screenReservedUntil = 0;
      this.replace("screen", null, ws);
      return { attachment: { role: "screen", token: nextToken, lastSeq: -1 }, token: nextToken };
    }

    if (role === "pad" && room.config.mode === "controllers") {
      let slot = Number(msg.slot);
      if (slot !== 0 && slot !== 1) slot = this.find("pad", 0) ? 1 : 0;
      const old = this.find("pad", slot);
      const stored = room.padTokens[slot];
      const invited = String(msg.invite || "") === room.padInviteTokens[slot];
      if (old && (!supplied || supplied !== stored)) return { error: "slot-full" };
      if (!old && stored && now < room.padReservedUntil[slot] && supplied !== stored) {
        return { error: "slot-reserved" };
      }
      if ((!supplied || supplied !== stored) && !invited) return { error: "slot-invite" };
      const nextToken = supplied && supplied === stored ? supplied : randomToken();
      room.padTokens[slot] = nextToken;
      room.padReservedUntil[slot] = 0;
      this.replace("pad", slot, ws);
      return { attachment: { role: "pad", slot, token: nextToken, lastSeq: -1 }, token: nextToken, slot };
    }

    return { error: "role" };
  }

  async webSocketMessage(ws, message) {
    const attachment = this.attachment(ws);
    const now = Date.now();
    if (!attachment.rateAt || now - attachment.rateAt >= 1000) {
      attachment.rateAt = now;
      attachment.rateCount = 0;
    }
    attachment.rateCount = (attachment.rateCount || 0) + 1;
    if (attachment.rateCount > MAX_MESSAGES_PER_SECOND) {
      return ws.close(4008, "rate-limit");
    }
    ws.serializeAttachment(attachment);
    if (typeof message !== "string") {
      if (attachment.role !== "host") return;
      if (message.byteLength > MAX_FRAME_BYTES) return ws.close(1009, "frame-too-large");
      for (const target of this.sockets()) {
        if (this.attachment(target).role === "screen") this.send(target, message, true);
      }
      return;
    }
    if (message.length > MAX_JSON_BYTES) return ws.close(1009, "message-too-large");
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const room = await this.state.storage.get("room");
    if (!room) return ws.close(4004, "room-expired");

    if (attachment.role === "pending") {
      if (msg.t !== "hello") return ws.close(4001, "hello-required");
      const accepted = await this.acceptHello(ws, room, msg);
      if (accepted.error) {
        this.sendJson(ws, { t: "joinErr", reason: accepted.error });
        return ws.close(4003, accepted.error);
      }
      ws.serializeAttachment({
        ...accepted.attachment,
        rateAt: attachment.rateAt,
        rateCount: attachment.rateCount,
      });
      await this.state.storage.put("room", room);
      await this.scheduleAlarm(room);
      this.sendJson(ws, {
        t: accepted.attachment.role === "host" ? "hosted" : "joined",
        room: room.code,
        role: accepted.attachment.role,
        slot: accepted.slot,
        token: accepted.token,
        padInvites: accepted.attachment.role === "host"
          ? room.padInviteTokens
          : accepted.attachment.role === "screen" && room.config.mode === "controllers"
            ? [null, room.padInviteTokens[1]]
            : undefined,
        config: room.config,
        started: room.started,
        roster: this.roster(),
      });
      this.pushRoster();
      return;
    }

    if (msg.t === "input" && (attachment.role === "screen" || attachment.role === "pad")) {
      if (attachment.role === "screen" && room.config.mode !== "direct") return;
      const seq = Number(msg.seq) || 0;
      if (seq <= attachment.lastSeq) return;
      attachment.lastSeq = seq;
      ws.serializeAttachment(attachment);
      const slot = attachment.role === "screen" ? 1 : attachment.slot;
      this.sendJson(this.find("host"), { t: "input", slot, seq, d: sanitizeOnlineInput(msg.d) });
      return;
    }

    if (msg.t === "rematchRequest" && attachment.role === "screen") {
      this.sendJson(this.find("host"), { t: "rematchRequest" });
      return;
    }

    if (attachment.role !== "host") return;
    if (msg.t === "start") {
      const currentRoster = this.roster();
      if (!canStartOnlineRoom(room.config, currentRoster)) {
        this.sendJson(ws, { t: "startErr", reason: "not-ready" });
        return;
      }
      room.started = true;
      await this.state.storage.put("room", room);
      this.broadcast({ t: "start", config: room.config });
      return;
    }
    if (["event", "stats", "ended", "rematch", "stream"].includes(msg.t)) {
      if (msg.t === "ended") {
        room.started = false;
        await this.state.storage.put("room", room);
      }
      if (msg.t === "rematch") {
        room.started = true;
        await this.state.storage.put("room", room);
      }
      this.broadcast(msg, (target) => target !== ws);
    }
  }

  async webSocketClose(ws) {
    const item = this.attachment(ws);
    const room = await this.state.storage.get("room");
    if (!room) return;
    const now = Date.now();
    if (item.role === "host") {
      const anotherHost = this.sockets().some((target) => target !== ws && this.attachment(target).role === "host");
      if (!anotherHost) room.hostReservedUntil = now + ONLINE_RECONNECT_GRACE_MS;
    }
    if (item.role === "screen") room.screenReservedUntil = now + ONLINE_RECONNECT_GRACE_MS;
    if (item.role === "pad") room.padReservedUntil[item.slot] = now + ONLINE_RECONNECT_GRACE_MS;
    await this.state.storage.put("room", room);
    await this.scheduleAlarm(room);
    this.pushRoster();
  }

  async webSocketError(ws) {
    try { ws.close(1011, "socket-error"); } catch {}
  }

  async alarm() {
    const room = await this.state.storage.get("room");
    if (!room) return;
    const now = Date.now();
    const expiresAt = room.expiresAt || room.createdAt + ONLINE_ROOM_TTL_MS;
    let reason = "";
    if (room.hostReservedUntil && now >= room.hostReservedUntil) {
      if (!this.find("host")) reason = "host-left";
      else room.hostReservedUntil = 0;
    }
    if (!reason && now >= expiresAt) reason = "room-expired";
    if (reason) {
      this.broadcast({ t: "closed", reason });
      for (const ws of this.sockets()) try { ws.close(4004, reason); } catch {}
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put("room", room);
    await this.scheduleAlarm(room);
  }
}
