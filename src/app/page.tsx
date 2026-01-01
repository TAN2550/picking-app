"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, Session } from "@supabase/supabase-js";

type Store = {
  id: string;
  code: string;
  name: string;
  active?: boolean | null;
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

const STATUS_BG: Record<PickingLine["status"], string> = {
  TE_DOEN: "#ffffff",
  BEZIG: "#ff7a7a", // duidelijker rood
  KLAAR: "#7dff9b", // duidelijker groen
};

const STATUS_LEFT: Record<PickingLine["status"], string> = {
  TE_DOEN: "#e6e6e6",
  BEZIG: "#c70000",
  KLAAR: "#0b7a2a",
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

  const doneCount = lines.filter((l) => l.status === "KLAAR").length;

  const linesByStore = useMemo(() => {
    const m = new Map<string, PickingLine[]>();
    for (const l of lines) {
      const arr = m.get(l.store_id) ?? [];
      arr.push(l);
      m.set(l.store_id, arr);
    }
    // (optioneel) sorteer per metaal zodat ZILVER altijd boven STAAL staat
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => (a.metal > b.metal ? 1 : -1));
      m.set(k, arr);
    }
    return m;
  }, [lines]);

  async function ensureRunId(dateISO: string, wd: number): Promise<string> {
    // 1) bestáát run al?
    const { data: existing, error: e1 } = await supabase
      .from("picking_runs")
      .select("id")
      .eq("run_date", dateISO)
      .maybeSingle();

    if (e1) throw e1;
    if (existing?.id) return existing.id;

    // 2) anders: maak run aan (zodat TS + Vercel niet klagen en app altijd werkt)
    const { data: created, error: e2 } = await supabase
      .from("picking_runs")
      .insert({
        run_date: dateISO,
        day_name: weekdayLabel(wd),
      })
      .select("id")
      .single();

    if (e2) throw e2;
    if (!created?.id) throw new Error("Kon picking_run niet aanmaken.");
    return created.id;
  }

  async function loadAll(dateISO: string, wd: number) {
    setLoading(true);
    try {
      const runId = await ensureRunId(dateISO, wd);

      // template winkels voor gekozen weekdag
      const { data: templ, error: tErr } = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", wd);

      if (tErr) throw tErr;

      const storeIds = templ?.map((t) => t.store_id) ?? [];
      if (!storeIds.length) {
        setStores([]);
        setLines([]);
        return;
      }

      // stores ophalen (inclusief active om TS errors op Vercel te vermijden)
      const { data: storeRows, error: sErr } = await supabase
        .from("stores")
        .select("id,code,name,active")
        .in("id", storeIds);

      if (sErr) throw sErr;

      const safeStores: Store[] = (storeRows ?? []).map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        active: s.active ?? null,
      }));

      setStores(safeStores);

      // zorg dat er voor elke store 2 lijnen bestaan (ZILVER + STAAL)
      const base = safeStores.flatMap((s) => [
        { run_id: runId, store_id: s.id, metal: "ZILVER", status: "TE_DOEN" as const },
        { run_id: runId, store_id: s.id, metal: "STAAL", status: "TE_DOEN" as const },
      ]);

      // Belangrijk: dit werkt alleen als je UNIQUE hebt op (run_id, store_id, metal)
      const { error: upErr } = await supabase
        .from("picking_lines")
        .upsert(base, { onConflict: "run_id,store_id,metal" });

      if (upErr) throw upErr;

      const { data: lineRows, error: lErr } = await supabase
        .from("picking_lines")
        .select("*")
        .eq("run_id", runId);

      if (lErr) throw lErr;

      setLines((lineRows ?? []) as PickingLine[]);
    } finally {
      setLoading(false);
    }
  }

  function queueSave(id: string, patch: Partial<PickingLine>) {
    setLines((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));

    clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(async () => {
      const { error } = await supabase.from("picking_lines").update(patch).eq("id", id);
      if (error) console.error(error);
    }, 250);
  }

  useEffect(() => {
    setMounted(true);
    setRunDate(toISODate(new Date()));
  }, []);

  useEffect(() => {
    if (mounted && session && runDate) {
      loadAll(runDate, weekday).catch((e) => {
        console.error(e);
        alert(e?.message ?? "Fout bij laden");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, session, runDate, weekday]);

  if (!mounted) return <div style={{ padding: 20 }}>Laden…</div>;

  /* =======================
     LOGIN SCHERM
     ======================= */
  if (!session) {
    return (
      <div style={{ maxWidth: 360, margin: "80px auto", padding: 20 }}>
        <h2 style={{ marginBottom: 12 }}>Picking login</h2>

        <input
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", padding: 12, marginBottom: 10 }}
        />
        <input
          type="password"
          placeholder="Wachtwoord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: 12, marginBottom: 12 }}
        />

        <button
          onClick={login}
          disabled={authLoading}
          style={{ padding: "10px 14px", width: "100%" }}
        >
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
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>
            Picking – {weekdayLabel(weekday)} {runDate}
          </h1>
          <div style={{ marginTop: 6 }}>
            Klaar: {doneCount} / {lines.length} {loading ? "• Laden…" : ""}
          </div>
        </div>

        <button onClick={logout} style={{ height: 40 }}>
          Logout
        </button>
      </div>

      <div style={{ margin: "12px 0", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Datum
          <input
            type="date"
            value={runDate}
            onChange={(e) => setRunDate(e.target.value)}
            style={{ padding: 8 }}
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Picking dag
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            style={{ padding: 8, minWidth: 160 }}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d.weekday} value={d.weekday}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {stores.length === 0 ? (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          Geen winkels voor deze picking dag.
        </div>
      ) : (
        stores.map((s) => {
          const ls = linesByStore.get(s.id) ?? [];
          return ls.map((l) => (
            <div
              key={l.id}
              style={{
                display: "grid",
                gridTemplateColumns: "140px 120px 1fr 180px",
                gap: 10,
                padding: 12,
                marginBottom: 8,
                background: STATUS_BG[l.status],
                borderLeft: `8px solid ${STATUS_LEFT[l.status]}`,
                borderRadius: 8,
                alignItems: "center",
              }}
            >
              {/* enkel code zoals jij wil: CIT */}
              <strong style={{ fontSize: 16 }}>{s.code}</strong>

              <strong style={{ fontSize: 16 }}>{l.metal}</strong>

              <input
                value={l.picker ?? ""}
                placeholder="Picker"
                onChange={(e) => queueSave(l.id, { picker: e.target.value })}
                style={{ padding: 10, borderRadius: 10, border: "1px solid #bbb" }}
              />

              <select
                value={l.status}
                onChange={(e) => queueSave(l.id, { status: e.target.value as any })}
                style={{ padding: 10, borderRadius: 10, border: "1px solid #bbb" }}
              >
                <option value="TE_DOEN">Te doen</option>
                <option value="BEZIG">Bezig</option>
                <option value="KLAAR">Klaar</option>
              </select>
            </div>
          ));
        })
      )}
    </div>
  );
}
