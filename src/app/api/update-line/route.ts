import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(req: Request) {
  try {
    const supabase = supabaseServer();
    const body = await req.json();

    // verwacht: { id: "uuid", patch: { picker?: string, status?: string } }
    const { id, patch } = body ?? {};

    if (!id || !patch || typeof patch !== "object") {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    // 1) Update picking line (dit is het belangrijkste)
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

    // 2) Audit proberen, maar NOOIT de app laten crashen
    // (als RLS niet goed staat, vangen we dat op)
    let auditWarning: any = null;
    try {
      // Minimal audit payload (werkt alleen als deze kolommen bestaan).
      // Als jouw audit tabel andere kolommen heeft, dan faalt insert -> we vangen dat op.
      const { error: auditErr } = await supabase.from("picking_line_audit").insert({
        line_id: id,
        changed_at: new Date().toISOString(),
        new_picker: patch.picker ?? null,
        new_status: patch.status ?? null,
      } as any);

      if (auditErr) {
        auditWarning = { message: auditErr.message, code: auditErr.code };
      }
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
