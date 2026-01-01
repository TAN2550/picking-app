import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

function serviceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const supabase = await supabaseServer();
    const body = await req.json();
    const { id, patch } = body ?? {};

    if (!id || !patch || typeof patch !== "object") {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    // 1) update picking_lines (gewoon met anon/login client)
    const { data: updated, error: updErr } = await supabase
      .from("picking_lines")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();

    if (updErr) {
      return NextResponse.json(
        { error: updErr.message, code: updErr.code },
        { status: 400 }
      );
    }

    // 2) audit via service role (bypass RLS)
    let auditWarning: any = null;
    try {
      const svc = serviceSupabase();
      const { error: auditErr } = await svc.from("picking_line_audit").insert({
        changed_at: new Date().toISOString(),
        run_id: updated.run_id,
        store_id: updated.store_id,
        metal: updated.metal,
        // optioneel extra velden als je die hebt:
        // picker: updated.picker,
        // status: updated.status,
      });

      if (auditErr) auditWarning = { message: auditErr.message, code: auditErr.code };
    } catch (e: any) {
      auditWarning = { message: e?.message ?? "audit failed" };
    }

    return NextResponse.json({ ok: true, updated, auditWarning });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
