import GameClient from "../GameClient";
import MatchChrome from "./MatchChrome";
import MatchAudio from "./MatchAudio";
import LanHostBridge from "./LanHostBridge";
import OnlineMatchBridge from "./OnlineMatchBridge";
import AcViewDebug from "./AcViewDebug";
import "../ui/kit.css";
import "./match.css";

export const metadata = {
  title: "Animal Cup",
};

export default function MatchPage() {
  return (
    <>
      <GameClient />
      <MatchChrome />
      <MatchAudio />
      {/* No-op unless ?lan=<ROOM> is present: folds phone input into the engine */}
      <LanHostBridge />
      {/* No-op unless ?online=<ROOM> is present. */}
      <OnlineMatchBridge />
      {/* Diagnostic only: shows when the host URL has ?acdebug=1 */}
      <AcViewDebug />
    </>
  );
}
