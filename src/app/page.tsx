"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, Session } from "@supabase/supabase-js";

type Store = {
  id: string;
  code: string;
  name: string;
  active: boolean | null;
};

type PickingLine = {
  id: string;
  run_id: string;
  store_id: string;
  metal: "ZILVER" | "STAAL";
  picker: string | null;
  status: "TE_DOEN" | "BEZIG" | "KLAAR";
};

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const DAY_OPTIONS = [
  { label: "Dinsdag", weekday: 2 },
  { label: "Woensdag", weekday: 3 },
  { label: "Donderdag", weekday: 4 },
  { label: "Vrijdag", weekday: 5 },
];

const STATUS_BG = {
  TE_DOEN: "#ffffff",
  BEZIG: "#ffb3b3",
  KLAAR: "#bfffd0",
};

const STATUS_LEFT = {
  TE_DOEN: "#e6e6e6",
  BEZIG: "#d72626",
  KLAAR: "#1f8f3a",
};

function toISODate(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function weekdayLabel(w: number) {
  return DAY_OPTIONS.find((d) => d.weekday === w)?.label ?? "";
}

export default function Home() {
  /* =======================
     AUTH (1 algemene login)
     ======================= */
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  /* =======================
     APP STATE
     ======================= */
  const [mounted, setMounted] = useState(false);
  const [runDate, setRunDate] = useState("");
  const [weekday, setWeekday] = useState(2);
  const [loading, setLoading] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [lines, setLines] = useState<PickingLine[]>([]);
  const saveTimers = useRef<Record<string, any>>({});

  /* =======================
     AUTH INIT
     ======================= */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  /* =======================
     LOGIN HANDLERS
     ======================= */
  async function login() {
    setAuthLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setAuthLoading(false);
    if (error) alert(error.message);
  }

  async function logout() {
    await supabase.auth.signOut();
    setSession(null);
  }

  /* =======================
     DATA LOGIC
     ======================= */
  const doneCount = lines.filter((l) => l.status === "KLAAR").length;

  const linesByStore = useMemo(() => {
    const m = new Map<string, PickingLine[]>();
    for (const l of lines) {
      const arr = m.get(l.store_id) ?? [];
      arr.push(l);
      m.set(l.store_id, arr);
    }
    return m;
  }, [lines]);

  async function loadAll(dateISO: string, wd: number) {
    setLoading(true);
    try {
      const { data: run } = await supabase
        .from("picking_runs")
        .select("id")
        .eq("run_date", dateISO)
        .maybeSingle();

      let runId = run?.id;

      const { data: runRow, error: runErr } = await supabase
  .from("picking_runs")
  .select("id")
  .eq("run_date", runDate)
  .single();

if (runErr || !runRow) {
  throw new Error(runErr?.message ?? "Geen picking_run gevonden voor deze datum.");
}

runId = runRow.id;


      const { data: templ } = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", wd);

      const storeIds = templ?.map((t) => t.store_id) ?? [];
      if (!storeIds.length) {
        setStores([]);
        setLines([]);
        return;
      }

      const { data: storeRows } = await supabase
        .from("stores")
        .select("id,code,name")
        .in("id", storeIds);

      setStores(storeRows ?? []);

      const base = storeRows!.flatMap((s) => [
        { run_id: runId, store_id: s.id, metal: "ZILVER", status: "TE_DOEN" },
        { run_id: runId, store_id: s.id, metal: "STAAL", status: "TE_DOEN" },
      ]);

      await supabase
        .from("picking_lines")
        .upsert(base, { onConflict: "run_id,store_id,metal" });

      const { data: lineRows } = await supabase
        .from("picking_lines")
        .select("*")
        .eq("run_id", runId);

      setLines(lineRows ?? []);
    } finally {
      setLoading(false);
    }
  }

  function queueSave(id: string, patch: Partial<PickingLine>) {
    setLines((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(() => {
      supabase.from("picking_lines").update(patch).eq("id", id);
    }, 300);
  }

  useEffect(() => {
    setMounted(true);
    setRunDate(toISODate(new Date()));
  }, []);

  useEffect(() => {
    if (mounted && session && runDate) loadAll(runDate, weekday);
  }, [mounted, session, runDate, weekday]);

  if (!mounted) return <div style={{ padding: 20 }}>Laden…</div>;

  /* =======================
     LOGIN SCHERM
     ======================= */
  if (!session) {
    return (
      <div style={{ maxWidth: 360, margin: "100px auto", padding: 20 }}>
        <h2>Picking login</h2>
        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10 }}
        />
        <input
          type="password"
          placeholder="Wachtwoord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10 }}
        />
        <button onClick={login} disabled={authLoading}>
          {authLoading ? "Inloggen…" : "Login"}
        </button>
      </div>
    );
  }

  /* =======================
     APP
     ======================= */
  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>
          Picking – {weekdayLabel(weekday)} {runDate}
        </h1>
        <button onClick={logout}>Logout</button>
      </div>

      <div>
        Klaar: {doneCount} / {lines.length} {loading && "• Laden…"}
      </div>

      <div style={{ margin: "12px 0", display: "flex", gap: 12 }}>
        <input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
        <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
          {DAY_OPTIONS.map((d) => (
            <option key={d.weekday} value={d.weekday}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {stores.map((s) => {
        const ls = linesByStore.get(s.id) ?? [];
        return ls.map((l) => (
          <div
            key={l.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 0.6fr 1fr 0.8fr",
              gap: 8,
              padding: 10,
              marginBottom: 6,
              background: STATUS_BG[l.status],
              borderLeft: `6px solid ${STATUS_LEFT[l.status]}`,
            }}
          >
            <strong>{s.code}</strong>
            <strong>{l.metal}</strong>

            <input
              value={l.picker ?? ""}
              placeholder="Picker"
              onChange={(e) => queueSave(l.id, { picker: e.target.value })}
            />

            <select
              value={l.status}
              onChange={(e) => queueSave(l.id, { status: e.target.value as any })}
            >
              <option value="TE_DOEN">Te doen</option>
              <option value="BEZIG">Bezig</option>
              <option value="KLAAR">Klaar</option>
            </select>
          </div>
        ));
      })}
    </div>
  );
}
