import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv, supabaseServer } from "@/lib/supabase";

// POST only, so a link prefetch can't sign anyone out.
export async function POST(req: NextRequest) {
  if (supabaseEnv()) {
    const supabase = await supabaseServer();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/signin", req.url), { status: 303 });
}
