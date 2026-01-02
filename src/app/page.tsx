"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Status = "TE_DOEN" | "BEZIG" | "KLAAR";
type Metal = "ZILVER" | "STAAL";

type StoreRow = { id: string; code: string; name: string; active?: boolean };
type LineRow = {
  id: string;
  run_id: string;
  store_id: string;
  metal: Metal;
  picker: string | null;
  status: Status;
  stores?: { code: string; name: string } | null;
};

const WEEKDAYS: { label: string; value: number }[] = [
  { label: "Dinsdag", value: 2 },
  { label: "Woensdag", value: 3 },
  { label: "Donderdag", value: 4 },
  { label: "Vrijdag", value: 5 },
];

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function formatLocalYYYYMMDD(d: Date) {
  // Local date (geen UTC shift!)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nlTitle(weekday: number, runDate: string) {
  const map: Record<number, string> = { 2: "Dinsdag", 3: "Woensdag", 4: "Donderdag", 5: "Vrijdag" };
  return `Picking – ${map[weekday] ?? "Dag"} ${runDate}`;
}

function rowBg(status: Status) {
  // Duidelijker rood/groen
  if (status === "KLAAR") return "rgba(0, 160, 60, 0.30)";
  if (status === "BEZIG") return "rgba(220, 0, 0, 0.25)";
  return "transparent";
}

export default function Home() {
  const supabase = useMemo(() => supabaseBrowser(), []);

  // --- Auth / session ---
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // --- Login form ---
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // --- Picking state ---
  const [runDate, setRunDate] = useState<string>(() => formatLocalYYYYMMDD(new Date()));
  const [weekday, setWeekday] = useState<number>(() => {
    const jsDay = new Date().getDay(); // 0..6 (zo=0)
    const map: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5 };
    // als weekend/maandag: default dinsdag
    return map[jsDay] ?? 2;
  });

  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string>("");
  const [lines, setLines] = useState<LineRow[]>([]);
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});

  const saveTimers = useRef<Record<string, any>>({});

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
  }, [supabase]);

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
      // 1) Find or create run
      const runRes = await supabase
        .from("picking_runs")
        .select("id")
        .eq("run_date", runDate)
        .maybeSingle();

      if (runRes.error) throw runRes.error;

      let runId = runRes.data?.id as string | undefined;

      if (!runId) {
        const created = await supabase
          .from("picking_runs")
          .insert({ run_date: runDate })
          .select("id")
          .single();
        if (created.error) throw created.error;
        runId = created.data.id;
      }

      // 2) template stores voor gekozen weekday
      const templ = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", weekday);

      if (templ.error) throw templ.error;

      const storeIds = (templ.data ?? []).map((t: any) => t.store_id).filter(Boolean);

      if (storeIds.length === 0) {
        setLines([]);
        setInfo("Geen winkels in template voor deze picking dag.");
        return;
      }

      // 3) existing lines?
      const existing = await supabase
        .from("picking_lines")
        .select("id, run_id, store_id, metal, picker, status, stores(code,name)")
        .eq("run_id", runId)
        .in("store_id", storeIds);

      if (existing.error) throw existing.error;

      if ((existing.data ?? []).length === 0) {
        // 4) create base lines (2x per store)
        const base = storeIds.flatMap((sid: string) => [
          { run_id: runId, store_id: sid, metal: "ZILVER", status: "TE_DOEN" as Status },
          { run_id: runId, store_id: sid, metal: "STAAL", status: "TE_DOEN" as Status },
        ]);

        // onConflict vereist UNIQUE(run_id, store_id, metal)
        const up = await supabase
          .from("picking_lines")
          .upsert(base, { onConflict: "run_id,store_id,metal" });

        if (up.error) throw up.error;

        // reload
        const reload = await supabase
          .from("picking_lines")
          .select("id, run_id, store_id, metal, picker, status, stores(code,name)")
          .eq("run_id", runId)
          .in("store_id", storeIds);

        if (reload.error) throw reload.error;
        setLines(sortLines(reload.data as any));
      } else {
        setLines(sortLines(existing.data as any));
      }
    } catch (e: any) {
      console.error(e);
      setInfo(e?.message ?? "Fout bij laden");
    } finally {
      setLoading(false);
    }
  }

  function sortLines(arr: LineRow[]) {
    const metalOrder: Record<string, number> = { ZILVER: 0, STAAL: 1 };
    return [...arr].sort((a, b) => {
      const ac = a.stores?.code ?? "";
      const bc = b.stores?.code ?? "";
      if (ac !== bc) return ac.localeCompare(bc);
      return (metalOrder[a.metal] ?? 9) - (metalOrder[b.metal] ?? 9);
    });
  }

  // auto load bij change
  useEffect(() => {
    if (!session) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runDate, weekday]);

  // --- Save (debounced) ---
  function queueSave(id: string, patch: Partial<Pick<LineRow, "picker" | "status">>) {
    // optimistic update
    setLines((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...patch } as LineRow : l))
    );

    // debounce per row
    if (saveTimers.current[id]) clearTimeout(saveTimers.current[id]);
    saveTimers.current[id] = setTimeout(async () => {
      setSavingIds((s) => ({ ...s, [id]: true }));
      try {
        const res = await fetch("/api/update-line", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, patch }),
        });
        const json = await res.json();

        if (!res.ok) {
          throw new Error(json?.error?.message ?? json?.error ?? "Update mislukt");
        }
        // auditError niet blokkeren
      } catch (e: any) {
        alert(e?.message ?? "Fout bij opslaan");
      } finally {
        setSavingIds((s) => {
          const copy = { ...s };
          delete copy[id];
          return copy;
        });
      }
    }, 250);
  }

  // --- UI ---
  if (authLoading) {
    return <div style={{ padding: 16, fontFamily: "system-ui" }}>Laden…</div>;
  }

  if (!session) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, fontFamily: "system-ui" }}>
        <form
          onSubmit={signIn}
          style={{
            width: "100%",
            maxWidth: 420,
            border: "1px solid #e5e5e5",
            borderRadius: 12,
            padding: 16,
            background: "white",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 22 }}>Login</h1>
          <p style={{ marginTop: 8, color: "#666" }}>
            Gebruik jullie algemene account.
          </p>

          <label style={{ display: "block", marginTop: 12, fontSize: 14 }}>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
            autoComplete="username"
          />

          <label style={{ display: "block", marginTop: 12, fontSize: 14 }}>Wachtwoord</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
            autoComplete="current-password"
          />

          <button
            type="submit"
            style={{
              marginTop: 14,
              width: "100%",
              padding: 12,
              borderRadius: 10,
              border: "0",
              background: "#111",
              color: "white",
              fontWeight: 700,
            }}
          >
            Inloggen
          </button>

          {info ? <div style={{ marginTop: 12, color: "crimson" }}>{info}</div> : null}
        </form>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 14, maxWidth: 1100, margin: "0 auto" }}>
      <style>{`
        .topbar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .filters {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }
        .card {
          border: 1px solid #e7e7e7;
          border-radius: 14px;
          overflow: hidden;
          background: white;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          padding: 10px;
          border-top: 1px solid #eee;
          vertical-align: middle;
        }
        th {
          text-align: left;
          font-size: 13px;
          color: #444;
          background: #fafafa;
          border-top: 0;
        }
        .storeCode {
          font-weight: 800;
          letter-spacing: 0.5px;
        }
        .pill {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 999px;
          background: #f2f2f2;
          font-size: 13px;
        }
        .input, .select {
          width: 100%;
          max-width: 260px;
          padding: 10px;
          border-radius: 12px;
          border: 1px solid #cfcfcf;
          background: white;
        }
        .select { max-width: 220px; }
        .logout {
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid #ddd;
          background: #f6f6f6;
          font-weight: 700;
        }

        /* Mobile layout: table -> cards */
        @media (max-width: 720px) {
          h1 { font-size: 40px !important; line-height: 1.02; }
          .input, .select { max-width: none; }
          table, thead, tbody, th, td, tr { display: block; }
          thead { display: none; }
          tr {
            border-top: 1px solid #eee;
            padding: 10px;
          }
          td { border: 0; padding: 6px 0; }
          .rowGrid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px 10px;
            align-items: center;
          }
          .rowGrid .full { grid-column: 1 / -1; }
          .storeCode { font-size: 18px; }
        }
      `}</style>

      <div className="topbar">
        <div>
          <h1 style={{ margin: 0, fontSize: 56 }}>{nlTitle(weekday, runDate)}</h1>
          <div style={{ marginTop: 6, color: "#444" }}>
            <span className="pill">Klaar: {klaarCount} / {totalCount}</span>
            {loading ? <span style={{ marginLeft: 10, color: "#666" }}>Laden…</span> : null}
            {info ? <span style={{ marginLeft: 10, color: "crimson" }}>{info}</span> : null}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
  <button className="logout" onClick={signOut}>Logout</button>
  <img
    src="/logo.png"
    alt="Twice As Nice"
    style={{ height: 26, width: "auto", opacity: 0.95 }}
  />
</div>
      </div>

      <div className="filters" style={{ marginTop: 14 }}>
        <label style={{ fontWeight: 700 }}>Datum</label>
        <input
          type="date"
          value={runDate}
          onChange={(e) => setRunDate(e.target.value)}
          className="input"
          style={{ maxWidth: 180 }}
        />

        <label style={{ fontWeight: 700 }}>Picking dag</label>
        <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} className="select">
          {WEEKDAYS.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 180 }}>Winkel</th>
              <th style={{ width: 140 }}>Metaal</th>
              <th>Picker</th>
              <th style={{ width: 220 }}>Status</th>
            </tr>
          </thead>

          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: 16, color: "#666" }}>
                  Geen winkels. (Check template voor deze picking dag.)
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const code = l.stores?.code ?? "";
                const bg = rowBg(l.status);
                const saving = !!savingIds[l.id];

                return (
                  <tr key={l.id} style={{ background: bg }}>
                    {/* Desktop cells */}
                    <td>
                      <span className="storeCode">{code}</span>
                    </td>
                    <td style={{ fontWeight: 800 }}>{l.metal}</td>
                    <td>
                      <input
                        className="input"
                        value={l.picker ?? ""}
                        placeholder="Picker"
                        onChange={(e) => queueSave(l.id, { picker: e.target.value })}
                        style={{ opacity: saving ? 0.65 : 1 }}
                      />
                    </td>
                    <td>
                      <select
                        className="select"
                        value={l.status}
                        onChange={(e) => queueSave(l.id, { status: e.target.value as Status })}
                        style={{ opacity: saving ? 0.65 : 1 }}
                      >
                        <option value="TE_DOEN">Te doen</option>
                        <option value="BEZIG">Bezig</option>
                        <option value="KLAAR">Klaar</option>
                      </select>

                      {/* Mobile extra layout helper */}
                      <div className="rowGrid" style={{ display: "none" }}>
                        {/* blijft leeg; alleen voor media-query block layout */}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, color: "#666", fontSize: 13 }}>
        Tip: status <b>Bezig</b> = rood, <b>Klaar</b> = groen. Alles wordt automatisch opgeslagen.
      </div>
    </div>
  );
}
