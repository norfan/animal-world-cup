// Reports the current phone-controller APK metadata so the web UI can show the
// latest version and warn a device running an older build to update. Read live
// from the build artifacts so bumping android-pad/version.json is enough.
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERSION_FILE = path.join(process.cwd(), "android-pad", "version.json");
const APK_PATH = path.join(process.cwd(), "android-pad", "animal-cup-pad.apk");

export async function GET() {
  let version = "0.0.0";
  let name = "Animal Cup 手机手柄";
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
    version = v.version || version;
    name = v.name || name;
  } catch {}
  let size = 0;
  try { size = fs.statSync(APK_PATH).size; } catch {}
  return NextResponse.json({ version, name, size });
}
