import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await supabaseServer();
  const form = await req.formData();

  const id = String(form.get("id") ?? "");
  const metal = String(form.get("metal") ?? "ZILVER");
  const picker = String(form.get("picker") ?? "");
  const status = String(form.get("status") ?? "TE_DOEN");

  const { error } = await supabase
    .from("picking_lines")
    .update({ metal, picker: picker || null, status })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.redirect(new URL("/", req.url));
}
