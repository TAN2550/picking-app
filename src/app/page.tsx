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
const BRAND_WIDTH_PX = 140; // breedte van logo-blok (A en B)
const LOGIN_BRAND_WIDTH_PX = 180; // breedte van logo op login

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
  stores?: StoreMini | StoreMini[] | null; // supabase kan dit soms als array teruggeven
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
  // supabase join kan object of array geven — we vangen beide af
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
  const [runDate, setRunDate] = useState<string>(() => formatLocalYYYYMMDD(new Date()));
  const [weekday, setWeekday] = useState<number>(() => {
    const jsDay = new Date().getDay(); // zo=0
    const map: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5 };
    return map[jsDay] ?? 2; // default dinsdag
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
        runId = created.data?.id;
      }

      if (!runId) throw new Error("Geen runId gevonden/aangemaakt.");

      // 2) stores voor deze picking dag (template)
      const templ = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", weekday);

      if (templ.error) throw templ.error;

      const storeIds = (templ.data ?? []).map((t: any) => t.store_id).filter(Boolean);

      if (!storeIds.length) {
        setLines([]);
        return;
      }

      // 3) stores details
      const storesRes = await supabase
        .from("stores")
        .select("id,code,name")
        .in("id", storeIds);

      if (storesRes.error) throw storesRes.error;

      const storeRows = storesRes.data ?? [];

      // 4) Zorg dat picking_lines bestaan (2 metalen per store)
      const base = storeRows.flatMap((s: any) => [
        { run_id: runId, store_id: s.id, metal: "ZILVER", status: "TE_DOEN" as Status },
        { run_id: runId, store_id: s.id, metal: "STAAL", status: "TE_DOEN" as Status },
      ]);

      const up = await supabase.from("picking_lines").upsert(base, { onConflict: "run_id,store_id,metal" });
      if (up.error) throw up.error;

      // 5) Load lines + join store code/name
      const linesRes = await supabase
        .from("picking_lines")
        .select("id,run_id,store_id,metal,picker,status,stores:stores(code,name)")
        .eq("run_id", runId)
        .in("store_id", storeRows.map((s: any) => s.id));

      if (linesRes.error) throw linesRes.error;

      const normalized = (linesRes.data ?? []) as LineRow[];

      // sort by store code then metal (ZILVER boven STAAL)
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
        const res = await fetch("/api/update-line", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, patch }),
        });
        const json = await res.json();

        if (!res.ok) {
          throw new Error(json?.error?.message ?? json?.error ?? "Update mislukt");
        }
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

  useEffect(() => {
    if (!session) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runDate, weekday]);

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
            maxWidth: 440,
            border: "1px solid #e5e5e5",
            borderRadius: 14,
            padding: 18,
            background: "white",
          }}
        >
          {/* LOGO login */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <img
              src="/logo.png"
              alt="Twice As Nice"
              style={{
                width: LOGIN_BRAND_WIDTH_PX,
                height: "auto",
                maxWidth: "100%",
                opacity: 0.98,
              }}
            />
          </div>

          <h1 style={{ margin: 0, fontSize: 22 }}>Login</h1>
          <p style={{ marginTop: 8, color: "#666" }}>Gebruik jullie algemene account.</p>

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
              cursor: "pointer",
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
          cursor: pointer;
        }

        /* brand */
        .brandWrapStack {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 8px;
        }
        .brandWrapInline {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 10px;
        }
        .brandBox {
          width: ${BRAND_WIDTH_PX}px;
          max-width: 100%;
        }
        .brandImg {
          width: 100%;
          height: auto;
          display: block;
          opacity: 0.95;
        }

        /* Mobile layout: table -> blocks */
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

        {/* OPTIE A of B */}
        <div className={BRAND_MODE === "stack" ? "brandWrapStack" : "brandWrapInline"}>
          <button className="logout" onClick={signOut}>Logout</button>

          <div className="brandBox">
            <img src="/logo.png" alt="Twice As Nice" className="brandImg" />
          </div>
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
                const code = normalizeStoreCode(l);
                const bg = rowBg(l.status);
                const saving = !!savingIds[l.id];

                return (
                  <tr key={l.id} style={{ background: bg }}>
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
