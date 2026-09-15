(function(){"use strict";

/* =====================================================================
   LAN 4v4 seat driver  —  docs/multiplayer-4v4-design.md §2.8 / §3.2

   The relay (script/lan-server.mjs) hands every phone a fixed seat: a side and
   a jersey number that maps to an engine player id. `app/match/LanHostBridge.jsx`
   publishes those seats plus their live input on `window.__acPads`; this driver
   turns each seat into a real engine `User` that permanently owns one player.

   Nothing here runs unless `window.__acPads` is non-empty, so the existing
   1v1 path (`acDriveClaim` / `acAutoSwitch` / `__touchInput` / `__touchInput2`)
   is untouched when nobody scans a QR.

   Why it looks like this — every rule below is a trap that was measured, not
   guessed (see §2.8 and script/verify-pad-driver.mjs):

   1. `states.idle()` / `change(null)` really sets `current = null`, and since
      `states.is(null)` is then true for ever, every recovery path short-circuits
      -> the player freezes permanently. `takeControl(p, null)`,
      `releaseControl(null)` and `changeTeam()` (while a player is still held)
      all reach it, so we ALWAYS hand the engine a concrete state. `AIDefend` is
      the engine's own "give this player back to the AI" answer (every human
      state in its transitionToAI table maps to it).
   2. `transitionToHuman()` returns null for ReturnHome / WaitForOthers / Kickoff
      and returns `Ready` (a fixed point that ignores the stick) for `Ready`, so
      a seat is always bound with an explicit `HumanMove`.
   3. `Ready.update` never reads `controller.velocity`; `HumanMove` does. That is
      the whole "bound but standing still" symptom.
   4. `users.update()` -> `controller.update()` overwrites velocity/speed from the
      DEVICE every frame, so input must be written after that and before
      `pitch.update()` ticks the state machines. This driver hooks `pitch.update`
      and writes in front of it — the same slot the solo path uses in-place.
   5. `User.takeControl` THROWS when the target already has a user. The engine
      reaches `takeControl` from team.assignPlayers()/RequestHuman()/nextUser(),
      so a bound seat needs a guard: locked users refuse any other player. The
      guard is installed here at runtime instead of by surgically patching
      `match.rebuilt.js` (an 811 KB single-line bundle whose source is lost) —
      same effect, survives a rebuild, and cannot desync from the bundle.
   6. `acAutoSwitch` calls `takeControl` with no try/catch, so the moment a phone
      owns a player the solo auto-switch would throw inside the play phase; both
      solo drivers are therefore stubbed out while seats are active, and the
      keyboard/P2 users are marked disconnected so RequestHuman() skips them.
   ===================================================================== */
var acPadsActive = false;
var acPadsHookInstalled = false;
var acPadsSeen = {}; // padId -> pad record last seen, so we can release departures
var acPadsErrors = [];

function acPadsRuntime() {
  return {
    users: runtime("users"),
    states: runtime("players/states"),
    pglob: runtime("players/global"),
  };
}

/** True while at least one phone holds a seat. */
function acPadsMode() {
  return !!(window.__acPads && window.__acPads.length);
}

/** The engine's canonical "this player goes back to the AI" state. */
function acBackToAI(states, player) {
  if (!player) return null;
  if (player.isGoalkeeper) return states.transitionToAI(player) || states.AIGoalkeeperTendGoal;
  return states.AIDefend;
}

function acPadsPlayer(pitch, side, playerId) {
  var team = side === "blue" ? pitch.blueTeam : pitch.redTeam;
  var list = (team && (team.allPlayers || team.players)) || [];
  for (var i = 0; i < list.length; i += 1) if (list[i] && list[i].id === playerId) return list[i];
  return null;
}

/**
 * P-1 guard (the key-fix in §3.7): a fixed seat must survive every automatic
 * re-control path the engine has.
 *
 * A seat is fixed, so control of its player is a two-sided invariant:
 *
 *   1. CALLER side — a locked user never drifts off its own player, no matter
 *      who calls `takeControl` (team.assignPlayers, RequestHuman, nextUser...).
 *   2. TARGET side — and nobody else may take a LOCKED seat's player. Without
 *      this half the engine's own user repeated `takeControl(padPlayer)`, which
 *      the engine answers with `throw new Error("Cannot take control, player
 *      already controlled")` from inside a rAF frame — an uncaught exception
 *      every frame, caught by script/verify-pad-labels.mjs. Installing both
 *      halves makes the engine's attempt a silent no-op instead.
 *
 * Delegating everything else keeps the engine's own semantics (including its
 * throw) intact for the non-seat users.
 */
function acInstallLockGuard(users) {
  var proto = users.User.prototype;
  if (proto.__acLockGuard) return;
  proto.__acLockGuard = true;
  var origTake = proto.takeControl;
  var origAttach = proto.attachControl;
  proto.takeControl = function (player, state, globalOverride) {
    if (this.locked && player !== this.lockedPlayer) return;
    if (player && player.user && player.user.locked && player.user !== this) return;
    return origTake.call(this, player, state, globalOverride);
  };
  proto.attachControl = function (player) {
    if (this.locked && player !== this.lockedPlayer) return;
    if (player && player.user && player.user.locked && player.user !== this) return;
    return origAttach.call(this, player);
  };
}

/**
 * While phones own the seats the two solo drivers must stand down:
 *  - acDriveClaim would hand the ball-nearest player to the keyboard user
 *  - acAutoSwitch would throw on a player a phone already owns (no try/catch)
 */
var acOrigDriveClaim = acDriveClaim;
var acOrigAutoSwitch = acAutoSwitch;
acDriveClaim = function () {
  if (!acPadsMode()) return acOrigDriveClaim.apply(null, arguments);
};
acAutoSwitch = function () {
  if (!acPadsMode()) return acOrigAutoSwitch.apply(null, arguments);
};

function acEnterPadsMode(users) {
  if (acPadsActive) return;
  acPadsActive = true;
  acInstallLockGuard(users);
  // RequestHuman() only skips a user whose controller is disconnected, and the
  // minted pad controllers all share one keyboard device, so the keyboard/P2
  // users are detached rather than disabled.
  var list = users.list;
  for (var i = 0; i < 2; i += 1) if (list[i] && list[i].controller) list[i].controller.connected = false;
}

function acExitPadsMode(users) {
  if (!acPadsActive) return;
  acPadsActive = false;
  var list = users.list;
  for (var i = 0; i < 2; i += 1) if (list[i] && list[i].controller) list[i].controller.connected = true;
  for (var id in acPadsSeen) acReleasePad(acPadsSeen[id]);
  acPadsSeen = {};
}

function acMintPadUser(users, pad) {
  var u = new users.User(users.list.length, null, null, false, 0);
  users.list.push(u);
  u.color = typeof pad.color === "number" ? pad.color : 0xffc233;
  u.name = pad.name || ("P" + (pad.number || ""));
  u.enabled = true;
  // `takeControl` ends with forceHuman(player, this.controller ? state : null),
  // and forceHuman(player, null) funnels into states.idle() -> change(null) ->
  // the permanent freeze. So a user with no controller must never bind.
  if (!u.controller) u.controller = acMintController();
  return u;
}
/**
 * Park a seat whose phone is not attached right now (the relay keeps a dropped
 * seat in the roster for 20 s with `ready:false`). The player goes back to the
 * AI but the engine `User` is kept alive, so the same phone reclaims the same
 * player without minting a fresh user on every wifi hiccup.
 * Order matters: changeTeam() re-sets `online`, so off() must come last.
 */
function acHoldPad(pad) {
  var u = pad && pad.__user;
  if (!u) return;
  try {
    var states = runtime("players/states");
    u.locked = false;
    u.lockedPlayer = null;
    if (u.player) u.releaseControl(acBackToAI(states, u.player));
    if (u.team) u.changeTeam(null);
    u.enabled = false;
    if (u.off) u.off(); // online = false, so findControl()/assignPlayers() leave it alone
  } catch (e) {
    if (acPadsErrors.length < 8) acPadsErrors.push("hold:" + ((e && e.message) || e));
  }
  pad.__player = null;
}

/** Seat is gone for good — drop the engine User with it. */
function acReleasePad(pad) {
  if (!pad || !pad.__user) return;
  acHoldPad(pad);
  pad.__user = null;
}

/**
 * Bind one seat to its fixed player and reseat it if the engine parked it.
 * Returns the player, or null when this seat cannot be placed yet.
 */
function acBindSeat(users, states, pglob, pitch, pad) {
  var team = pad.side === "blue" ? pitch.blueTeam : pitch.redTeam;
  var player = acPadsPlayer(pitch, pad.side, pad.playerId);
  var u = pad.__user;
  if (!team || !player || !u) return null;
  // no controller -> takeControl() would freeze the player for good (see above)
  if (!u.controller) {
    if (acPadsErrors.length < 8) acPadsErrors.push("nocontroller:" + pad.padId);
    return null;
  }

  u.enabled = true; // a parked seat is re-enabled when its phone comes back
  u.locked = true;
  u.lockedPlayer = player;

  // (a) right team — release with a CONCRETE state first: changeTeam() while a
  //     player is still held funnels into releaseControl(null) and freezes it.
  if (u.team !== team) {
    if (u.player) u.releaseControl(acBackToAI(states, u.player));
    u.changeTeam(team);
  }
  // (b) Team.addUser() immediately auto-grabs some free player — hand it back.
  if (u.player && u.player !== player) u.releaseControl(acBackToAI(states, u.player));

  // (c) own the seat. `u.player` is drained first because takeControl() calls
  //     this.releaseControl() with NO argument internally, and that throws for
  //     every state missing from the transitionToAI table (Ready/Kickoff/...).
  if (u.player !== player || player.user !== u) {
    if (u.player) u.releaseControl(acBackToAI(states, u.player));
    if (player.user && player.user !== u) player.user.releaseControl(acBackToAI(states, player));
    u.takeControl(player, states.HumanMove);
  }
  if (player.controller !== u.controller) player.controller = u.controller;

  // (d) HumanGlobal is what grants human turn rate + pitch clamping in move()
  var want = player.isGoalkeeper ? pglob.HumanGoalkeeperGlobal : pglob.HumanGlobal;
  var cur = player.states._global;
  if (want && (!cur || cur.constructor !== want)) player.states.global(want);

  // (e) reseat into HumanMove unless the engine owns this moment or the player
  //     is already reading our input
  var cls = player.states.current ? player.states.current.constructor : null;
  if (cls && (cls.__acHumanOk || cls.__acNeverReseat)) return player;
  player.states.change(states.HumanMove);
  return player;
}

/**
 * The two state-class policy sets, tagged onto the engine's own constructors.
 * Keyed by the CLASS (not by name) so an engine rebuild cannot silently melt
 * the policies into one colliding key. Built lazily on the first sync, because
 * `runtime()` is not usable at the top of this IIFE.
 */
var acPoliciesReady = false;
function acEnsurePolicies() {
  if (acPoliciesReady) return;
  try {
    var s = runtime("players/states");
    // states that already consume controller.velocity every frame -> leave alone
    var ok = ["HumanMove", "HumanDribble", "HumanReceiveBall", "ClientMove", "ClientDribble"];
    for (var i = 0; i < ok.length; i += 1) if (s[ok[i]]) s[ok[i]].__acHumanOk = true;
    // states the engine deliberately owns for a moment (restart sequences,
    // action states, celebrations) -> never yank the player out of them.
    // This is exactly the list that passed the P0 gate; see
    // script/verify-pad-driver.mjs, which asserts reseats stays at 0.
    var never = [
      "BackOnPitch", "ReturnHomeCelebrating", "GoalCelebration", "GoalCelebrationPlane",
      "GoalCelebrationPlaneAssist", "GoalCelebrationDance", "GoalCelebrationDance2",
      "GoalCelebrationKneeslide", "WinCelebration",
      "Hit", "Slide", "Header", "Jump", "Kickoff", "WaitForOthers", "ThrowInThrow",
      "ThrowInPickUpBall", "KickToTarget", "KickInDirection", "Swerve", "Pass",
      "DirectShot", "HumanJump", "HumanPreciseShot", "HumanPass", "HumanLob",
      "HumanCornerKick", "HumanCornerAssist", "HumanThrowIn", "HumanPutBallBackInPlay",
      "HumanGoalKick", "HumanSelectShoot", "HumanSelectTeam",
    ];
    for (var j = 0; j < never.length; j += 1) if (s[never[j]]) s[never[j]].__acNeverReseat = true;
    acPoliciesReady = true;
  } catch (e) {
    if (acPadsErrors.length < 8) acPadsErrors.push("policies:" + ((e && e.message) || e));
  }
}

/** One pass over every seat: bind, reseat, feed input. Runs before pitch.update. */
/* =====================================================================
   P-2 — hold the line-up until kick-off has actually finished

   The engine's kick-off ceremony is `states.Kickoff` (a `WaitForPlayers`) and
   its `update` only advances once `pitch.allPlayersReady` is true — which is
   `isReady.send(this.players).every(...)`, i.e. EVERY player must answer "I am
   ready". A player we have taken control of answers NO, because it sits in
   `HumanMove` being driven.

   So binding seats while the match is still kicking off wedges the pitch in
   `Kickoff` for ever: `matchStarted` never flips and the half/goal/clock logic
   never runs. The match merely LOOKS playable, because our per-frame input
   still moves the players.

   (Found by script/lan-e2e.mjs, the one suite that walks the whole party flow —
   lobby -> /match with the phones already seated. Symptoms at the wedge:
   `state: "Kickoff"`, `prepared: true`, `play: false`, `allReady: false`,
   `playerStateTally: { HumanMove: 8, Ready: 4, ... }`.)

   It is not a LAN-only problem either: any seat bound before the whistle trips
   it, including the legacy 1v1 pads.

   The fix is the obvious one: a substitute does not run onto the pitch during
   the ceremony. Phones may join whenever they like; they take their player at
   the whistle, and `matchStarted` stays true for the rest of the match (it is
   only cleared by `reset()`, i.e. a rematch) so nothing is held back after.
   ===================================================================== */
function acMatchLive(pitch) {
  if (!pitch) return false;
  if (pitch.matchStarted) return true;
  var st = pitch.states && pitch.states.current;
  var name = st && st.constructor ? st.constructor.name : "";
  return name === "Match";
}

function acSyncPads() {
  var pads = window.__acPads;
  var R = acPadsRuntime();
  if (!pads || !pads.length) { acExitPadsMode(R.users); return; }
  // Driving with empty policy sets would yank players out of restarts and
  // celebrations, so refuse to drive at all until the tables exist.
  acEnsurePolicies();
  if (!acPoliciesReady) return;
  acEnterPadsMode(R.users);
  var pitch = window.__matchGame && window.__matchGame.pitch;
  if (!pitch) return;
  var live = acMatchLive(pitch);
  var pending = 0;
  var seen = {};
  for (var i = 0; i < pads.length; i += 1) {
    var pad = pads[i];
    if (!pad || !pad.ti) continue;
    seen[pad.padId] = pad;
    // reserved-but-detached seat: the number stays taken, the player goes AI
    if (pad.suspended) { acHoldPad(pad); continue; }
    // Kick-off still running and this seat has never been taken: leave it
    // alone. Minting the user here would ALSO be wrong — an unbound user makes
    // `Team.assignPlayers` grab a free player every frame, which is the same
    // readiness check we are waiting on.
    if (!live && !pad.__user) { pad.pending = true; pending += 1; continue; }
    pad.pending = false;
    try {
      if (!pad.__user) pad.__user = acMintPadUser(R.users, pad);
      var player = acBindSeat(R.users, R.states, R.pglob, pitch, pad);
      if (!player) continue;
      pad.__player = player;
      acApplyInput(pad.__user, pad.ti, false);
      // a fixed seat never triggers the engine's own "switch to the ball-nearest
      // player"; every minted controller shares one keyboard device, so the
      // action flag must be cleared explicitly.
      if (pad.__user.controller) pad.__user.controller.togglePlayer.isActive = false;
    } catch (e) {
      if (acPadsErrors.length < 8) acPadsErrors.push("sync:" + ((e && e.message) || e));
      if (!pad.__err) pad.__err = String((e && e.message) || e);
    }
  }
  // seats that left the roster (phone gone past the hold window)
  for (var id in acPadsSeen) if (!seen[id]) acReleasePad(acPadsSeen[id]);
  acPadsSeen = seen;
  window.__acPadsState = {
    active: acPadsActive,
    errors: acPadsErrors,
    seats: pads.length,
    live: live,
    pending: pending,
  };
}

/* =====================================================================
   P3 — overhead seat labels  (docs/multiplayer-4v4-design.md §3.4)

   The engine has no label system: `signs` is an empty shell, and the only
   per-player text it can draw is a debug `stateLabel` behind a flag. What it
   DOES have is `renderers/player`'s `overheadIndicator`, parked a flat 100 px
   above the sprite base (`this.overheadIndicator.position.y = sprite.y - 100`)
   — that is the engine's own answer to "where is above this player's head", so
   this layer measures the same quantity from `settings("PLAYER_HEIGHT") *
   PIXELS_Z` instead of inventing a constant.

   Why `stadium.topLayer` and not a child of the player renderer: the renderer
   flips `scale.x` with the facing direction, so text parented to it comes out
   mirrored on every leftward run. `topLayer` is added after `sortables`, so a
   label drawn there can never be hidden behind a player standing in front.

   Geometry comes straight out of `renderer.render()`:
       renderer.position   = worldToScreenFlat(player.position)   (feet, no z)
       renderer.sprite.position.y = -z * PIXELS_Z + 10 * spineScale
   so the head point is `position.y + sprite.position.y - PLAYER_HEIGHT*PIXELS_Z`
   and the label tip is parked a few px above it.

   A number is always drawn. A nickname and the seat's own colour are added only
   for a LIVE seat: a seat whose phone dropped has really gone back to the AI on
   the pitch, so showing its nickname would be a lie.

   Nothing is drawn unless seats are live and the viewer left labels on, so a
   solo 1v1 match looks exactly the same as before.
   ===================================================================== */
var AC_LABEL_KEY = "ac.playerLabels";
var AC_LABEL_SQUAD = 7;
var AC_AI_FILL = 0x39404d; // neutral slate: reads on grass and never competes with a seat colour
var AC_LABEL_MIN_W = 26;
var AC_LABEL_PAD_X = 7;
var AC_LABEL_PAD_Y = 4;
var AC_LABEL_GAP = 1;
var AC_LABEL_NUM_H = 27;
var AC_LABEL_NICK_H = 16;
var AC_LABEL_TIP = 7;
var AC_LABEL_GAP_ABOVE_HEAD = 10;
var AC_LABEL_FALLBACK_LIFT = 40; // only used if the RenderTexture readback fails
var AC_LABEL_SAMPLE_TICKS = 60; // measure for ~1 s, then freeze the lift

var acLabelPref = null;
var acLabelVisible = false;
var acLabelOwner = null; // the stadium this layer was built for
var acLabelLayer = null;
var acLabelItems = [];
var acLabelLift = AC_LABEL_FALLBACK_LIFT;
var acLabelHeadMax = 0; // running max of the PAINTED sprite height, in stadium px
var acLabelHeadTicks = 0;
var acLabelHeadCursor = 0;
var acLabelSig = "";
var acLabelErrors = [];
var acLabelRt = null;
var acLabelCam = null;
var acLabelRaf = false;
var acLabelCounters = { humans: 0, ai: 0, visible: 0, culled: 0, frames: 0, missingRenderer: 0 };

function acLabelRuntime() {
  if (!acLabelRt) {
    acLabelRt = {
      PIXI: runtime("pixi"),
      G: runtime("renderers/generic"),
      P2: runtime("core/math/point2"),
      settings: runtime("settings"),
    };
  }
  return acLabelRt;
}

function acLabelsPreferred() {
  if (acLabelPref === null) {
    var v = null;
    try { v = window.localStorage.getItem(AC_LABEL_KEY); } catch (e) {}
    acLabelPref = v === null ? true : v === "1";
  }
  return acLabelPref;
}

function acSetLabels(on) {
  acLabelPref = !!on;
  try { window.localStorage.setItem(AC_LABEL_KEY, acLabelPref ? "1" : "0"); } catch (e) {}
  if (!acLabelPref) acHideLabels();
  else if (acLabelLayer) acLabelLayer.visible = acPadsMode();
  return acLabelPref;
}

/** Black ink on a bright jersey colour, white on a dark one. */
function acInkOn(fill) {
  var r = (fill >> 16) & 255;
  var g = (fill >> 8) & 255;
  var b = fill & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 152 ? 0x101620 : 0xffffff;
}

/**
 * How many stadium px does the engine really paint above a player's origin?
 *
 * NOT `settings("PLAYER_HEIGHT") * PIXELS_Z` (~68) — that is the height of a ball
 * a player can trap, not the drawing. NOT `sprite.getLocalBounds()` either: the
 * visible sprite is a 256x256 RenderTexture page
 *   this.renderTexture = new RenderTexture(renderer, 256, 256)
 *   this.sprite = new Sprite(this.renderTexture)   // scale .5, anchor (.5, 1)
 *   this.sprite.scale.set(this.defaultScale, this.defaultScale)
 * so its bounds measure the whole page (256 * .5 = 128), not the animal. Both
 * numbers put the label far too high: measured against the painted frame the
 * animal is only ~35 px tall, so a 128 px lift floats three body-heights clear
 * of the head.
 *
 * The one trustworthy source is the RenderTexture's own pixels — the exact
 * output of `renderToTexture()` (which parks the feet 10 px above the page's
 * bottom edge). Read the topmost painted row and convert atlas px -> stadium px
 * with the sprite's own scale. Verified against a screen grab with
 * .scratch/diag-sprite-h.mjs + .scratch/measure-labels.py: ~70 of the 246 atlas
 * px above the feet are painted, i.e. ~35 stadium px.
 */
function acPaintHeight(r, extract) {
  if (!r || !r.renderTexture || !extract || typeof extract.pixels !== "function") return 0;
  var rt = r.renderTexture;
  if (!rt.width || !rt.height) return 0;
  var arr = null;
  try { arr = extract.pixels(rt); } catch (e) { return 0; }
  if (!arr || arr.length < rt.width * rt.height * 4) return 0;
  var W = rt.width;
  var H = rt.height;
  var top = -1;
  for (var y = 0; y < H && top < 0; y += 1) {
    for (var x = 0; x < W; x += 1) {
      if (arr[(y * W + x) * 4 + 3] > 8) { top = y; break; }
    }
  }
  if (top < 0) return 0;
  var sy = Math.abs((r.sprite && r.sprite.scale && r.sprite.scale.y) || 1);
  return (H - top) * sy;
}

/**
 * Measure ONE player per tick (round-robin) and keep the tallest. One readback
 * per frame is cheap; doing all 14 would stall the first second of the match.
 */
function acSampleHeadroom(stadium) {
  var ren = stadium && stadium.game && stadium.game.renderer;
  var extract = ren && ren.extract;
  var list = (stadium && stadium.players) || [];
  if (!list.length) return 0;
  var idx = acLabelHeadCursor % list.length;
  acLabelHeadCursor += 1;
  var r = list[idx];
  if (!r || r.visible === false) return 0;
  return acPaintHeight(r, extract);
}

/**
 * Last-resort lift if the RenderTexture readback never yields pixels (an exotic
 * GL driver, or `extract` unavailable). Chosen from the same measurement the
 * real path takes, not from `PLAYER_HEIGHT`.
 */
function acHeadPixels() {
  return AC_LABEL_FALLBACK_LIFT;
}

/**
 * Jersey number for an engine player id. Exact inverse of the relay's
 * `playerIdFor(side, number)` in script/lan-server.mjs — the two must agree or
 * a phone would see one number on the pad and another above the head.
 */
function acNumberFor(side, playerId) {
  return (side === "blue" ? playerId - AC_LABEL_SQUAD : playerId) + 1;
}

function acSeatFor(side, playerId) {
  var pads = window.__acPads || [];
  for (var i = 0; i < pads.length; i += 1) {
    var p = pads[i];
    if (p && p.side === side && p.playerId === playerId) return p;
  }
  return null;
}

function acMakeText(PIXI, str, size, ink, alpha) {
  var t = new PIXI.Text(str, {
    fontFamily: '"CupRound", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif',
    fontSize: size,
    fill: ink,
  });
  t.anchor.set(0.5, 0.5);
  t.alpha = alpha == null ? 1 : alpha;
  return t;
}

/**
 * Repaint one label. Only ever called when something actually changed — text
 * assignment rebuilds a canvas texture, so it must stay off the per-frame path.
 */
function acPaintLabel(it, fill, ink, nick) {
  var PIXI = acLabelRuntime().PIXI;
  var num = String(acNumberFor(it.side, it.playerId));
  if (it.bg) { it.root.removeChild(it.bg); it.bg.destroy(); it.bg = null; }
  if (it.num) { it.root.removeChild(it.num); it.num.destroy(); }
  if (it.nick) { it.root.removeChild(it.nick); it.nick.destroy(); }
  it.num = acMakeText(PIXI, num, 24, ink, 1);
  it.nick = acMakeText(PIXI, nick || "", 13, ink, 0.92);
  var hasNick = !!nick;
  var w = Math.max(AC_LABEL_MIN_W, it.num.width + AC_LABEL_PAD_X * 2);
  if (hasNick) w = Math.max(w, it.nick.width + AC_LABEL_PAD_X * 2);
  var h = AC_LABEL_PAD_Y * 2 + AC_LABEL_NUM_H + (hasNick ? AC_LABEL_GAP + AC_LABEL_NICK_H : 0);
  var top = -(AC_LABEL_TIP + h);
  var bg = new PIXI.Graphics();
  bg.beginFill(0x000000, 0.3); // drop shadow, so the capsule lifts off the grass
  bg.drawRoundedRect(-w / 2 + 1.6, top + 2.2, w, h, 8);
  bg.endFill();
  bg.beginFill(fill, 0.92);
  bg.drawRoundedRect(-w / 2, top, w, h, 8);
  bg.drawPolygon([-6, -AC_LABEL_TIP, 6, -AC_LABEL_TIP, 0, 0]);
  bg.endFill();
  if (it.human) { // a brighter rim is what makes "this one is a person" instant
    bg.lineStyle(1.5, 0xffffff, 0.5);
    bg.drawRoundedRect(-w / 2, top, w, h, 8);
  }
  it.root.addChild(bg);
  it.bg = bg;
  it.num.position.set(0, -(AC_LABEL_TIP + AC_LABEL_PAD_Y + AC_LABEL_NUM_H / 2));
  it.nick.position.set(0, -(AC_LABEL_TIP + AC_LABEL_PAD_Y + AC_LABEL_NUM_H + AC_LABEL_GAP + AC_LABEL_NICK_H / 2));
  it.nick.visible = hasNick;
  it.root.addChild(it.num);
  it.root.addChild(it.nick);
  it.number = Number(num);
  it.fill = fill;
  it.ink = ink;
  it.nickName = nick || "";
}

/** Map engine player id -> its renderer, from the stadium's own player list. */
function acRendererMap(stadium) {
  var map = {};
  var list = stadium.players || [];
  for (var i = 0; i < list.length; i += 1) {
    var r = list[i];
    if (!r) continue;
    var ent = r.entity || r.player;
    if (ent && typeof ent.id === "number" && ent.id >= 0) map[ent.id] = r;
  }
  return map;
}

function acBuildLabels() {
  var g = window.__matchGame;
  var stadium = g && g.stadium;
  var pitch = g && g.pitch;
  if (!stadium || !pitch || !pitch.redTeam || !pitch.blueTeam) return null;
  if (!stadium.topLayer && !stadium.addChild) return null;
  var PIXI = acLabelRuntime().PIXI;

  var layer = new PIXI.Container();
  var parent = stadium.topLayer || stadium;
  try {
    parent.addChild(layer);
  } catch (e) {
    stadium.addChild(layer);
    parent = stadium;
  }
  // labels live in exactly the same space control_indicator does: the stadium's
  // own child space, where worldToScreenFlat already returns camera-relative px
  layer.position.set(0, 0);

  var byId = acRendererMap(stadium);
  var items = [];
  var missing = 0;
  var sides = [["red", pitch.redTeam], ["blue", pitch.blueTeam]];
  for (var s = 0; s < sides.length; s += 1) {
    var side = sides[s][0];
    var team = sides[s][1];
    var squad = team.allPlayers || team.players || [];
    for (var k = 0; k < squad.length; k += 1) {
      var p = squad[k];
      if (!p || typeof p.id !== "number") continue;
      var root = new PIXI.Container();
      root.visible = false;
      layer.addChild(root);
      var it = { root: root, player: p, playerId: p.id, side: side, renderer: byId[p.id] || null, human: false, number: 0, nickName: "", fill: 0, ink: 0 };
      if (!it.renderer) missing += 1;
      acPaintLabel(it, AC_AI_FILL, 0xffffff, "");
      items.push(it);
    }
  }
  acLabelLayer = layer;
  acLabelOwner = stadium;
  acLabelItems = items;
  acLabelLift = AC_LABEL_FALLBACK_LIFT;
  acLabelHeadMax = 0;
  acLabelHeadTicks = 0;
  acLabelHeadCursor = 0;
  acLabelSig = "";
  acLabelCounters.missingRenderer = missing;
  acLabelCounters.humans = 0;
  acLabelCounters.ai = items.length;
  return {
    built: items.length,
    missingRenderer: missing,
    parent: parent === stadium.topLayer ? "topLayer" : parent === stadium ? "stadium" : "other",
  };
}

function acLabelRosterSig() {
  var pads = window.__acPads || [];
  var out = [];
  for (var i = 0; i < pads.length; i += 1) {
    var p = pads[i];
    if (!p) continue;
    out.push([p.padId, p.side, p.playerId, p.suspended ? "S" : "L", p.color || 0, p.name || ""].join(":"));
  }
  out.sort();
  return out.join("|");
}

/** Restyle labels whose seat colour / nickname / liveness changed. */
function acSyncLabelHumans() {
  var sig = acLabelRosterSig();
  if (sig === acLabelSig) return;
  acLabelSig = sig;
  var humans = 0;
  for (var i = 0; i < acLabelItems.length; i += 1) {
    var it = acLabelItems[i];
    var seat = acSeatFor(it.side, it.playerId);
    var live = !!(seat && !seat.suspended);
    if (live) humans += 1;
    var fill = live && typeof seat.color === "number" ? seat.color : AC_AI_FILL;
    var ink = live ? acInkOn(fill) : 0xffffff;
    var nick = live ? seat.name || "" : "";
    if (fill !== it.fill || ink !== it.ink || nick !== it.nickName || live !== it.human) {
      it.human = live;
      acPaintLabel(it, fill, ink, nick);
    } else {
      it.human = live;
    }
  }
  acLabelCounters.humans = humans;
  acLabelCounters.ai = acLabelItems.length - humans;
}

function acHideLabels() {
  if (acLabelLayer && acLabelLayer.visible) acLabelLayer.visible = false;
  // clear the per-item flags too, otherwise a stale `visible:true` shows up in
  // `state()` and could flash for a frame when the layer is switched back on
  for (var i = 0; i < acLabelItems.length; i += 1) {
    if (acLabelItems[i].root.visible) acLabelItems[i].root.visible = false;
  }
  acLabelCounters.visible = 0;
  acLabelVisible = false;
}

function acUpdateLabels() {
  acLabelCounters.frames += 1;
  var g = window.__matchGame;
  var stadium = g && g.stadium;
  if (!stadium) { acHideLabels(); return; }
  if (acLabelOwner !== stadium || !acLabelLayer) {
    try {
      if (!acBuildLabels()) { acHideLabels(); return; }
    } catch (e) {
      if (acLabelErrors.length < 6) acLabelErrors.push("build:" + ((e && e.message) || e));
      return;
    }
  }
  if (!acPadsMode() || !acLabelsPreferred()) { acHideLabels(); return; }

  // Measure the painted sprite height before showing anything: one player per
  // tick, round-robin, for the first second. Then FREEZE — a later diving header
  // would otherwise inflate the running max and shove every label up.
  acLabelHeadTicks += 1;
  if (acLabelHeadTicks <= AC_LABEL_SAMPLE_TICKS) {
    var head = acSampleHeadroom(stadium);
    if (head > acLabelHeadMax) {
      acLabelHeadMax = head;
      acLabelLift = acLabelHeadMax + AC_LABEL_GAP_ABOVE_HEAD;
    }
  }
  if (!acLabelHeadMax) {
    // a whole second with nothing painted: fall back rather than show no labels
    // at all, but say so through the debug state
    if (acLabelHeadTicks <= AC_LABEL_SAMPLE_TICKS) { acHideLabels(); return; }
    if (acLabelErrors.length < 6) acLabelErrors.push("no-paint-height");
    acLabelLift = AC_LABEL_FALLBACK_LIFT;
  }

  acSyncLabelHumans();
  acLabelLayer.visible = true;
  acLabelVisible = true;

  var R = acLabelRuntime();
  var cam = acLabelCam || (acLabelCam = R.P2.create());
  cam.x = 0;
  cam.y = 0;
  try { if (stadium.getCameraPosition) stadium.getCameraPosition(cam); } catch (e) {}
  var camW = stadium.cameraWidth || 0;
  var camH = stadium.cameraHeight || 0;
  var vis = 0;
  var cull = 0;
  for (var i = 0; i < acLabelItems.length; i += 1) {
    var it = acLabelItems[i];
    var r = it.renderer;
    var p = it.player;
    // renderer.visible === false means render() bailed out on `frame.id < 0`:
    // that player is not being drawn, so its stale position must not be used
    if (!r || !p || !p.position || r.visible === false) {
      if (it.root.visible) it.root.visible = false;
      cull += 1;
      continue;
    }
    var x = r.position.x;
    var y = r.position.y + (r.sprite ? r.sprite.position.y : 0) - acLabelLift;
    if (camW > 0 && (x < cam.x - 80 || x > cam.x + camW + 80 || y < cam.y - 80 || y > cam.y + camH + 80)) {
      if (it.root.visible) it.root.visible = false;
      cull += 1;
      continue;
    }
    it.root.visible = true;
    it.root.position.set(x, y);
    it.tipX = x;
    it.tipY = y;
    it.feetX = r.position.x;
    it.feetY = r.position.y;
    it.spriteBaseY = r.position.y + (r.sprite ? r.sprite.position.y : 0);
    vis += 1;
  }
  acLabelCounters.visible = vis;
  acLabelCounters.culled = cull;
}

function acLabelTick() {
  try { acUpdateLabels(); } catch (e) {
    if (acLabelErrors.length < 6) acLabelErrors.push("tick:" + ((e && e.message) || e));
  }
  window.requestAnimationFrame(acLabelTick);
}

function acLabelState() {
  var g = window.__matchGame;
  var top = g && g.stadium ? g.stadium.topLayer : null;
  return {
    built: acLabelItems.length,
    humans: acLabelCounters.humans,
    ai: acLabelCounters.ai,
    visible: acLabelCounters.visible,
    culled: acLabelCounters.culled,
    frames: acLabelCounters.frames,
    missingRenderer: acLabelCounters.missingRenderer,
    lift: acLabelLift,
    headMax: acLabelHeadMax,
    shown: !!acLabelVisible,
    on: acLabelsPreferred(),
    parent: acLabelLayer ? (acLabelLayer.parent === top ? "topLayer" : "other") : null,
    layerVisible: !!(acLabelLayer && acLabelLayer.visible),
    errors: acLabelErrors.slice(0, 6),
    items: acLabelItems.map(function (it) {
      return {
        playerId: it.playerId,
        side: it.side,
        number: it.number,
        human: !!it.human,
        nick: it.nickName || "",
        fill: it.fill,
        ink: it.ink,
        hasRenderer: !!it.renderer,
        visible: !!it.root.visible,
        tipX: it.tipX == null ? null : it.tipX,
        tipY: it.tipY == null ? null : it.tipY,
        feetX: it.feetX == null ? null : it.feetX,
        feetY: it.feetY == null ? null : it.feetY,
        spriteBaseY: it.spriteBaseY == null ? null : it.spriteBaseY,
      };
    }),
  };
}

window.__acLabels = {
  key: AC_LABEL_KEY,
  isOn: acLabelsPreferred,
  set: acSetLabels,
  toggle: function () { return acSetLabels(!acLabelsPreferred()); },
  active: function () { return !!acLabelVisible; },
  lift: function () { return acLabelLift; },
  headPixels: acHeadPixels,
  state: acLabelState,
  rebuild: function () { acLabelOwner = null; acLabelLayer = null; acLabelItems = []; acLabelSig = ""; },
};

(function acBootPads() {
  try {
    if (window.__matchGame && window.__matchGame.pitch) {
      if (!acPadsHookInstalled) {
        acPadsHookInstalled = true;
        var pitch = window.__matchGame.pitch;
        var origPitchUpdate = pitch.update.bind(pitch);
        pitch.update = function (elapsed) {
          try { acSyncPads(); } catch (e) {
            if (acPadsErrors.length < 8) acPadsErrors.push("hook:" + ((e && e.message) || e));
          }
          return origPitchUpdate(elapsed);
        };
        window.__acPadsState = { active: false, errors: acPadsErrors, seats: 0 };
      }
      // labels follow the camera, which keeps moving through the intro while
      // pitch.update is idle — so they run on their own rAF tick, not the hook
      if (!acLabelRaf) {
        acLabelRaf = true;
        window.requestAnimationFrame(acLabelTick);
      }
      return;
    }
  } catch (e) {}
  window.setTimeout(acBootPads, 120);
})();
window.__bootTrace=function(){var msg=Array.prototype.join.call(arguments," ");console.info("[boot-trace]",msg);try{localStorage.setItem("bootTrace",(localStorage.getItem("bootTrace")||"")+Date.now()+" "+msg+`
`)}catch{}};try{localStorage.removeItem("bootTrace")}catch{}function runtime(id){if(typeof window.require!="function")throw new Error("runtime require is not ready");return window.require(id)}function first(collection){return collection&&typeof collection.all=="function"?collection.all()[0]:null}function setupCollections(){var settings=runtime("settings");runtime("balls").load(settings("BALLS_ROOT")),runtime("stadiums").load(settings("STADIUMS_ROOT")),runtime("teams").load(settings("TEAMS_ROOT")),runtime("races").load(settings("RACES_ROOT"))}var FORMATIONS=[[4,3,3],[4,4,2],[3,4,3],[4,2,4],[3,5,2],[5,3,2]];function randomizeFormation(team){for(var f=FORMATIONS[Math.floor(Math.random()*FORMATIONS.length)],roles=[],d=0;d<f[0];d++)roles.push("D");for(var m=0;m<f[1];m++)roles.push("M");for(var a=0;a<f[2];a++)roles.push("A");for(var outfield=[],i=0;i<team.players.length;i++)team.players[i].role!=="G"&&outfield.push(team.players[i]);for(i=0;i<outfield.length;i++)roles[i]&&(outfield[i].role=roles[i]);return f.join("-")}var MATCH_ZOOM=2.3;(function(){try{var z=parseFloat(new URLSearchParams(window.location.search).get("zoom"));z>.5&&z<5&&(MATCH_ZOOM=z)}catch{}})(),typeof window.__matchZoomMul!="number"&&(window.__matchZoomMul=1);var INTRO_HOLD_MS=200,INTRO_MS=2200,REVEAL_FADE_MS=980;function introCoverZoom(zf){var rdr=window.__matchGame&&window.__matchGame.renderer,cover=rdr&&rdr.width?Math.max(rdr.width/5120,rdr.height/2560):window.__introZ0||zf*.105;return Math.min(cover,zf)}function introScale(){var t0=window.__introStart;if(!t0)return 1;if(t0===-1){if(performance.now()-(window.__introArmedAt||0)<REVEAL_FADE_MS+5e3){var zfh=MATCH_ZOOM*(window.__matchZoomMul||1);zfh=zfh<.8?.8:zfh>3?3:zfh;var z0h=introCoverZoom(zfh);return z0h/zfh}t0=window.__introStart=performance.now()}var el=performance.now()-t0,t=el<=INTRO_HOLD_MS?0:(el-INTRO_HOLD_MS)/INTRO_MS;if(t>=1)return window.__introStart=0,1;var zf=MATCH_ZOOM*(window.__matchZoomMul||1);zf=zf<.8?.8:zf>3?3:zf;var z0=introCoverZoom(zf);return z0*Math.pow(zf/z0,t)/zf}function introActive(){return!!window.__introStart}var AUTO_ZOOM={current:1,from:1,target:1,t0:0,dur:0,nextAt:0};window.__autoZoom=AUTO_ZOOM;function autoZoom(){var now=performance.now();if(window.__introStart)return AUTO_ZOOM.nextAt=now+5e3,AUTO_ZOOM.current;if((window.__manualZoomAt||0)>now-25e3)return AUTO_ZOOM.dur=0,AUTO_ZOOM.nextAt=now+5e3,AUTO_ZOOM.current;if(AUTO_ZOOM.dur>0){var t=(now-AUTO_ZOOM.t0)/AUTO_ZOOM.dur;if(t>=1)AUTO_ZOOM.current=AUTO_ZOOM.target,AUTO_ZOOM.dur=0;else{var sm=t*t*(3-2*t);AUTO_ZOOM.current=AUTO_ZOOM.from+(AUTO_ZOOM.target-AUTO_ZOOM.from)*sm}}else if(now>=AUTO_ZOOM.nextAt){var zoomedIn=AUTO_ZOOM.current>=1.14;AUTO_ZOOM.from=AUTO_ZOOM.current,AUTO_ZOOM.target=zoomedIn?1+Math.random()*.06:1.16+Math.random()*.16,AUTO_ZOOM.t0=now,AUTO_ZOOM.dur=2400+Math.random()*1400,AUTO_ZOOM.nextAt=now+5e3+Math.random()*2e3}return AUTO_ZOOM.current<1?1:AUTO_ZOOM.current}function effZoom(){var z=MATCH_ZOOM*(window.__matchZoomMul||1)*autoZoom();return z=z<.8?.8:z>3?3:z,z*introScale()}window.__matchZoom={get:function(){return window.__matchZoomMul||1},set:function(m){window.__manualZoomAt=performance.now(),window.__matchZoomMul=Math.max(.34,Math.min(2.4,m))},step:function(d){window.__matchZoom.set((window.__matchZoomMul||1)*d)},reset:function(){window.__matchZoomMul=1}},function(){try{new URLSearchParams(window.location.search).get("play")==="1"&&(window.__acPlay=!0)}catch{}}();function acPlay(){return!!window.__acPlay}window.__touchInput=window.__touchInput||{active:!1,vx:0,vy:0,shoot:!1,sprint:!1,pass:!1,lob:!1,switchPlayer:!1,tackle:!1};window.__touchInput2=window.__touchInput2||{active:!1,vx:0,vy:0,shoot:!1,sprint:!1,pass:!1,lob:!1,switchPlayer:!1,tackle:!1};(function(){try{new URLSearchParams(window.location.search).get("p2")==="1"&&(window.__acP2=!0)}catch{}})();function kitsForSide(redTeam,blueTeam,side){side=side==="away"?"away":"home";function rgb(hex){var n=parseInt(hex,16);return[n>>16&255,n>>8&255,n&255]}function d2(a,b){var x=a[0]-b[0],y=a[1]-b[1],z=a[2]-b[2];return x*x+y*y+z*z}try{var red=rgb(redTeam.kitColors[side]),bh=rgb(blueTeam.kitColors.home),ba=rgb(blueTeam.kitColors.away);return[side,d2(red,bh)>=d2(red,ba)?"home":"away"]}catch{return null}}function setupMatch(mode){var playerStates=runtime("players/states"),playerGlobals=runtime("players/global"),pitch=mode.game.pitch;if(!(window.__matchFormations&&window.__matchFormations.red)){var redFormation=randomizeFormation(pitch.redTeam),blueFormation=randomizeFormation(pitch.blueTeam);window.__bootTrace("formations(random): red "+redFormation+" blue "+blueFormation)}mode.game.removeAllPlayers();for(var i=0;i<mode.game.allPlayers.length;i+=1){var player=mode.game.allPlayers[i];player.placeAtPosition(pitch.center.x+pitch.random.uniform(-2,2),pitch.height-pitch.random.uniform(1,3)),mode.game.addPlayer(player),playerGlobals.forceAI(player,null),player.states.change(playerStates.ReturnHome)}if(acPlay()){for(var gki=0;gki<mode.game.allPlayers.length;gki+=1){var gkp=mode.game.allPlayers[gki];gkp&&gkp.isGoalkeeper&&(gkp.catchSpeed*=.5,gkp.maxForce*=.65,gkp.sprintSpeed*=.78,gkp.runSpeed*=.8,gkp.interceptRange*=.6)}window.__bootTrace("gk nerf (play)")}var newStatsSide=function(){return{shots:0,corners:0,throwIns:0,goalKicks:0,slides:0,passes:0,ownTicks:0}};window.__matchStats={red:newStatsSide(),blue:newStatsSide()},pitch.ball.placeAtPosition(pitch.center.x,pitch.height+10,0),pitch.beginMatch(60*mode.options.time/2,mode.options.drawAllowed,mode.options.ai);try{for(var snapTeams=[pitch.redTeam,pitch.blueTeam],sti=0;sti<snapTeams.length;sti+=1)for(var sps=snapTeams[sti]&&snapTeams[sti].allPlayers||[],spi=0;spi<sps.length;spi+=1){var sp=sps[spi];!sp||!sp.home||!sp.position||(sp.position.x=sp.home.x,sp.position.y=sp.home.y,typeof sp.position.z=="number"&&(sp.position.z=0),sp.velocity&&(sp.velocity.x=0,sp.velocity.y=0))}}catch{}pitch.camera.followBall(),pitch.camera.instantZoom(effZoom())}function acP2(){return!!window.__acP2}
function acMintController(){try{var C=runtime("controller"),kb=runtime("core/input/keyboard"),st=runtime("settings"),layout=st.current&&st.current.keyboardLayout||{};var Ctor=typeof C==="function"?C:C&&C.Controller||null;if(!Ctor)return null;return new Ctor(kb,layout)}catch(e){return console.warn("[ac-2p] mint controller failed",e),null}}
function acDriveClaim(stt,user,team,pitch,bpos,live,fireKickoff){if(live&&!stt.wasLive&&fireKickoff){var wrs=stt.restartSpot,wc=pitch.center;if(wrs&&Math.abs(wrs.x-wc.x)<3&&Math.abs(wrs.y-wc.y)<3)try{window.dispatchEvent(new CustomEvent("ab-kickoff-played"))}catch{}}if(stt.wasLive=live,!live){user.team&&user.changeTeam(null),stt.restartSpot={x:bpos.x,y:bpos.y};return}if(user.team)return;var rs=stt.restartSpot,dxr=rs?bpos.x-rs.x:999,dyr=rs?bpos.y-rs.y:999,movedSq=dxr*dxr+dyr*dyr,carrier=pitch.ball.owner,ownerMine=!!(carrier&&carrier.team===team);if(ownerMine&&movedSq>.09||movedSq>1){user.changeTeam(team);var tgt=ownerMine&&!carrier.isGoalkeeper?carrier:null;if(!tgt)for(var fps=team.fieldPlayers||team.players||[],bnd=1/0,i=0;i<fps.length;i+=1){var p=fps[i];if(p&&!p.isGoalkeeper&&p.position){var d=Math.hypot(p.position.x-bpos.x,p.position.y-bpos.y);d<bnd&&(bnd=d,tgt=p)}}if(tgt&&user.takeControl&&user.player!==tgt)try{user.takeControl(tgt)}catch{}}}
function acApplyInput(user,ti,sole){if(!user||!user.controller)return;var c=user.controller;if(sole){c.velocity.x=0,c.velocity.y=0,c.speed=0,c.shoot.isActive=!1,c.sprint.isActive=!1,c.pass.isActive=!1,c.lob.isActive=!1,c.togglePlayer.isActive=!1,c.slide.isActive=!1}if(!(ti&&ti.active))return;c.velocity.x=ti.vx,c.velocity.y=ti.vy;var sp=Math.sqrt(ti.vx*ti.vx+ti.vy*ti.vy);c.speed=sp>1?1:sp,sp>.001&&(c.direction.x=ti.vx/sp,c.direction.y=ti.vy/sp),ti.shoot&&(c.shoot.isActive=!0),ti.sprint&&(c.sprint.isActive=!0),ti.pass&&(c.pass.isActive=!0,ti.pass=!1),ti.lob&&(c.lob.isActive=!0,ti.lob=!1),ti.switchPlayer&&(c.togglePlayer.isActive=!0,ti.switchPlayer=!1),ti.tackle&&(c.slide.isActive=!0,ti.tackle=!1)}
function acAutoSwitch(stt,user,pitch,live,elapsed){if(stt.switchCd=Math.max(0,(stt.switchCd||0)-elapsed),user.controller&&user.controller.togglePlayer.isActive&&(stt.switchCd=1.2),!(live&&user.player&&!user.player.hasBall&&user.team&&(stt.switchCd<=0||user.player.isGoalkeeper)))return;for(var cp=user.player,bx=pitch.ball.position.x,by=pitch.ball.position.y,fps=user.team.fieldPlayers||user.team.players,near=null,nd=1/0,fi=0;fi<fps.length;fi+=1){var fp=fps[fi];if(fp&&!fp.isGoalkeeper){var dx=fp.position.x-bx,dy=fp.position.y-by,d=Math.sqrt(dx*dx+dy*dy);d<nd&&(nd=d,near=fp)}}if(near&&near!==cp){var cdx=cp.position.x-bx,cdy=cp.position.y-by,dCp=Math.sqrt(cdx*cdx+cdy*cdy);(cp.isGoalkeeper||nd<dCp-1)&&(user.takeControl(near),stt.switchCd=.25)}}
function createPlayPhase(){var State=runtime("core/states").State,geometry=runtime("core/math/geometry"),messages=runtime("messages"),users=runtime("users"),keyboard=runtime("core/input/keyboard");return State.extend("StandalonePlayPhase",{enter:function(mode){this.mode=mode,this.stream=mode.game.stream,this._aiming=!1,this._aimSlow=null,this._shootHeld=0,mode.game.pitch.resume(),mode.game.stadium.resume()},update:function(mode,elapsed){var pitch=mode.game.pitch;if(!pitch.paused){if(acPlay()){this._humanInit||(this._humanInit=!0,keyboard.enable(),users.list[0].enabled=!0);if(acP2()&&!this._p2Init){this._p2Init=!0;var _u1=users.list[1];_u1&&(_u1.controller||(_u1.controller=acMintController()),_u1.controller&&(_u1.enabled=!0))}keyboard.update(elapsed);var u0=users.list[0],live=pitch.matchStarted&&!pitch.ballOutOfPlay,bpos=pitch.ball.position;this._st0||(this._st0={wasLive:!1,restartSpot:null,switchCd:0});acDriveClaim(this._st0,u0,pitch.redTeam,pitch,bpos,live,!0);var _t2=window.__touchInput2,_want1=acP2()&&users.list[1]&&users.list[1].enabled&&_t2&&_t2.active,u1=_want1?users.list[1]:null;if(!_want1&&users.list[1]&&users.list[1].team){try{users.list[1].changeTeam(null)}catch{}this._st1=null}u1&&(this._st1||(this._st1={wasLive:!1,restartSpot:null,switchCd:0}),acDriveClaim(this._st1,u1,pitch.blueTeam,pitch,bpos,live,!1));users.update(elapsed);acApplyInput(u0,window.__touchInput,!1);u1&&acApplyInput(u1,window.__touchInput2,!0);acAutoSwitch(this._st0,u0,pitch,live,elapsed);u1&&acAutoSwitch(this._st1,u1,pitch,live,elapsed);var aimP=u0.player,aimC=u0.controller,aimHold=live&&aimC&&aimP&&aimP.hasBall&&aimC.shoot.isActive&&!acP2();this._shootHeld=aimHold?(this._shootHeld||0)+elapsed:0,aimHold&&this._shootHeld>.12?(this._aimSlow==null&&(this._aimSlow=pitch.timeScale.change(.4)),this._aiming=!0):this._aiming&&(this._aimSlow!=null&&(pitch.timeScale.reset(this._aimSlow),this._aimSlow=null),this._aiming=!1)}var frame=this.stream.beginWrite();pitch.setFrame(frame),pitch.update(elapsed),introActive()&&(pitch.camera.position.x=pitch.center.x,pitch.camera.position.y=pitch.center.y,pitch.camera.velocity&&(pitch.camera.velocity.x=0,pitch.camera.velocity.y=0)),pitch.camera.instantZoom(effZoom());try{var stadR=mode.game.stadium;if(!stadR._refInit&&stadR&&stadR.sortables&&stadR._redTeam&&stadR.players&&stadR.players.length>1){stadR._refInit=!0;var PRC=runtime("renderers/player").PlayerRenderer,sdata=runtime("pixi").loader.resources["data/player.json"].data,refR=new PRC({stadium:stadR,entity:null,spine:sdata});refR.spine.replaceSkins(stadR._redTeam.skins),refR.spine.setSkin(stadR.players[1].spine.skinName);var RefTex=runtime("pixi").Texture,KREF="/animal-cup/kit-ref/",refKitMap={chest_shirt:"shirt_front.png",arm_left_sleeve:"sleeve_left.png",arm_right_sleeve:"sleeve_right.png",pelvis_shorts:"shorts.png",leg_left_shorts:"shorts_leg.png",leg_right_shorts:"shorts_leg.png",leg_left_sock:"socks.png",leg_right_sock:"socks.png",leg_left_shoe:"shoes.png",leg_right_shoe:"shoes.png"},applyRefKit=function(){var sp2=refR.spine.sprites;if(sp2){for(var slot in refKitMap)sp2[slot]&&(sp2[slot].texture=RefTex.fromImage(KREF+refKitMap[slot]),sp2[slot].tint=16777215);sp2.head&&(sp2.head.texture=RefTex.fromImage(KREF+(refR.spine.facingCamera?"zebra_head.png":"zebra_head_back.png")));var zebraParts={neck:"zebra_neck.png",arm_left:"zebra_arm_left.png",arm_right:"zebra_arm_right.png",hand_left:"zebra_hand_left.png",hand_right:"zebra_hand_right.png",leg_left_knee:"zebra_knee.png",leg_right_knee:"zebra_knee.png"};for(var zp in zebraParts)sp2[zp]&&(sp2[zp].texture=RefTex.fromImage(KREF+zebraParts[zp]),sp2[zp].tint=16777215);sp2.head&&(sp2.head.tint=16777215),sp2.number&&(sp2.number.visible=!1)}};applyRefKit(),stadR.sortables.addChild(refR);var refObj={id:900,position:{x:pitch.center.x,y:pitch.center.y,z:0},state:{name:"Idle",id:0,data:null},events:{events:null},facing:1,direction:1,speed:0,movingForwards:!0,heading:{x:1,y:0}},origFrame=stadR.frame.bind(stadR);stadR.frame=function(fr){origFrame(fr);try{var bp=fr.ball.position,dx2=bp.x-refObj.position.x,dy2=bp.y-refObj.position.y,dist=Math.sqrt(dx2*dx2+dy2*dy2),keep=2.5;if(dist>keep){var dt=fr.elapsed||.016,step=Math.min(7*dt,dist-keep);refObj.position.x+=dx2/dist*step,refObj.position.y+=dy2/dist*step,refObj.heading.x=dx2/dist,refObj.heading.y=dy2/dist,refObj.facing=refObj.heading.x>=0?1:-1,refObj.direction=refObj.facing;var realSpeed=step/dt;refObj.speed=realSpeed,refObj.movingForwards=!0,refObj.state.name=realSpeed>.4?"Run":"Idle"}else refObj.speed=0,refObj.state.name="Idle";refR.render(fr,refObj),applyRefKit()}catch{refR.visible=!1}}}}catch{}var S=window.__matchStats;if(S){var sBall=pitch.ball,sOwner=sBall.owner,sHolder=sOwner||sBall.inHands;sHolder&&sHolder.team&&((sHolder.team===pitch.redTeam?S.red:S.blue).ownTicks+=1)}this.stream.endWrite(pitch),users.release(),messages.step.send(mode.game,frame)}if(mode.game.stadium.update(elapsed),mode.game._introBowPending&&!introActive()){mode.game._introBowPending=!1;try{var bows=[];(function walkAll(n,depth){if(!(!n||depth>7)){if(n.spine&&n.player){bows.push(n);return}for(var kids2=n.children||[],bi=0;bi<kids2.length;bi+=1)walkAll(kids2[bi],depth+1)}})(mode.game.stadium,0);for(var bj=0;bj<bows.length;bj+=1)bows[bj].spine.animationExists("waving")&&(bows[bj].spine.state.setAnimationByName(3,"waving",!0),(mode.game._celebrations=mode.game._celebrations||[]).push({spine:bows[bj].spine,until:performance.now()+1350,loop:!0}))}catch{}}var cels=mode.game._celebrations;if(cels&&cels.length)for(var ci=cels.length-1;ci>=0;ci-=1){var entry=cels[ci],tr3=entry.spine.state.tracks&&entry.spine.state.tracks[3],played=!tr3||!tr3.animation||tr3.time>=tr3.endTime,overdue=performance.now()>entry.until+2500;if(performance.now()>entry.until&&(played||entry.loop)||overdue){try{entry.spine.removeAnimation(3),entry.spine.skeleton.setBonesToSetupPose()}catch{}cels.splice(ci,1)}}if(mode.game._shakeT>0){mode.game._shakeT=Math.max(0,mode.game._shakeT-elapsed);var sk=mode.game._shakeT/.45,amp=16*sk*sk;mode.game.stadium.position.x=(Math.random()*2-1)*amp,mode.game.stadium.position.y=(Math.random()*2-1)*amp}},render:function(mode,elapsed){if(!mode.game.pitch.paused&&!mode.game.stadium.paused){var frame=this.stream.readAll(mode.game.alpha);frame&&messages.frame.send(mode.game.stadium,frame),mode.game.stadium.render(elapsed)}}})}function collectPlayerRenderers(game){var out=[];return function walk(n,depth){if(!(!n||depth>7)){if(n.spine&&n.player){out.push(n);return}for(var kids=n.children||[],i=0;i<kids.length;i+=1)walk(kids[i],depth+1)}}(game.stadium,0),out}function playTrack3(game,renderer,name,holdMs){!renderer||!renderer.spine.animationExists(name)||(renderer.spine.state.setAnimationByName(3,name,!1),(game._celebrations=game._celebrations||[]).push({spine:renderer.spine,until:performance.now()+holdMs}))}function snapPlayersHome(game){try{for(var teams=[game.pitch.redTeam,game.pitch.blueTeam],ti=0;ti<teams.length;ti+=1)for(var ps=teams[ti]&&teams[ti].allPlayers||[],pi=0;pi<ps.length;pi+=1){var p=ps[pi];!p||!p.home||!p.position||(p.position.x=p.home.x,p.position.y=p.home.y,typeof p.position.z=="number"&&(p.position.z=0),p.velocity&&(p.velocity.x=0,p.velocity.y=0))}}catch{}}function countSlideStat(game,slider){try{if(!slider||!slider.team)return;var now=performance.now();if(slider.__slideStatAt&&now-slider.__slideStatAt<900)return;slider.__slideStatAt=now;var side=slider.team===game.pitch.redTeam?"red":"blue";window.__matchStats[side].slides+=1}catch{}}function createStandaloneMatchState(options){var states=runtime("core/states"),teams=runtime("teams"),balls=runtime("balls"),stadiums=runtime("stadiums"),TeamStatsFrame=runtime("net/frame").TeamStatsFrame,PlayPhase=createPlayPhase(),redId=options.red||"england",blueId=options.blue||"france",redTeam=teams.get(redId)||teams.get("england")||first(teams),blueTeam=teams.get(blueId)||teams.get("france")||first(teams),ball=balls.get(options.ball||"classic_1")||first(balls),stadium=stadiums.get(options.stadium||"international")||first(stadiums);if(!redTeam||!blueTeam||!ball||!stadium)throw new Error("missing standalone match data");return states.State.extend("StandaloneMatch",{enter:function(game){if(window.__bootTrace("StandaloneMatch.enter"),this.game=game,this.ready=!1,this.playPhase=PlayPhase,this.options={redTeam,blueTeam,ball,stadium,time:Number(options.time||2),drawAllowed:!0,ai:options.ai==null?2:Number(options.ai),fastPlay:!0,kits:options.side&&kitsForSide(redTeam,blueTeam,options.side)||teams.selectKits(redTeam,blueTeam),userTeams:[]},this.redTeamStats=new TeamStatsFrame,this.blueTeamStats=new TeamStatsFrame,this.phase=new states.StateMachine(this),game.stream.restart(),game.stadium._showDepthFilter=!1,game.stadium.setFilters(),acPlay()){game.stadium.controlIndicator&&(game.stadium.controlIndicator.showAI=!1);var _traj=game.stadium.trajectory;if(_traj){for(var _li=0;_li<_traj.userLines.length;_li++)_traj.removeChild(_traj.userLines[_li]),_traj.userLines[_li]=_traj.createLine(16777215),_traj.addChild(_traj.userLines[_li]);var _origShowTraj=_traj.showTrajectory.bind(_traj);_traj.showTrajectory=function(team,player){if(player&&player.local&&player.localIndex>=0)return _origShowTraj.apply(this,arguments);this.visible=!1}}}else game.stadium.indicatorLayer&&(game.stadium.indicatorLayer.visible=!1),game.stadium.controlIndicator&&(game.stadium.controlIndicator._showTeam=function(){});game.pitch.celebrateGoals=!1,window.__bootTrace("before stadium.loadMatch"),game.stadium.loadMatch(stadium,ball,redTeam,this.options.kits[0],blueTeam,this.options.kits[1],this.onMatchLoaded,this),window.__bootTrace("after stadium.loadMatch call (async)")},onMatchLoaded:function(){window.__bootTrace("onMatchLoaded: setupMatch"),setupMatch(this);var self=this,stadiumRenderer=this.game.stadium;function reveal(){try{var rdr=self.game&&self.game.renderer;rdr&&(rdr.clearBeforeRender=!0,rdr.backgroundColor=6131768,window.__introZ0=Math.max(rdr.width/5120,rdr.height/2560))}catch{}snapPlayersHome(self.game),window.__introArmedAt=performance.now(),window.__introStart=-1,self.game._introBowPending=!0,document.body.classList.add("loaded"),document.body.classList.remove("loading"),window.dispatchEvent(new CustomEvent("ab-match-started",{detail:{red:redTeam.id||redId,blue:blueTeam.id||blueId,stadium:stadium.id||options.stadium||"asia",bundle:"match"}}))}function startMatch(){window.__bootTrace("onMatchLoaded: phase.change"),self.phase.change(self.playPhase),self.ready=!0;var frames=0;(function holdForKickoff(){if(self.game&&self.game._kickoffSnapped||frames++>900){reveal();return}window.requestAnimationFrame(holdForKickoff)})()}function bakeFans(){try{if(stadiumRenderer.prepare){for(var k=0;k<6;k+=1)if(stadiumRenderer.prepare())return window.__bootTrace("fans baked"),startMatch();window.requestAnimationFrame(bakeFans);return}}catch(error){console.warn("[standalone-match] fans bake failed",error)}startMatch()}bakeFans()},"signal:pitch.Pitch.states.HalfEnded.onExit":function(game){var Pitch=runtime("pitch").Pitch,change=function(){try{game.pitch.states.change(Pitch.states.ChangeSides)}catch(error){console.warn("[standalone-match] half-time transition failed",error)}};game.curtain&&game.curtain.show?game.curtain.show(change):change()},"signal:pitch.Pitch.states.Corner.onEnter":function(game){try{var cs=game.pitch.states.current,side=cs&&cs.team===game.pitch.redTeam?"red":"blue";window.__matchStats[side].corners+=1}catch{}},"signal:pitch.Pitch.states.ThrowIn.onEnter":function(game){try{var ts=game.pitch.states.current,side=ts&&ts.team===game.pitch.redTeam?"red":"blue";window.__matchStats[side].throwIns+=1}catch{}},"signal:pitch.Pitch.states.GoalKick.onEnter":function(game){try{var gs=game.pitch.states.current,side=gs&&gs.startingTeam===game.pitch.redTeam?"red":"blue";window.__matchStats[side].goalKicks+=1}catch{}},"signal:player.Player.onSlideHit":function(game,slider){countSlideStat(game,slider)},"signal:player.Player.onSlideTrap":function(game,slider){countSlideStat(game,slider)},"signal:player.Player.onPass":function(game,a,receiver){try{var rp=receiver&&receiver.team?receiver:a&&a.team?a:null;if(!rp)return;var side=rp.team===game.pitch.redTeam?"red":"blue";window.__matchStats[side].passes+=1}catch{}},"signal:player.Player.onShot":function(game,shooter){try{if(!shooter||!shooter.team)return;var side=shooter.team===game.pitch.redTeam?"red":"blue",st=window.__matchStats[side];st.shots+=1,st.lastShotAt=performance.now()}catch{}},"signal:pitch.Pitch.states.Goal.onEnter":function(game){try{var gp=game.pitch,gSide=gp.redTeam.score>(window.__lastScoreRed|0)?"red":"blue";window.__lastScoreRed=gp.redTeam.score|0;var gs2=window.__matchStats&&window.__matchStats[gSide];gs2&&performance.now()-(gs2.lastShotAt||0)>2500&&(gs2.shots+=1)}catch{}game._shakeT=.45,window.dispatchEvent(new CustomEvent("ab-goal",{detail:{red:redTeam.id||redId,blue:blueTeam.id||blueId,score:[game.pitch.redTeam.score|0,game.pitch.blueTeam.score|0]}}))},"signal:pitch.Pitch.states.Kickoff.onEnter":function(game){if(!game._firstKickoffDone){if(game._firstKickoffDone=!0,acPlay()&&!game._kickoffForced){game._kickoffForced=!0,game.pitch.matchStartingTeam=game.pitch.redTeam;var k0=game.pitch.states.current;k0&&"startingTeam"in k0&&(k0.startingTeam=game.pitch.redTeam)}try{for(var teams2=[game.pitch.redTeam,game.pitch.blueTeam],ti=0;ti<teams2.length;ti+=1)for(var ps=teams2[ti]&&teams2[ti].allPlayers||[],pi=0;pi<ps.length;pi+=1){var p=ps[pi];!p||!p.home||!p.position||(p.position.x=p.home.x,p.position.y=p.home.y,typeof p.position.z=="number"&&(p.position.z=0),p.velocity&&(p.velocity.x=0,p.velocity.y=0))}}catch(error){console.warn("[standalone-match] kickoff snap-to-home failed",error)}try{var st=game.pitch.matchStartingTeam;if(st&&st.getPlayersForKickOff)for(var takers=st.getPlayersForKickOff(),dir=st.goal===game.pitch.leftGoal?-1:1,ki=0;ki<takers.length;ki+=1){var tp=takers[ki];!tp||!tp.position||(tp.position.x=game.pitch.center.x+dir*(.9+ki*1.5),tp.position.y=game.pitch.center.y+(ki?2:0),typeof tp.position.z=="number"&&(tp.position.z=0),tp.velocity&&(tp.velocity.x=0,tp.velocity.y=0))}}catch(error2){console.warn("[standalone-match] kickoff taker pre-place failed",error2)}try{if(!game._introKickoffHeld){game._introKickoffHeld=!0;var cur=game.pitch.states.current;cur&&typeof cur.delay=="number"&&(cur.delay=(REVEAL_FADE_MS+INTRO_HOLD_MS+INTRO_MS)/1e3+1)}}catch{}game._kickoffSnapped=!0}},"signal:pitch.Pitch.states.EndMatch.onEnter":function(game){var redScore=game.pitch.redTeam.score|0,blueScore=game.pitch.blueTeam.score|0;window.dispatchEvent(new CustomEvent("ab-match-ended",{detail:{red:redTeam.id||redId,blue:blueTeam.id||blueId,score:[redScore,blueScore]}}))},onMessage:function(game,message,a,b,c,d,e,f,h,i){return this.phase.onMessage(message,a,b,c,d,e,f,h,i)},onFrame:function(game,frame){return runtime("messages").frame.send(game.stadium,frame),!0},onQuit:function(){return!0},onContinue:function(){return!0},updateUsernames:function(){},update:function(game,elapsed){this.ready&&this.phase.update(elapsed)},render:function(game,elapsed){this.ready&&this.phase.render(elapsed)},exit:function(game){this.phase.idle(),game.stadium.unloadMatch(),game.onExit.send()}})}function createGame(){var settings=runtime("settings"),Signal=runtime("core/signal"),GameBase=runtime("core/game"),Ball=runtime("ball").Ball,Pitch=runtime("pitch").Pitch,Team=runtime("team").Team,Player=runtime("player").Player,Goalkeeper=runtime("goalkeeper").Goalkeeper,playerStates=runtime("players/states"),playerGlobals=runtime("players/global"),StadiumRenderer=runtime("renderers/stadium").StadiumRenderer,Curtain=runtime("renderers/curtain"),MatchStream=runtime("net/stream").MatchStream,assets=runtime("assets"),fans=runtime("fans"),messages=runtime("messages");function MatchGame(){GameBase.call(this,{width:window.innerWidth,height:window.innerHeight,rendererOptions:settings("RENDERER_OPTIONS",{}),assets:assets.all}),document.body.insertBefore(this.renderer.view,document.body.firstChild),this.onEnter=new Signal,this.onExit=new Signal,this._autoResize=!0,this.resolution=Math.min(window.devicePixelRatio||1,2),this.viewportWidth=0,this.viewportHeight=0,this.pitch=new Pitch({width:settings("PITCH_WIDTH"),height:settings("PITCH_HEIGHT"),goalWidth:settings("GOAL_WIDTH"),goalHeight:settings("GOAL_HEIGHT"),regionColumns:16,regionRows:9}),this.pitch.states.global(Pitch.states.Global),this.pitch.ball=new Ball({game:this,pitch:this.pitch,gravity:{z:settings("GRAVITY")}});var ROLE={D:Player.ROLE_DEFENDER,M:Player.ROLE_MIDFIELDER,A:Player.ROLE_ATTACKER},DEFAULT_FORM={name:"2-3-1",spots:[[3,2,"D"],[3,6,"D"],[5,1,"M"],[5,4,"M"],[5,7,"M"],[7,4,"A"]]},chosen=window.__matchFormations,redForm=chosen&&chosen.red||DEFAULT_FORM,blueForm=chosen&&chosen.blue||DEFAULT_FORM;window.__bootTrace("formations red="+redForm.name+" blue="+blueForm.name);for(var SQUAD=7,redPlayers=[this.makeGoalkeeper(0,0,4)],bluePlayers=[this.makeGoalkeeper(SQUAD,0,4)],f=0;f<6;f+=1){var rs=redForm.spots[f],bsp=blueForm.spots[f];redPlayers.push(this.makePlayer(1+f,rs[0],rs[1],ROLE[rs[2]]||Player.ROLE_MIDFIELDER,.97)),bluePlayers.push(this.makePlayer(SQUAD+1+f,bsp[0],bsp[1],ROLE[bsp[2]]||Player.ROLE_MIDFIELDER,.97))}this.pitch.redTeam=new Team({pitch:this.pitch,players:redPlayers}),this.pitch.blueTeam=new Team({pitch:this.pitch,players:bluePlayers}),this.pitch.redTeam.states.global(Team.states.Global),this.pitch.blueTeam.states.global(Team.states.Global),this.allPlayers=this.pitch.redTeam.allPlayers.concat(this.pitch.blueTeam.allPlayers),this.stream=new MatchStream(8);for(var squadSize=this.pitch.redTeam.allPlayers.length,streamFrames=this.stream.frames.concat([this.stream.interpolated,this.stream._merged]),sf=0;sf<streamFrames.length;sf+=1)streamFrames[sf].redTeam._grow(squadSize),streamFrames[sf].blueTeam._grow(squadSize);this.stadium=null,this.curtain=null,this.runInBackground=!0}return MatchGame.prototype=Object.create(GameBase.prototype),MatchGame.prototype.constructor=MatchGame,MatchGame.prototype.removePlayer=function(player){this.pitch.removePlayer(player),playerGlobals.forceIdle(player)},MatchGame.prototype.removeAllPlayers=function(){for(var i=this.pitch.players.length-1;i>=0;i-=1)this.removePlayer(this.pitch.players[i])},MatchGame.prototype.addPlayer=function(player){this.pitch.addPlayer(player)},MatchGame.prototype.reset=function(){this.pitch.ball.owner&&(messages.releaseBall.send(this.pitch.ball.owner),messages.releaseBall.send(this.pitch.ball)),this.pitch.ball.inHands&&this.pitch.ball.inHands.dropBall(),this.pitch.redTeam.states.idle(),this.pitch.blueTeam.states.idle(),this.pitch.states.idle(),this.pitch.ballOutOfPlay=!1,this.stadium.resume(),this.stadium.pause(),this.removeAllPlayers(),this.curtain.hide()},MatchGame.prototype.makeGoalkeeper=function(id,column,row){var player=new Goalkeeper({id,pitch:this.pitch,home:this.pitch.regions[column][row].center});return player.states.default=playerStates.Ready,player},MatchGame.prototype.makePlayer=function(id,column,row,role,accuracy){var player=new Player({id,pitch:this.pitch,accuracy,home:this.pitch.regions[column][row].center,role});return player.states.default=playerStates.Ready,player},MatchGame.prototype.repositionUI=function(){runtime("signs").resize(this.renderer.width,this.renderer.height)},MatchGame.prototype.resize=function(){if(this._autoResize&&(this.viewportWidth=window.innerWidth*this.resolution,this.viewportHeight=window.innerHeight*this.resolution,GameBase.prototype.resize.call(this,this.viewportWidth,this.viewportHeight,this.resolution),this.stadium&&(this.stadium.resize(this.viewportWidth,this.viewportHeight),this.repositionUI()),this.curtain)){var scale=Math.max(window.innerWidth/1920,window.innerHeight/1080);this.curtain.scale.set(scale,scale),this.curtain.position.set(.5*this.viewportWidth,.5*this.viewportHeight)}},MatchGame.prototype._onLoad=function(){window.__bootTrace("_onLoad: StadiumRenderer"),this.stadium=new StadiumRenderer({game:this,pitch:this.pitch,players:this.pitch.redTeam.allPlayers.concat(this.pitch.blueTeam.allPlayers)}),this.stage.addChild(this.stadium),this.repositionUI(),window.__bootTrace("_onLoad: fans.init"),fans.init(),window.__bootTrace("_onLoad: curtain"),this.curtain=new Curtain(this.stadium),this.stadium.entities.add(this.curtain),this.stage.addChild(this.curtain),window.__bootTrace("_onLoad: GameBase._onLoad"),GameBase.prototype._onLoad.call(this),window.__bootTrace("_onLoad: done")},Object.defineProperties(MatchGame.prototype,{mode:{get:function(){return this.states.current},set:function(state){this.states.change(state)}},autoResize:{get:function(){return this._autoResize},set:function(value){this._autoResize!==value&&(this._autoResize=value,this._autoResize&&this.resize())}}}),new MatchGame}window.__startStandaloneMatch=function(options){options=options||{};var bt0=performance.now(),blog=function(msg){console.info("[match-boot +"+((performance.now()-bt0)/1e3).toFixed(2)+"s] "+msg)};try{blog("setupCollections"),setupCollections(),blog("setupCollections done");var i18n=runtime("i18n"),fans=runtime("fans"),settings=runtime("settings");try{i18n.activate(navigator.language.slice(0,2))}catch{i18n.activate("en")}if(document.body.classList.add("loaded"),document.body.classList.remove("loading"),!window.__matchGame){blog("createGame"),window.__matchGame=createGame(),blog("game.start"),window.__matchGame.start();var doResize=window.__matchGame.resize.bind(window.__matchGame);doResize(),window.addEventListener("resize",doResize),window.addEventListener("orientationchange",function(){setTimeout(doResize,120),setTimeout(doResize,450)}),window.visualViewport&&window.visualViewport.addEventListener&&window.visualViewport.addEventListener("resize",doResize),blog("game started + resized")}blog("fans.load"),fans.load(settings("DEFAULTS_ROOT"),function(){blog("fans.load done \u2192 game.load");try{var loader=window.__matchGame.loader||window.PIXI&&window.PIXI.loader;loader&&loader.on&&loader.on("progress",function(ldr){var pct=Math.round(ldr.progress||0);window.__loadProgress=pct,window.dispatchEvent(new CustomEvent("ab-load-progress",{detail:pct}))})}catch{}window.__matchGame.load(function(){blog("game.load done \u2192 states.change(StandaloneMatch)"),window.__matchGame.states.change(createStandaloneMatchState(options)),blog("states.change returned")})})}catch(error){console.error("[standalone-match] boot failed",error),blog("FATAL: "+error.message)}}})();
