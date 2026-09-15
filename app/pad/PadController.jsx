"use client";

// Phone-as-gamepad controller (局域网联机 / 本地对战). A phone opens
// http://<lan-ip>:13000/pad?room=XXXX (typically by scanning the lobby QR),
// joins the relay room, and from then on this screen IS a wireless gamepad:
// left analog stick = movement, right diamond = Lob/Pass/Tackle/Shoot, centre =
// hold-to-Sprint. Continuous state (stick + held buttons) streams at ~30Hz;
// one-shot taps fire an immediate frame so they're never dropped.
//
// It never renders the match — the big screen does. This keeps the phone light
// and avoids syncing the non-deterministic engine across devices.
import { useEffect, useRef, useState } from "react";
import { createLanClient } from "../lan/lanClient";
import { createOnlineClient } from "../online/onlineClient";

const SVG = (props) => (
  <svg viewBox="0 0 24 24" width={props.s || 30} height={props.s || 30} fill="none"
       stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
       aria-hidden>{props.children}</svg>
);
const PassIcon = () => <SVG><path d="M4 12h12" /><path d="M12 7l5 5-5 5" /></SVG>;
const ShootIcon = () => (
  <SVG s={32}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.2l3.3 2.4-1.25 3.9H9.95L8.7 9.6z" />
    <path d="M12 7.2V4M15.3 9.6l2.7-1.1M14.05 13.5l1.7 2.4M9.95 13.5l-1.7 2.4M8.7 9.6L6 8.5" />
  </SVG>
);
const LobIcon = () => <SVG><path d="M4 16.5C8 7.5 16 7.5 20 14" /><path d="M20 14l.4-3.9M20 14l-3.8 1.2" /></SVG>;
const TackleIcon = () => <SVG><path d="M12 3.4l6.6 2.4v5c0 3.9-2.9 6.6-6.6 7.8C8.3 17.4 5.4 14.7 5.4 10.8v-5z" /></SVG>;
const SprintIcon = () => <SVG s={28}><path d="M6 6l6 6-6 6" /><path d="M13 6l6 6-6 6" /></SVG>;

const SIDE_CLS = { red: "pad--red", blue: "pad--blue" };
const SIDE_LABEL = { red: "红队", blue: "蓝队" };
const SIDE_LABEL_EN = { red: "Red", blue: "Blue" };
const GK_NUMBER = 1; // the goalkeeper seat is never handed to a phone

/**
 * Normalise a seat binding. The relay always sends `side`; an un-upgraded relay
 * only knows the two 1v1 slots, and slot 0 was red / slot 1 was blue, so the
 * fallback keeps this phone usable against an older relay.
 */
function seatFrom(msg) {
  const side = msg.side === "red" || msg.side === "blue" ? msg.side : msg.slot === 1 ? "blue" : "red";
  return { side, number: msg.number, playerId: msg.playerId, color: msg.color, slot: msg.slot, name: msg.name };
}

/** Seat colour as CSS, with a readable ink picked from its luminance. */
function seatPaint(color) {
  const n = typeof color === "number" ? color : 0x555f6b;
  const hex = "#" + (n >>> 0).toString(16).padStart(6, "0");
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return { background: hex, color: lum > 152 ? "#101620" : "#ffffff" };
}

/**
 * A per-room device id, so a phone that drops (or reloads, or restarts the app)
 * reclaims the SAME seat instead of being handed a fresh number. This is what
 * makes "绑定球员不可更换" survive a wifi hiccup.
 */
function deviceClientId(room) {
  const key = `ac_pad_client_${room}`;
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "";
  }
}

export default function PadController({ room, transport = "lan", requestedSlot = null, invite = "" }) {
  // status: "connecting" | "joining" | "ready" | "playing" | "full" | "no-room" | "closed"
  const [status, setStatus] = useState("connecting");
  const [slot, setSlot] = useState(null);
  // the seat this phone owns: { side, number, playerId, color } — the relay is the
  // only authority for these, we just render what it hands us
  const [seat, setSeat] = useState(null);
  const [occ, setOcc] = useState({ red: [], blue: [] });
  const [locked, setLocked] = useState(false);
  const [picker, setPicker] = useState(false);
  const [pickErr, setPickErr] = useState(null);
  const statusRef = useRef("connecting");
  const lanRef = useRef(null);
  const seqRef = useRef(0);
  const baseRef = useRef(null);
  const thumbRef = useRef(null);
  const stick = useRef({ id: null, cx: 0, cy: 0, r: 56 });
  // live continuous input (streamed); taps are sent as immediate one-offs
  const input = useRef({ vx: 0, vy: 0, shoot: false, sprint: false });

  useEffect(() => {
    if (!room) { setStatus("no-room"); return undefined; }
    let resumeToken = "";
    const setPadStatus = (next) => {
      statusRef.current = typeof next === "function" ? next(statusRef.current) : next;
      setStatus(statusRef.current);
    };
    const neutralize = (send = false) => {
      const current = input.current;
      current.vx = 0;
      current.vy = 0;
      current.shoot = false;
      current.sprint = false;
      stick.current.id = null;
      if (thumbRef.current) thumbRef.current.style.transform = "translate(0px,0px)";
      if (send && statusRef.current === "playing") {
        lanRef.current?.send({
          t: "input",
          seq: ++seqRef.current,
          d: { vx: 0, vy: 0, shoot: false, sprint: false },
        });
      }
    };
    if (transport === "online") {
      try { resumeToken = sessionStorage.getItem(`animalCupOnline:pad:${room}:${requestedSlot}`) || ""; } catch {}
      if (invite) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("invite");
        window.history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}`);
      }
    }
    const handlers = {
      onMessage(msg) {
        if (msg.t === "joined") {
          setSlot(msg.slot);
          setSeat(seatFrom(msg));
          setPadStatus(msg.started ? "playing" : "ready");
          if (transport === "online" && msg.token) {
            resumeToken = msg.token;
            try { sessionStorage.setItem(`animalCupOnline:pad:${room}:${msg.slot}`, msg.token); } catch {}
          }
        }
        else if (msg.t === "slot") { setSlot(msg.slot); setSeat(seatFrom(msg)); }
        // the relay moved this phone to a different number (host pick, or the
        // picker's own request coming back confirmed)
        else if (msg.t === "bind") { setSeat(seatFrom(msg)); setPickErr(null); }
        // numbers already worn on each side, so the picker can grey them out
        else if (msg.t === "occupancy") {
          setOcc({ red: msg.red || [], blue: msg.blue || [] });
          if (typeof msg.locked === "boolean") setLocked(msg.locked);
          if (msg.me) setSeat(seatFrom(msg.me));
        }
        else if (msg.t === "locked") { setLocked(!!msg.locked); }
        else if (msg.t === "pickErr") {
          setPickErr(msg.reason);
          if (msg.reason === "locked" || msg.reason === "bad-number" || msg.reason === "taken") setPicker(true);
        }
        else if (msg.t === "start") { setPadStatus("playing"); if (typeof msg.slot === "number") setSlot(msg.slot); }
        else if (msg.t === "rematch") { setPadStatus("playing"); }
        else if (msg.t === "ended") { neutralize(true); setPadStatus("ready"); }
        else if (msg.t === "joinErr") {
          neutralize(false);
          setPadStatus(["full", "slot-full", "side-full"].includes(msg.reason) ? "full" : msg.reason === "no-room" ? "no-room" : "denied");
          if (transport === "online") lanRef.current?.close();
        }
        else if (msg.t === "closed") {
          neutralize(false);
          setPadStatus("closed");
          if (transport === "online") lanRef.current?.close();
        }
      },
    };
    const lan = transport === "online"
      ? createOnlineClient({
          room,
          hello: () => ({ t: "hello", role: "pad", slot: requestedSlot, invite, token: resumeToken }),
          onStatus(next, detail) {
            if (next === "open") setPadStatus("joining");
            else if (next === "connecting") setPadStatus("connecting");
            else if (next === "error") setPadStatus(detail === "no-room" ? "no-room" : "denied");
          },
          ...handlers,
        })
      : createLanClient({
          onOpen() { setPadStatus("joining"); },
          onClose() { setPadStatus((current) => (current === "closed" ? current : "connecting")); },
          ...handlers,
        });
    lanRef.current = lan;
    // (re)join on every connect — a dropped phone re-takes its place, and the
    // stable clientId makes the relay hand back the SAME seat rather than a new one
    if (transport === "lan") {
      const clientId = room ? deviceClientId(room) : "";
      lan.setHello(() => ({ t: "join", room, name: navigator.platform || "Pad", clientId }));
    }

    // stream continuous state at ~30Hz (only while joined)
    const iv = setInterval(() => {
      if (statusRef.current !== "playing") return;
      const i = input.current;
      lan.send({ t: "input", seq: ++seqRef.current, d: { vx: i.vx, vy: i.vy, shoot: i.shoot, sprint: i.sprint } });
    }, 33);

    // lock the page from scrolling/zooming under the controls
    const prevent = (e) => e.preventDefault();
    const release = () => neutralize(true);
    const onVisibility = () => { if (document.hidden) release(); };
    document.addEventListener("touchmove", prevent, { passive: false });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);

    return () => {
      clearInterval(iv);
      neutralize(true);
      document.removeEventListener("touchmove", prevent);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      lan.close();
    };
  }, [room, transport, requestedSlot, invite]);

  // send an immediate frame carrying a one-shot tap (so taps never wait for the tick)
  function sendTap(key) {
    if (statusRef.current !== "playing") return;
    const i = input.current;
    lanRef.current && lanRef.current.send({
      t: "input",
      seq: ++seqRef.current,
      d: { vx: i.vx, vy: i.vy, shoot: i.shoot, sprint: i.sprint, [key]: true },
    });
  }

  function stickDown(e) {
    const rect = baseRef.current.getBoundingClientRect();
    const s = stick.current;
    s.id = e.pointerId; s.cx = rect.left + rect.width / 2; s.cy = rect.top + rect.height / 2; s.r = rect.width / 2;
    baseRef.current.setPointerCapture(e.pointerId);
    stickMove(e);
  }
  function stickMove(e) {
    const s = stick.current;
    if (s.id !== e.pointerId) return;
    e.preventDefault();
    const dx = e.clientX - s.cx, dy = e.clientY - s.cy;
    const dd = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, s.r / dd);
    if (thumbRef.current) thumbRef.current.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    let vx = dx / s.r, vy = dy / s.r;
    const m = Math.hypot(vx, vy);
    if (m > 1) { vx /= m; vy /= m; }
    const i = input.current;
    if (m < 0.18) { i.vx = 0; i.vy = 0; } else { i.vx = vx; i.vy = vy; }
  }
  function stickUp(e) {
    const s = stick.current;
    if (s.id !== e.pointerId) return;
    s.id = null;
    if (thumbRef.current) thumbRef.current.style.transform = "translate(0px,0px)";
    input.current.vx = 0; input.current.vy = 0;
  }

  const hold = (key) => ({
    onPointerDown: (e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); input.current[key] = true; },
    onPointerUp: (e) => { e.preventDefault(); input.current[key] = false; },
    onPointerCancel: () => { input.current[key] = false; },
  });
  const tap = (key) => ({ onPointerDown: (e) => { e.preventDefault(); sendTap(key); } });

  // The relay is the authority for the seat; `slot` survives only so this phone
  // keeps working against a relay that predates the seat protocol.
  const sideName = seat ? seat.side : slot === 1 ? "blue" : slot === 0 ? "red" : null;
  const sideCls = sideName ? SIDE_CLS[sideName] : "";
  const myNumber = seat && typeof seat.number === "number" && seat.number > 0 ? seat.number : null;
  const takenOnMySide = sideName ? occ[sideName] || [] : [];
  const seatStyle = seatPaint(seat && seat.color);

  function openPicker() {
    if (!seat) return;
    setPickErr(null);
    setPicker(true);
  }
  function choose(n) {
    if (!seat || locked) return;
    if (n === myNumber) { setPicker(false); return; }
    if (n === GK_NUMBER || takenOnMySide.includes(n)) return;
    setPickErr(null);
    setPicker(false);
    lanRef.current && lanRef.current.send({ t: "pick", number: n });
  }

  if (status !== "playing" && status !== "ready") {
    return <PadStatus status={status} room={room} />;
  }

  return (
    <div className={`pad ${sideCls}`}>
      <div className="pad-top">
        <button type="button" className="pad-seat" style={seatStyle} onClick={openPicker}
                disabled={!seat}
                aria-label={`已绑定 ${sideName ? SIDE_LABEL[sideName] : ""} ${myNumber || ""} 号，点击换号`}>
          <b>{sideName ? SIDE_LABEL[sideName] : "—"}</b>
          <em>{myNumber ? `${myNumber} 号` : "待分配"}</em>
        </button>
        <span className="pad-room">{room}</span>
        <span className={`pad-state pad-state--${status}`}>
          {status === "playing" ? "LIVE" : "READY"}
        </span>
      </div>

      <div className="pad-stick" ref={baseRef}
           onPointerDown={stickDown} onPointerMove={stickMove}
           onPointerUp={stickUp} onPointerCancel={stickUp}>
        <span className="pad-thumb" ref={thumbRef} />
      </div>

      <div className="pad-pad">
        <button type="button" className="pad-btn pad-btn--lob" {...tap("lob")}><LobIcon /></button>
        <button type="button" className="pad-btn pad-btn--pass" {...tap("pass")}><PassIcon /></button>
        <button type="button" className="pad-btn pad-btn--tackle" {...tap("tackle")}><TackleIcon /></button>
        <button type="button" className="pad-btn pad-btn--shoot" {...hold("shoot")}><ShootIcon /></button>
        <button type="button" className="pad-btn pad-btn--sprint" {...hold("sprint")}><SprintIcon /></button>
      </div>

      {picker ? (
        <div className="pad-picker" role="dialog" aria-modal="true" aria-label="选择号码">
          <div className="pad-picker-card">
            <b className="pad-picker-title">
              选择你的号码{sideName ? ` · ${SIDE_LABEL[sideName]}` : ""}
            </b>
            <span className="pad-picker-sub">Pick your number · {SIDE_LABEL_EN[sideName] || ""}</span>
            <div className="pad-picker-grid">
              {[1, 2, 3, 4, 5, 6, 7].map((n) => {
                const mine = n === myNumber;
                const gk = n === GK_NUMBER;
                const taken = !gk && !mine && takenOnMySide.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    className={`pad-pick ${mine ? "is-mine" : ""} ${gk ? "is-gk" : ""} ${taken ? "is-taken" : ""}`}
                    disabled={gk || taken || locked}
                    onClick={() => choose(n)}
                  >
                    <b>{n}</b>
                    <i>{gk ? "门将·AI" : taken ? "已占用" : mine ? "我的" : "可选"}</i>
                  </button>
                );
              })}
            </div>
            {pickErr ? (
              <p className="pad-picker-err">
                {pickErr === "locked" ? "比赛已开始，号码已锁定"
                  : pickErr === "taken" ? "这个号码刚被队友选走了"
                  : pickErr === "bad-number" ? "这个号码不可用"
                  : "换号失败，请重试"}
              </p>
            ) : null}
            <p className="pad-picker-note">
              {locked ? "开赛后不可换号 · Locked after kick-off" : "1 号是守门员，由 AI 担任 · #1 is the AI goalkeeper"}
            </p>
            <button type="button" className="pad-picker-close" onClick={() => setPicker(false)}>关闭 · Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PadStatus({ status, room }) {
  const MSG = {
    connecting: ["连接中…", "Connecting to the host…"],
    joining: ["加入房间…", "Joining room…"],
    full: ["房间已满", "This room already has 2 players."],
    "no-room": ["房间不存在", "Room not found — check the code or rescan."],
    denied: ["邀请无效", "This controller invite is invalid or reserved."],
    closed: ["主机已离开", "The host left. Ask them to restart."],
  };
  const [zh, en] = MSG[status] || ["…", "…"];
  return (
    <div className="pad pad--status">
      <div className="pad-status-card">
        <div className="pad-status-spinner" data-on={status === "connecting" || status === "joining"} />
        <b>{zh}</b>
        <span>{en}</span>
        {room ? <code className="pad-room-big">{room}</code> : null}
      </div>
    </div>
  );
}
