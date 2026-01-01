import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

function supabaseService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

function supabaseAuth() {
  // Leest de ingelogde user via cookies (anon key)
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // Next route handlers laten dit toe (server-side cookies)
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { id, patch } = body ?? {};

    if (!id || !patch || typeof patch !== "object") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    // 1) Check: moet ingelogd zijn
    const authClient = supabaseAuth();
    const { data: userData } = await authClient.auth.getUser();
    if (!userData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // 2) Update met service role (bypassed RLS + audit trigger mag doen wat nodig is)
    const svc = supabaseService();
    const { error: updErr } = await svc.from("picking_lines").update(patch).eq("id", id);
    if (updErr) throw updErr;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
