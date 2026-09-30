import PadController from "../pad/PadController";
import "../pad/pad.css";

export const metadata = {
  title: "Animal Cup · Online Controller",
};

export default async function OnlinePadPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const room = String(sp.room || "").toUpperCase();
  const slotValue = Number(sp.slot);
  const slot = slotValue === 0 || slotValue === 1 ? slotValue : null;
  const invite = String(sp.invite || "");
  return <PadController room={room} transport="online" requestedSlot={slot} invite={invite} />;
}
