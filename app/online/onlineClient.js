"use client";

import { normalizeRoomCode } from "../../online/shared";

const EXPLICIT_SERVICE = process.env.NEXT_PUBLIC_ONLINE_SERVICE_URL || "";

export function onlineServiceUrl() {
  if (EXPLICIT_SERVICE) return EXPLICIT_SERVICE.replace(/\/$/, "");
  if (typeof window === "undefined") return "";
  const host = window.location.hostname || "127.0.0.1";
  const local = host === "localhost" || host === "127.0.0.1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (local) return `http://${host}:13002`;
  return window.location.origin;
}

function socketUrl(room) {
  const base = onlineServiceUrl();
  if (!base) return "";
  const url = new URL("/connect", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", normalizeRoomCode(room));
  return url.toString();
}

export async function createOnlineRoom(config) {
  const base = onlineServiceUrl();
  if (!base) throw new Error("online-service-missing");
  const response = await fetch(new URL("/create", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config }),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || !data || !data.ok) throw new Error((data && data.reason) || `create-${response.status}`);
  return data;
}

export function createOnlineClient({ room, hello, onMessage, onBinary, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let retryTimer = null;
  let helloFn = hello || null;

  function status(value, detail) {
    if (onStatus) onStatus(value, detail);
  }

  function connect() {
    if (closed) return;
    const url = socketUrl(room);
    if (!url) return status("error", "online-service-missing");
    status("connecting");
    try {
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
    } catch (error) {
      status("error", error.message);
      schedule();
      return;
    }
    ws.onopen = () => {
      retry = 0;
      status("open");
      if (helloFn) send(helloFn());
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (onMessage) onMessage(msg);
        return;
      }
      if (onBinary) onBinary(event.data);
    };
    ws.onclose = (event) => {
      const detail = event.reason || String(event.code);
      const terminal = [4000, 4001, 4003, 4004, 4008].includes(event.code);
      status(event.code === 4000 ? "closed" : terminal ? "error" : "closed", detail);
      if (terminal) {
        closed = true;
        clearTimeout(retryTimer);
        return;
      }
      if (!closed) schedule();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function schedule() {
    clearTimeout(retryTimer);
    retry = Math.min(retry + 1, 8);
    const delay = Math.min(5000, 350 * 2 ** Math.min(retry - 1, 4)) + Math.random() * 250;
    retryTimer = setTimeout(connect, delay);
  }

  function send(value) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  connect();

  return {
    send,
    sendBinary(value) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try { ws.send(value); return true; } catch { return false; }
    },
    setHello(fn) {
      helloFn = fn;
      if (ws && ws.readyState === WebSocket.OPEN) send(fn());
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      if (ws) {
        const current = ws;
        ws = null;
        current.onopen = null;
        current.onmessage = null;
        current.onclose = null;
        current.onerror = null;
        try { current.close(); } catch {}
      }
    },
    get ready() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
}
