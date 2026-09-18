"use client";

import { useEffect, useRef, useState } from "react";
import { createOnlineClient } from "../online/onlineClient";
import { encodeMatchFrame, RemoteFrameBuffer } from "../online/frameCodec";

const EVENT_NAMES = new Set(["ab-kickoff-played", "ab-goal"]);

function tokenKey(role, room) {
  return `animalCupOnline:${role}:${room}`;
}

function inputFor(slot) {
  const key = slot === 1 ? "__touchInput2" : "__touchInput";
  return (window[key] = window[key] || {
    active: false,
    vx: 0,
    vy: 0,
    shoot: false,
    sprint: false,
    pass: false,
    lob: false,
    switchPlayer: false,
    tackle: false,
  });
}

function clearInput(slot) {
  const value = inputFor(slot);
  value.active = false;
  value.vx = 0;
  value.vy = 0;
  value.shoot = false;
  value.sprint = false;
  value.pass = false;
  value.lob = false;
  value.switchPlayer = false;
  value.tackle = false;
}

function applyInput(slot, data) {
  const value = inputFor(slot);
  value.active = true;
  value.vx = Number(data.vx) || 0;
  value.vy = Number(data.vy) || 0;
  value.shoot = !!data.shoot;
  value.sprint = !!data.sprint;
  if (data.pass) value.pass = true;
  if (data.lob) value.lob = true;
  if (data.switchPlayer) value.switchPlayer = true;
  if (data.tackle) value.tackle = true;
}

function installKeyboard(state) {
  const held = new Set();
  const mapped = new Set([
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "KeyA", "KeyD", "KeyW", "KeyS", "KeyQ", "ShiftLeft", "ShiftRight",
  ]);
  const updateAxis = () => {
    let x = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
    let y = (held.has("ArrowDown") ? 1 : 0) - (held.has("ArrowUp") ? 1 : 0);
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    state.vx = x;
    state.vy = y;
  };
  const down = (event) => {
    if (!mapped.has(event.code)) return;
    event.preventDefault();
    held.add(event.code);
    updateAxis();
    if (event.code === "KeyD") state.shoot = true;
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") state.sprint = true;
    if (!event.repeat && event.code === "KeyA") state.pass = true;
    if (!event.repeat && event.code === "KeyW") state.lob = true;
    if (!event.repeat && event.code === "KeyS") state.tackle = true;
    if (!event.repeat && event.code === "KeyQ") state.switchPlayer = true;
  };
  const up = (event) => {
    if (!mapped.has(event.code)) return;
    event.preventDefault();
    held.delete(event.code);
    updateAxis();
    if (event.code === "KeyD") state.shoot = false;
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") state.sprint = false;
  };
  const reset = () => {
    held.clear();
    state.vx = 0;
    state.vy = 0;
    state.shoot = false;
    state.sprint = false;
    state.pass = false;
    state.lob = false;
    state.switchPlayer = false;
    state.tackle = false;
  };
  const visibility = () => { if (document.hidden) reset(); };
  window.addEventListener("keydown", down, { passive: false });
  window.addEventListener("keyup", up, { passive: false });
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", visibility);
    reset();
  };
}

function copyVector(target, source) {
  if (!target || !source) return;
  target.x = source.x;
  target.y = source.y;
  if ("z" in target && "z" in source) target.z = source.z;
}

function syncPitchView(game, frame) {
  const pitch = game && game.pitch;
  if (!pitch) return;
  pitch.redTeam.score = frame.redTeam.score;
  pitch.blueTeam.score = frame.blueTeam.score;
  pitch.secondHalf = frame.secondHalf;
  const halfMinute = frame.secondHalf ? Math.max(0, frame.matchTime - 2700) : frame.matchTime;
  pitch.time = pitch.halfTime * Math.max(0, Math.min(1, halfMinute / 2700));
  copyVector(pitch.ball.position, frame.ball.position);
  copyVector(pitch.ball.velocity, frame.ball.velocity);
}

function installRemoteRenderer(buffer) {
  const game = window.__matchGame;
  const mode = game && game.states && game.states.current;
  if (!game || !mode || mode.__onlineRemoteInstalled) return null;
  mode.__onlineRemoteInstalled = true;
  const messages = window.require("messages");
  const originalUpdate = mode.update;
  const originalRender = mode.render;
  if (game.stadium.netManualUpdate && game.stadium.netManualUpdate.open) game.stadium.netManualUpdate.open();

  mode.update = function remoteUpdate(currentGame, elapsed) {
    currentGame.stadium.update(elapsed);
  };
  mode.render = function remoteRender(currentGame, elapsed) {
    if (currentGame.stadium.paused) return;
    const frame = buffer.read();
    if (frame) {
      const originalZoom = frame.camera.zoom;
      frame.camera.zoom = Math.max(0.2, Math.min(3, originalZoom * (window.__matchZoomMul || 1)));
      try {
        syncPitchView(currentGame, frame);
        window.__onlineRemoteFrame = frame;
        messages.frame.send(currentGame.stadium, frame);
      } finally {
        frame.camera.zoom = originalZoom;
      }
    }
    currentGame.stadium.render(elapsed);
  };

  return () => {
    mode.update = originalUpdate;
    mode.render = originalRender;
    delete mode.__onlineRemoteInstalled;
  };
}

export default function OnlineMatchBridge() {
  const clientRef = useRef(null);
  const bufferRef = useRef(null);
  const pendingFrameRef = useRef(null);
  const lastInputAt = useRef([0, 0]);
  const [connection, setConnection] = useState("connecting");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = (params.get("online") || "").toUpperCase();
    if (!room) return undefined;
    const role = params.get("onlineRole") === "host" ? "host" : "screen";
    const mode = params.get("onlineMode") === "controllers" ? "controllers" : "direct";
    const roleKey = role === "host" ? "host" : "screen";
    let resumeToken = "";
    try { resumeToken = sessionStorage.getItem(tokenKey(roleKey, room)) || ""; } catch {}

    const directInput = { vx: 0, vy: 0, shoot: false, sprint: false, pass: false, lob: false, switchPlayer: false, tackle: false };
    let sequence = 0;
    let remoteCleanup = null;
    let frameTimer = null;
    let statsTimer = null;
    let inputTimer = null;
    let timeoutTimer = null;
    let removeKeyboard = null;
    let startedHandler = null;
    const streamEpoch = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    const eventHandlers = [];

    function startRemoteRenderer() {
      if (role !== "screen" || bufferRef.current) return;
      const count = window.__matchGame?.pitch?.redTeam?.allPlayers?.length || 7;
      bufferRef.current = new RemoteFrameBuffer(count);
      remoteCleanup = installRemoteRenderer(bufferRef.current);
      if (pendingFrameRef.current) {
        bufferRef.current.push(pendingFrameRef.current);
        pendingFrameRef.current = null;
      }
    }

    function startHostLoops(client) {
      if (role !== "host" || frameTimer) return;
      let lastFrameIndex = -1;
      frameTimer = setInterval(() => {
        const game = window.__matchGame;
        const stream = game && game.stream;
        if (!stream || stream.index <= 0 || stream.index === lastFrameIndex) return;
        const frame = stream.getByOffset(0);
        if (!frame) return;
        lastFrameIndex = stream.index;
        try { client.sendBinary(encodeMatchFrame(frame, stream.index)); } catch (error) {
          console.warn("[online] frame encode failed", error);
        }
      }, 33);
      statsTimer = setInterval(() => {
        if (window.__matchStats) client.send({ t: "stats", stats: window.__matchStats });
      }, 500);
      timeoutTimer = setInterval(() => {
        const now = performance.now();
        for (const slot of [0, 1]) {
          if (lastInputAt.current[slot] && now - lastInputAt.current[slot] > 350) {
            clearInput(slot);
            lastInputAt.current[slot] = 0;
          }
        }
      }, 100);
    }

    function triggerRematch() {
      if (role === "host") {
        clientRef.current?.send({ t: "rematch" });
        setTimeout(() => window.location.reload(), 100);
      } else {
        clientRef.current?.send({ t: "rematchRequest" });
      }
    }
    window.__onlineRematch = triggerRematch;

    const client = createOnlineClient({
      room,
      hello: () => ({ t: "hello", role, token: resumeToken }),
      onStatus(next) {
        setConnection(next === "open" ? "online" : next);
      },
      onBinary(data) {
        if (role !== "screen") return;
        if (bufferRef.current) bufferRef.current.push(data);
        else pendingFrameRef.current = data;
      },
      onMessage(msg) {
        if (msg.t === "joinErr") {
          client.close();
          setConnection("error");
          return;
        }
        if (msg.t === "hosted" || msg.t === "joined") {
          if (msg.token) {
            resumeToken = msg.token;
            try { sessionStorage.setItem(tokenKey(roleKey, room), msg.token); } catch {}
          }
          setConnection("online");
          if (role === "host") {
            client.send({ t: "stream", epoch: streamEpoch });
            startHostLoops(clientRef.current || client);
          }
          return;
        }
        if (msg.t === "stream" && role === "screen") {
          pendingFrameRef.current = null;
          bufferRef.current?.reset();
          return;
        }
        if (msg.t === "closed") {
          client.close();
          setConnection("closed");
          return;
        }
        if (msg.t === "input" && role === "host") {
          if (mode === "direct" && msg.slot !== 1) return;
          applyInput(msg.slot, msg.d || {});
          lastInputAt.current[msg.slot] = performance.now();
          return;
        }
        if (msg.t === "roster" && role === "host") {
          const nextRoster = msg.roster || { screen: false, pads: [] };
          if (mode === "direct" && !nextRoster.screen) clearInput(1);
          if (mode === "controllers") {
            for (const slot of [0, 1]) {
              if (!nextRoster.pads.some((pad) => pad.slot === slot)) clearInput(slot);
            }
          }
          return;
        }
        if (msg.t === "stats" && role === "screen" && msg.stats) {
          window.__matchStats = msg.stats;
          return;
        }
        if (msg.t === "event" && role === "screen" && EVENT_NAMES.has(msg.name)) {
          window.dispatchEvent(new CustomEvent(msg.name, { detail: msg.detail || {} }));
          return;
        }
        if (msg.t === "ended" && role === "screen") {
          if (msg.stats) window.__matchStats = msg.stats;
          window.dispatchEvent(new CustomEvent("ab-match-ended", { detail: msg.detail || {} }));
          return;
        }
        if (msg.t === "rematch") {
          setTimeout(() => window.location.reload(), 80);
          return;
        }
        if (msg.t === "rematchRequest" && role === "host") triggerRematch();
      },
    });
    clientRef.current = client;

    if (role === "screen") {
      startedHandler = startRemoteRenderer;
      window.addEventListener("ab-match-started", startedHandler);
      if (window.__matchGame?.states?.current) startRemoteRenderer();
      if (mode === "direct") {
        removeKeyboard = installKeyboard(directInput);
        inputTimer = setInterval(() => {
          const touch = inputFor(0);
          const touchMoving = touch.active && Math.hypot(touch.vx, touch.vy) > 0.01;
          const packet = {
            vx: touchMoving ? touch.vx : directInput.vx,
            vy: touchMoving ? touch.vy : directInput.vy,
            shoot: !!(touch.shoot || directInput.shoot),
            sprint: !!(touch.sprint || directInput.sprint),
            pass: !!(touch.pass || directInput.pass),
            lob: !!(touch.lob || directInput.lob),
            switchPlayer: !!(touch.switchPlayer || directInput.switchPlayer),
            tackle: !!(touch.tackle || directInput.tackle),
          };
          client.send({ t: "input", seq: ++sequence, d: packet });
          touch.pass = touch.lob = touch.switchPlayer = touch.tackle = false;
          directInput.pass = directInput.lob = directInput.switchPlayer = directInput.tackle = false;
        }, 33);
      }
    } else {
      startedHandler = () => startHostLoops(client);
      window.addEventListener("ab-match-started", startedHandler);
      if (window.__matchGame?.states?.current) startHostLoops(client);
      for (const name of EVENT_NAMES) {
        const handler = (event) => client.send({ t: "event", name, detail: event.detail || {} });
        eventHandlers.push([name, handler]);
        window.addEventListener(name, handler);
      }
      const ended = (event) => client.send({
        t: "ended",
        detail: event.detail || {},
        stats: window.__matchStats || null,
      });
      eventHandlers.push(["ab-match-ended", ended]);
      window.addEventListener("ab-match-ended", ended);
    }

    return () => {
      client.close();
      clearInterval(frameTimer);
      clearInterval(statsTimer);
      clearInterval(inputTimer);
      clearInterval(timeoutTimer);
      if (removeKeyboard) removeKeyboard();
      if (remoteCleanup) remoteCleanup();
      if (startedHandler) window.removeEventListener("ab-match-started", startedHandler);
      for (const [name, handler] of eventHandlers) window.removeEventListener(name, handler);
      delete window.__onlineRematch;
    };
  }, []);

  return null;
}
