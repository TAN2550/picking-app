import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, patch } = body as { id: string; patch: Record<string, any> };

    if (!id || !patch) {
      return NextResponse.json({ error: "Missing id/patch" }, { status: 400 });
    }

    const supabase = await supabaseServer();

    // 1) Update picking_lines
    const { data: updated, error: updErr } = await supabase
      .from("picking_lines")
      .update(patch)
      .eq("id", id)
      .select("id, run_id, store_id, metal, picker, status")
      .single();

    if (updErr) {
      return NextResponse.json({ error: updErr }, { status: 400 });
    }

    // 2) Audit (mag NOOIT de update blokkeren)
    const { error: auditErr } = await supabase.from("picking_line_audit").insert({
      run_id: updated.run_id,
      store_id: updated.store_id,
      metal: updated.metal,
      picker: updated.picker ?? null,
      status: updated.status,
    });

    return NextResponse.json({ data: updated, auditError: auditErr ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
