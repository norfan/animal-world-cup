import OnlineRoomClient from "./OnlineRoomClient";
import "./online.css";

export const metadata = {
  title: "Animal Cup · Online",
};

export default async function OnlinePage({ searchParams }) {
  const sp = (await searchParams) || {};
  const create = ["direct", "controllers"].includes(String(sp.create)) ? String(sp.create) : "";
  return (
    <OnlineRoomClient
      createMode={create}
      initialRoom={String(sp.room || "")}
      initialHost={String(sp.host || "") === "1"}
      seed={{
        red: String(sp.red || "argentina"),
        blue: String(sp.blue || "portugal"),
        side: String(sp.side || "home"),
        ai: Number(sp.ai || 1),
        time: Number(sp.time || 20),
        squad: Number(sp.squad || 6),
        formations: {
          red: String(sp.redForm || "2-3-1"),
          blue: String(sp.blueForm || "3-2-1"),
        },
      }}
    />
  );
}
