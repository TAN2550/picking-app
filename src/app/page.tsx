"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/** =======================
 *  INSTELLING: kies layout
 *  ======================= */
// A = logo ONDER logout (stack)
// B = logo NAAST logout (inline)
const BRAND_MODE: "stack" | "inline" = "stack";

// pas dit aan als je logo groter/kleiner wil
const BRAND_WIDTH_PX = 140;
const LOGIN_BRAND_WIDTH_PX = 180;

type Status = "TE_DOEN" | "BEZIG" | "KLAAR";
type Metal = "ZILVER" | "STAAL";

type StoreMini = { code: string; name: string };

type LineRow = {
  id: string;
  run_id: string;
  store_id: string;
  metal: Metal;
  picker: string | null;
  status: Status;
  stores?: StoreMini | StoreMini[] | null;
};

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const WEEKDAYS = [
  { value: 2, label: "Dinsdag" },
  { value: 3, label: "Woensdag" },
  { value: 4, label: "Donderdag" },
  { value: 5, label: "Vrijdag" },
];

function formatLocalYYYYMMDD(d: Date) {
  const dt = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return dt.toISOString().slice(0, 10);
}

function nlTitle(weekday: number, runDate: string) {
  const wd = WEEKDAYS.find((w) => w.value === weekday)?.label ?? "Dag";
  return `Picking – ${wd} ${runDate}`;
}

function rowBg(status: Status) {
  if (status === "KLAAR") return "rgba(0, 160, 60, 0.20)";
  if (status === "BEZIG") return "rgba(220, 0, 0, 0.18)";
  return "transparent";
}

function normalizeStoreCode(line: LineRow) {
  const s = line.stores as any;
  if (!s) return "";
  if (Array.isArray(s)) return s[0]?.code ?? "";
  return s.code ?? "";
}

export default function Home() {
  // --- Auth / session ---
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // --- Login form ---
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // --- Picking state ---
  const [runDate, setRunDate] = useState(() => formatLocalYYYYMMDD(new Date()));
  const [weekday, setWeekday] = useState<number>(() => {
    const jsDay = new Date().getDay();
    const map: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5 };
    return map[jsDay] ?? 2;
  });

  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const saveTimers = useRef<Record<string, any>>({});

  // 👉 NIEUW: actieve run voor realtime
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const klaarCount = useMemo(() => lines.filter((l) => l.status === "KLAAR").length, [lines]);
  const totalCount = useMemo(() => lines.length, [lines]);

  // --- Auth init ---
  useEffect(() => {
    let unsub: any = null;

    (async () => {
      const { data } = await supabase.auth.getSession();
      setSession(data.session ?? null);
      setAuthLoading(false);

      const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
        setSession(sess);
      });
      unsub = sub.subscription;
    })();

    return () => {
      if (unsub) unsub.unsubscribe();
    };
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setInfo("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setInfo(error.message);
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  // --- Load picking data ---
  async function load() {
    setLoading(true);
    setInfo("");

    try {
      const runRes = await supabase
        .from("picking_runs")
        .select("id")
        .eq("run_date", runDate)
        .maybeSingle();

      let runId = runRes.data?.id as string | undefined;

      if (!runId) {
        const created = await supabase
          .from("picking_runs")
          .insert({ run_date: runDate })
          .select("id")
          .single();
        runId = created.data?.id;
      }

      if (!runId) throw new Error("Geen runId");

      // 👉 NIEUW: zet actieve run voor realtime
      setActiveRunId(runId);

      const templ = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", weekday);

      const storeIds = (templ.data ?? []).map((t: any) => t.store_id);

      if (!storeIds.length) {
        setLines([]);
        return;
      }

      const storesRes = await supabase
        .from("stores")
        .select("id,code,name")
        .in("id", storeIds);

      const storeRows = storesRes.data ?? [];

      const base = storeRows.flatMap((s: any) => [
        { run_id: runId, store_id: s.id, metal: "ZILVER", status: "TE_DOEN" as Status },
        { run_id: runId, store_id: s.id, metal: "STAAL", status: "TE_DOEN" as Status },
      ]);

      await supabase.from("picking_lines").upsert(base, { onConflict: "run_id,store_id,metal" });

      const linesRes = await supabase
        .from("picking_lines")
        .select("id,run_id,store_id,metal,picker,status,stores:stores(code,name)")
        .eq("run_id", runId);

      const normalized = (linesRes.data ?? []) as LineRow[];

      normalized.sort((a, b) => {
        const ac = normalizeStoreCode(a);
        const bc = normalizeStoreCode(b);
        const c = ac.localeCompare(bc);
        if (c !== 0) return c;
        return a.metal === b.metal ? 0 : a.metal === "ZILVER" ? -1 : 1;
      });

      setLines(normalized);
    } catch (e: any) {
      setInfo(e?.message ?? "Fout bij laden");
    } finally {
      setLoading(false);
    }
  }

  function queueSave(id: string, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l) => (l.id === id ? ({ ...l, ...patch } as LineRow) : l)));

    if (saveTimers.current[id]) clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(async () => {
      setSavingIds((s) => ({ ...s, [id]: true }));
      try {
        await fetch("/api/update-line", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, patch }),
        });
      } finally {
        setSavingIds((s) => {
          const copy = { ...s };
          delete copy[id];
          return copy;
        });
      }
    }, 250);
  }

  // 🔴 🔴 🔴 REALTIME SYNCHRONISATIE 🔴 🔴 🔴
  useEffect(() => {
    if (!session || !activeRunId) return;

    const channel = supabase
      .channel(`realtime-picking-${activeRunId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "picking_lines",
          filter: `run_id=eq.${activeRunId}`,
        },
        (payload) => {
          const newRow = payload.new as LineRow;
          if (!newRow?.id) return;

          setLines((prev) => {
            const idx = prev.findIndex((l) => l.id === newRow.id);
            if (idx !== -1) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], ...newRow };
              return updated;
            }
            return prev;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, activeRunId]);

  useEffect(() => {
    if (!session) return;
    load();
  }, [session, runDate, weekday]);

  // --- UI ---
  if (authLoading) return <div style={{ padding: 16 }}>Laden…</div>;

  if (!session) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
        <form onSubmit={signIn} style={{ maxWidth: 440, width: "100%", padding: 18, border: "1px solid #eee" }}>
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <img src="/logo.png" style={{ width: LOGIN_BRAND_WIDTH_PX }} />
          </div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Wachtwoord" />
          <button type="submit">Inloggen</button>
          {info && <div>{info}</div>}
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, maxWidth: 1100, margin: "0 auto" }}>
      {/* UI ongewijzigd */}
      {/* ... rest exact hetzelfde als bij jou ... */}
    </div>
  );
}
