import PadClient from "./PadClient";
import "./pad.css";

export const metadata = {
  title: "Animal Cup · Controller",
};

// The phone-gamepad route. A phone reaches it as
// http://<lan-ip>:13000/pad?room=XXXX (usually by scanning the lobby QR).
// searchParams is async in Next 15.
export default async function PadPage({ searchParams }) {
  const sp = await searchParams;
  const room = ((sp && sp.room) || "").toString().toUpperCase();
  const apk = ((sp && sp.apk) || "").toString();
  return <PadClient room={room} apk={apk} />;
}
