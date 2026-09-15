// Serves the prebuilt phone-controller APK so a phone that scans the lobby QR
// (lands on /pad) can download the app directly over the LAN — no store, no
// external host. The relay host (computer) already serves this on :13000.
import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

// File is read at request time, so never statically optimized/cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const APK_PATH = path.join(process.cwd(), "android-pad", "animal-cup-pad.apk");

export async function GET() {
  try {
    const data = fs.readFileSync(APK_PATH);
    return new NextResponse(data, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="animal-cup-pad.apk"',
        "Content-Length": String(data.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse("APK not found (run the build first)", { status: 404 });
  }
}
