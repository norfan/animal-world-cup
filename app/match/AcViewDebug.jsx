"use client";

// Tiny diagnostic overlay for the pad features (Req #1/#3). Entirely hidden
// unless the host match URL carries ?acdebug=1. Polls
//   window.__acViewDebug   (maintained by acPhoneViewTick) — is the phone feed
//                          actually producing frames, and where is the crop?
//   window.__acStuck       (maintained by acUnstickSetPieces) — did the glue have
//                          to free a set-piece the locked seat had wedged?
// so you can see, live on the big screen, what the host is doing.
import { useEffect, useState } from "react";

const row = { display: "flex", gap: 8, justifyContent: "space-between" };

export default function AcViewDebug() {
  const [on, setOn] = useState(false);
  const [dbg, setDbg] = useState(null);
  const [stuck, setStuck] = useState([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("acdebug") !== "1") return undefined;
    setOn(true);
    const t = window.setInterval(() => {
      setDbg(window.__acViewDebug ? { ...window.__acViewDebug } : null);
      setStuck(window.__acStuck ? window.__acStuck.slice(-4) : []);
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  if (!on) return null;

  const crop = dbg && dbg.lastCrop;
  const line = (k, v) => (
    <div style={row} key={k}>
      <span style={{ opacity: 0.65 }}>{k}</span>
      <span>{v}</span>
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        left: 8,
        bottom: 8,
        zIndex: 9999,
        minWidth: 208,
        background: "rgba(0,0,0,0.72)",
        color: "#9f9",
        font: "12px/1.45 monospace",
        padding: "7px 9px",
        borderRadius: 6,
        pointerEvents: "none",
      }}
    >
      <div style={{ color: "#cfe", opacity: 0.75, marginBottom: 3 }}>phone-view feed</div>
      {!dbg ? (
        <div>no data yet</div>
      ) : (
        <>
          {line("ticks", dbg.ticks)}
          {line("sent", dbg.sent)}
          {line("bail", dbg.lastBail || "-")}
          {line("skip", dbg.lastSkip || "-")}
          {crop ? line("crop", `${crop.px},${crop.py} @ ${crop.ocx},${crop.ocy} (${crop.cw}x${crop.ch})`) : null}
          {line("err", dbg.lastError || "-")}
        </>
      )}
      <div style={{ color: "#cfe", opacity: 0.75, margin: "5px 0 3px" }}>set-piece unstick</div>
      {stuck.length === 0 ? (
        <div style={{ opacity: 0.6 }}>none</div>
      ) : (
        stuck.map((e) => (
          <div key={`${e.id}-${e.from}-${e.to}-${e.why}`}>
            #{e.id}
            {e.gk ? " GK" : ""} {e.from} → {e.to} ({e.why})
          </div>
        ))
      )}
    </div>
  );
}
