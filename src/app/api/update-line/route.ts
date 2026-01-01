import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

/**
 * Supabase client met SERVICE ROLE
 * → bypass RLS (nodig voor audit table)
 */
function supabaseService() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false },
    }
  );
}

/**
 * Supabase client om te checken of user is ingelogd
 * (anon key + cookies)
 */
async function supabaseAuth() {
  const cookieStore = await cookies(); // ✅ FIX: await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
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

    // 1️⃣ Check login
    const authClient = await supabaseAuth();
    const { data: userData } = await authClient.auth.getUser();

    if (!userData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // 2️⃣ Update picking_lines via SERVICE ROLE
    const svc = supabaseService();

    const { error } = await svc
      .from("picking_lines")
      .update(patch)
      .eq("id", id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Server error" },
      { status: 500 }
    );
  }
}
