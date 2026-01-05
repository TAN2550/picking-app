"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";

/** =======================
 *  BRAND / LAYOUT
 *  ======================= */
const BRAND_MODE: "stack" | "inline" = "stack";
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
  // join
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
  if (status === "KLAAR") return "rgba(0, 170, 70, 0.28)";
  if (status === "BEZIG") return "rgba(230, 0, 0, 0.25)";
  return "transparent";
}

function normalizeStore(line: LineRow): StoreMini | null {
  const s = line.stores as any;
  if (!s) return null;
  if (Array.isArray(s)) return s[0] ?? null;
  return s ?? null;
}

function storeLabel(line: LineRow) {
  const s = normalizeStore(line);
  if (!s) return "";
  return (s.code ?? "").toUpperCase();
}

function makeKey(store_id: string, metal: Metal) {
  return `${store_id}__${metal}`;
}

export default function Home() {
  // --- Auth / session ---
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // --- Login form ---
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // --- Picking filters ---
  const [runDate, setRunDate] = useState(() => formatLocalYYYYMMDD(new Date()));
  const [weekday, setWeekday] = useState<number>(() => {
    const jsDay = new Date().getDay(); // 0=Sun
    const map: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5 };
    return map[jsDay] ?? 2;
  });

  // --- Data ---
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const saveTimers = useRef<Record<string, any>>({});

  // ✅ huidige run_id
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const klaarCount = useMemo(() => lines.filter((l) => l.status === "KLAAR").length, [lines]);
  const totalCount = useMemo(() => lines.length, [lines]);

  // -----------------------
  // AUTH INIT
  // -----------------------
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

  // -----------------------
  // LOAD (ZONDER DUPLICATES / ZONDER RESET)
  // -----------------------
  async function load() {
    setLoading(true);
    setInfo("");

    try {
      // 1) Get/Create run for date
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

      if (!runId) throw new Error("Geen runId gevonden/gemaakt.");
      setActiveRunId(runId);

      // 2) Get template stores for weekday
      const templ = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", weekday);

      const storeIds: string[] = (templ.data ?? []).map((t: any) => t.store_id);

      if (!storeIds.length) {
        setLines([]);
        return;
      }

      // 3) Haal bestaande lines op voor deze run + stores
      //    (BELANGRIJK: we maken enkel ontbrekende combinaties aan — geen upsert)
      const existingRes = await supabase
        .from("picking_lines")
        .select("id,run_id,store_id,metal,picker,status,stores:stores(code,name)")
        .eq("run_id", runId)
        .in("store_id", storeIds);

      const existing = (existingRes.data ?? []) as LineRow[];

      const existingKeys = new Set<string>();
      for (const l of existing) existingKeys.add(makeKey(l.store_id, l.metal));

      const toInsert: Array<{ run_id: string; store_id: string; metal: Metal }> = [];
      for (const store_id of storeIds) {
        for (const metal of ["ZILVER", "STAAL"] as Metal[]) {
          const key = makeKey(store_id, metal);
          if (!existingKeys.has(key)) {
            toInsert.push({ run_id: runId, store_id, metal });
          }
        }
      }

      if (toInsert.length) {
        const ins = await supabase.from("picking_lines").insert(toInsert);
        if (ins.error) {
          // als insert faalt: toon fout (maar crash niet)
          console.error("Insert missing picking_lines error", ins.error);
          setInfo(ins.error.message);
        }
      }

      // 4) Final fetch (met stores join)
      const linesRes = await supabase
        .from("picking_lines")
        .select("id,run_id,store_id,metal,picker,status,stores:stores(code,name)")
        .eq("run_id", runId)
        .in("store_id", storeIds);

      const normalized = (linesRes.data ?? []) as LineRow[];

      // sort by store code then metal
      normalized.sort((a, b) => {
        const ac = storeLabel(a);
        const bc = storeLabel(b);
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

  // laad bij start en bij filterwijziging
  useEffect(() => {
    if (!session) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runDate, weekday]);

  // -----------------------
  // SAVE (via jouw route)
  // -----------------------
  function queueSave(id: string, patch: Partial<LineRow>) {
    // optimistic UI
    setLines((prev) => prev.map((l) => (l.id === id ? ({ ...l, ...patch } as LineRow) : l)));

    if (saveTimers.current[id]) clearTimeout(saveTimers.current[id]);

    saveTimers.current[id] = setTimeout(async () => {
      setSavingIds((s) => ({ ...s, [id]: true }));
      try {
        const res = await fetch("/api/update-line", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, patch }),
        });

        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          console.error("update-line error", json);
          setInfo(json?.error ?? "Opslaan mislukt");
          // Bij fout: haal opnieuw op zodat UI niet “terugspringt” raar
          load();
          return;
        }

        // Als server data terugstuurt: update state met de “truth”
        if (json?.data?.id) {
          const newRow = json.data;
          setLines((prev) => {
            const idx = prev.findIndex((l) => l.id === newRow.id);
            if (idx === -1) return prev;
            const keepStores = prev[idx].stores;
            const merged: LineRow = { ...prev[idx], ...newRow, stores: keepStores };
            const copy = [...prev];
            copy[idx] = merged;
            return copy;
          });
        }
      } finally {
        setSavingIds((s) => {
          const copy = { ...s };
          delete copy[id];
          return copy;
        });
      }
    }, 250);
  }

  // -----------------------
  // ✅ REALTIME (LIVE SYNC)
  // -----------------------
  useEffect(() => {
    if (!session || !activeRunId) return;

    const channel = supabase
      .channel(`realtime-picking-lines-${activeRunId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "picking_lines",
          filter: `run_id=eq.${activeRunId}`,
        },
        (payload) => {
          const eventType = payload.eventType;
          const newRow = payload.new as any;
          const oldRow = payload.old as any;

          setLines((prev) => {
            // DELETE
            if (eventType === "DELETE") {
              const id = oldRow?.id;
              if (!id) return prev;
              return prev.filter((l) => l.id !== id);
            }

            // INSERT/UPDATE
            const id = newRow?.id;
            if (!id) return prev;

            const idx = prev.findIndex((l) => l.id === id);

            // INSERT (nog niet in lijst)
            if (idx === -1) {
              // payload heeft geen join "stores" → we voegen toe zonder stores
              const appended: LineRow = {
                id: newRow.id,
                run_id: newRow.run_id,
                store_id: newRow.store_id,
                metal: newRow.metal,
                picker: newRow.picker ?? null,
                status: newRow.status,
                stores: null,
              };

              const copy = [...prev, appended];

              // sort opnieuw (code kan leeg zijn als stores ontbreekt, maar ok)
              copy.sort((a, b) => {
                const ac = storeLabel(a);
                const bc = storeLabel(b);
                const c = ac.localeCompare(bc);
                if (c !== 0) return c;
                return a.metal === b.metal ? 0 : a.metal === "ZILVER" ? -1 : 1;
              });

              return copy;
            }

            // UPDATE (bestaat al)
            const keepStores = prev[idx].stores;
            const merged: LineRow = { ...prev[idx], ...newRow, stores: keepStores };
            const updated = [...prev];
            updated[idx] = merged;
            return updated;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session, activeRunId]);

  // -----------------------
  // UI
  // -----------------------
  if (authLoading) return <div style={{ padding: 16 }}>Laden…</div>;

  if (!session) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
        <form
          onSubmit={signIn}
          style={{
            maxWidth: 460,
            width: "100%",
            padding: 18,
            border: "1px solid #eee",
            borderRadius: 12,
            background: "#fff",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <img src="/logo.png" alt="Logo" style={{ width: LOGIN_BRAND_WIDTH_PX }} />
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="username"
              style={{ padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Wachtwoord"
              autoComplete="current-password"
              style={{ padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
            />
            <button
              type="submit"
              style={{
                padding: 10,
                borderRadius: 10,
                border: "1px solid #111",
                background: "#111",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Inloggen
            </button>
            {info && <div style={{ color: "#b00020" }}>{info}</div>}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{nlTitle(weekday, runDate)}</div>
          <div style={{ marginTop: 4, color: "#666" }}>
            Klaar: <b>{klaarCount}</b> / {totalCount}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button
            onClick={signOut}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Logout
          </button>

          {BRAND_MODE === "inline" ? (
            <img src="/logo.png" alt="Logo" style={{ width: BRAND_WIDTH_PX }} />
          ) : null}
        </div>
      </div>

      {BRAND_MODE === "stack" ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -6, marginBottom: 12 }}>
          <img src="/logo.png" alt="Logo" style={{ width: BRAND_WIDTH_PX }} />
        </div>
      ) : null}

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "#444" }}>Datum</span>
          <input
            type="date"
            value={runDate}
            onChange={(e) => setRunDate(e.target.value)}
            style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd" }}
          />
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ color: "#444" }}>Dag</span>
          <select
            value={weekday}
            onChange={(e) => setWeekday(parseInt(e.target.value, 10))}
            style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd" }}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={load}
          disabled={loading}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          {loading ? "Laden…" : "Refresh"}
        </button>

        {info && <div style={{ color: "#b00020" }}>{info}</div>}
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Winkel</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Metaal</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Picker</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Status</th>
              <th style={{ padding: 10, borderBottom: "1px solid #eee" }}></th>
            </tr>
          </thead>

          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 14, color: "#666" }}>
                  Geen winkels voor deze dag.
                </td>
              </tr>
            ) : (
              lines.map((line) => {
                const store = normalizeStore(line);
                const saving = !!savingIds[line.id];

                return (
                  <tr key={line.id} style={{ background: rowBg(line.status) }}>
                    <td style={{ padding: 10, borderBottom: "1px solid #f2f2f2", fontWeight: 700 }}>
                      {store?.code?.toUpperCase() ?? ""}
                      <div style={{ fontWeight: 400, color: "#666", fontSize: 12 }}>
                        {store?.name ?? ""}
                      </div>
                    </td>

                    <td style={{ padding: 10, borderBottom: "1px solid #f2f2f2" }}>{line.metal}</td>

                    <td style={{ padding: 10, borderBottom: "1px solid #f2f2f2" }}>
                      <input
                        value={line.picker ?? ""}
                        onChange={(e) => queueSave(line.id, { picker: e.target.value })}
                        placeholder="Naam"
                        style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd", width: "100%" }}
                      />
                    </td>

                    <td style={{ padding: 10, borderBottom: "1px solid #f2f2f2" }}>
                      <select
                        value={line.status}
                        onChange={(e) => queueSave(line.id, { status: e.target.value as Status })}
                        style={{ padding: 8, borderRadius: 10, border: "1px solid #ddd", width: "100%" }}
                      >
                        <option value="TE_DOEN">Te doen</option>
                        <option value="BEZIG">Bezig</option>
                        <option value="KLAAR">Klaar</option>
                      </select>
                    </td>

                    <td style={{ padding: 10, borderBottom: "1px solid #f2f2f2", color: "#666", fontSize: 12 }}>
                      {saving ? "Opslaan…" : ""}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
        Tip: status <b>Bezig</b> = rood, <b>Klaar</b> = groen.
      </div>
    </div>
  );
}
