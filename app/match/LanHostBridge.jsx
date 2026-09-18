"use client";

// Host-side LAN bridge. Mounts on the match page ONLY when ?lan=<ROOM> is
// present. The big screen re-attaches to its relay room as the host, then folds
// every phone's input into the engine's input contracts.
//
// There are two contracts, and a phone lands in exactly one of them:
//
//   * the seat path (preferred)  -> window.__acPads
//     The relay hands each phone a FIXED seat (side + jersey number -> engine
//     player id). We publish one record per seat here and the seat driver in
//     public/match-runtime-min/standalone-match.js turns each one into a real
//     engine User that permanently owns that one player. Nicknames and colours
//     ride along so the overhead label layer can draw them.
//
//   * the legacy 2-way path -> window.__touchInput / window.__touchInput2
//     Only used when an input arrives with no `side`, i.e. the relay on the
//     wire is an un-upgraded one that only knows the two 1v1 slots. A relay
//     that speaks the seat protocol always assigns a side, so a phone can never
//     end up feeding both paths at once.
//
// The driver reads the pad records on every frame, so the `ti` objects are
// mutated in place (never replaced) — only the seat *set* is republished.
import { useEffect } from "react";
import { createLanClient } from "../lan/lanClient";

function blankTi() {
  return {
    active: false,
    vx: 0,
    vy: 0,
    shoot: false,
    sprint: false,
    pass: false,
    lob: false,
    switchPlayer: false,
    tackle: false,
  };
}

/** Legacy slot objects, kept on `window` so the solo driver reads them directly. */
function ti(slot) {
  const key = slot === 1 ? "__touchInput2" : "__touchInput";
  return (window[key] = window[key] || blankTi());
}

function writeInput(T, d) {
  T.active = true;
  // continuous axes + held buttons: assign straight through
  T.vx = d.vx || 0;
  T.vy = d.vy || 0;
  T.shoot = !!d.shoot;
  T.sprint = !!d.sprint;
  // one-shot taps: OR them in so the engine consumes+clears them itself
  if (d.pass) T.pass = true;
  if (d.lob) T.lob = true;
  if (d.switchPlayer) T.switchPlayer = true;
  if (d.tackle) T.tackle = true;
}

function parkInput(T) {
  T.active = false;
  T.vx = 0;
  T.vy = 0;
  T.shoot = false;
  T.sprint = false;
}

export default function LanHostBridge() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = (params.get("lan") || "").toUpperCase();
    if (!room) return undefined;

    /** padId -> seat record. Identity is stable: the driver parks state on it. */
    const seats = new Map();
    /** legacy: slots that currently have a live phone attached */
    const present = new Set();
    let lastCounts = null;

    function publish() {
      window.__acPads = Array.from(seats.values());
    }

    function seatFrom(p) {
      let rec = seats.get(p.padId);
      if (!rec) {
        rec = { padId: p.padId, ti: blankTi() };
        seats.set(p.padId, rec);
      }
      rec.name = p.name || "";
      rec.side = p.side;
      rec.slot = p.slot;
      rec.number = p.number;
      rec.playerId = p.playerId;
      rec.color = p.color;
      rec.ready = p.ready !== false;
      // `ready:false` = the relay is holding this seat for a phone that dropped.
      // The player goes back to the AI, the number stays taken for 20 s.
      rec.suspended = p.ready === false;
      if (rec.suspended) parkInput(rec.ti);
      return rec;
    }

    const lan = createLanClient({
      onMessage(msg) {
        if (msg.t === "roster") {
          const pads = msg.pads || [];
          const nextIds = new Set();
          const legacySlots = new Set();

          for (const p of pads) {
            if (!p || p.padId == null) continue;
            // an upgraded relay always assigns a side; anything else is legacy
            if (p.side !== "red" && p.side !== "blue") {
              if (p.slot >= 0) legacySlots.add(p.slot);
              continue;
            }
            nextIds.add(p.padId);
            seatFrom(p);
          }
          // seats the relay dropped for good (past the hold window)
          for (const id of Array.from(seats.keys())) if (!nextIds.has(id)) seats.delete(id);

          present.clear();
          for (const s of legacySlots) present.add(s);
          for (const slot of [0, 1]) {
            const T = ti(slot);
            const live = present.has(slot);
            if (!live) parkInput(T);
            else T.active = true;
          }

          lastCounts = msg.counts || null;
          window.__acLanRoster = {
            room,
            counts: lastCounts,
            locked: !!msg.locked,
            seats: Array.from(seats.values()).map((s) => ({
              padId: s.padId,
              name: s.name,
              side: s.side,
              slot: s.slot,
              number: s.number,
              playerId: s.playerId,
              color: s.color, // the lobby seat panel and the label layer both paint with this
              ready: s.ready,
            })),
          };
          publish();
          return;
        }

        if (msg.t === "input") {
          const d = msg.d || {};
          if (msg.side === "red" || msg.side === "blue") {
            let rec = msg.padId != null ? seats.get(msg.padId) : null;
            if (!rec && msg.padId != null) {
              // input beat the roster: create the seat shell, roster fills the rest
              rec = { padId: msg.padId, side: msg.side, slot: msg.slot, number: msg.number, playerId: msg.playerId, ti: blankTi() };
              seats.set(msg.padId, rec);
              publish();
            }
            if (!rec) return;
            // a reserved seat still gets frames from a reattaching phone; ignore
            // them until the roster says the seat is live again
            if (rec.suspended) return;
            writeInput(rec.ti, d);
            return;
          }
          // un-upgraded relay: slot-routed 1v1
          if (msg.slot !== 0 && msg.slot !== 1) return;
          writeInput(ti(msg.slot), d);
          return;
        }

        if (msg.t === "locked") {
          window.__acLanRoster = { ...(window.__acLanRoster || { room }), room, locked: !!msg.locked };
          return;
        }
      },
    });

    // Re-attach to our existing room (created in the lobby) as host. setHello
    // means a dropped/reloaded socket re-attaches automatically.
    lan.setHello(() => ({ t: "host", room }));

    // Handy for the lobby's seat panel (P4) and for tests.
    window.__acLan = {
      room,
      send: (msg) => lan.send(msg),
      lock: (locked) => lan.send({ t: "lock", locked: !!locked }),
      pick: (padId, number) => lan.send({ t: "pick", padId, number }),
      assign: (padId, side) => lan.send({ t: "assign", padId, side }),
      roster: () => window.__acLanRoster || null,
      seats: () => Array.from(seats.values()),
    };

    // Tell the pads when full-time hits so they drop back to standby.
    const onEnded = () => lan.send({ t: "ended" });
    window.addEventListener("ab-match-ended", onEnded);

    return () => {
      window.removeEventListener("ab-match-ended", onEnded);
      window.__acPads = [];
      window.__acLan = null;
      lan.close();
    };
  }, []);

  return null;
}
