"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Status = "TE_DOEN" | "BEZIG" | "KLAAR";
type Metal = "ZILVER" | "STAAL";

type Store = {
  id: string;
  code: string;
  name: string;
  active?: boolean;
};

type Line = {
  id: string;
  run_id: string;
  store_id: string;
  metal: Metal;
  picker: string | null;
  status: Status;
  stores?: { code: string; name: string } | null;
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
] as const;

const STATUS_BG: Record<Status, string> = {
  TE_DOEN: "#ffffff",
  BEZIG: "#ff6b6b", // duidelijker rood
  KLAAR: "#3ddc84", // duidelijker groen
};

const STATUS_LEFT: Record<Status, string> = {
  TE_DOEN: "#e5e7eb",
  BEZIG: "#e11d48",
  KLAAR: "#16a34a",
};

function isoDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function dayLabelFromWeekday(weekday: number) {
  return DAY_OPTIONS.find((d) => d.weekday === weekday)?.label ?? "Onbekend";
}

async function postJSON<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  return data as T;
}

export default function Home() {
  // ⚠️ Geen conditionele hooks (iPhone/React hook order issues vermijden)
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  // Login form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // App state
  const [runDate, setRunDate] = useState<string>(() => isoDate(new Date()));
  const [weekday, setWeekday] = useState<number>(() => {
    // default: huidige dag -> als weekend/maandag, neem dinsdag
    const jsDay = new Date().getDay(); // 0=zo..6=za
    const map: Record<number, number> = { 0: 2, 1: 2, 2: 2, 3: 3, 4: 4, 5: 5, 6: 2 };
    return map[jsDay] ?? 2;
  });

  const [loading, setLoading] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  // debounce save queue (minder spam)
  const saveTimers = useRef<Record<string, any>>({});

  const doneCount = useMemo(() => lines.filter((l) => l.status === "KLAAR").length, [lines]);
  const totalCount = useMemo(() => lines.length, [lines]);

  // ---- Session init
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session ?? null);
      } finally {
        if (mounted) setCheckingSession(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function login() {
    setLoginBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.auth.signInWithPassword({ email, password });
      if (e) throw e;
    } catch (e: any) {
      setError(e?.message ?? "Login mislukt");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    setLines([]);
    setRunId(null);
  }

  // ---- Load data (runs/templates/lines)
  async function loadAll(dateStr: string, weekdayNum: number) {
    setLoading(true);
    setError(null);

    try {
      // 1) run ophalen of maken op run_date
      const { data: existingRun, error: runSelErr } = await supabase
        .from("picking_runs")
        .select("id")
        .eq("run_date", dateStr)
        .maybeSingle();

      if (runSelErr) throw runSelErr;

      let rid = existingRun?.id as string | undefined;

      if (!rid) {
        const { data: createdRun, error: runInsErr } = await supabase
          .from("picking_runs")
          .insert([{ run_date: dateStr, day_name: dayLabelFromWeekday(weekdayNum) }])
          .select("id")
          .single();

        if (runInsErr) throw runInsErr;
        rid = createdRun?.id;
      }

      if (!rid) throw new Error("Kon run niet maken/ophalen");
      setRunId(rid);

      // 2) templates voor die weekday -> store_id’s
      const { data: templ, error: templErr } = await supabase
        .from("picking_templates")
        .select("store_id")
        .eq("weekday", weekdayNum);

      if (templErr) throw templErr;

      const storeIds = (templ ?? []).map((t: any) => t.store_id).filter(Boolean);

      if (storeIds.length === 0) {
        setLines([]);
        return;
      }

      // 3) stores ophalen
      const { data: storeRows, error: storesErr } = await supabase
        .from("stores")
        .select("id, code, name, active")
        .in("id", storeIds);

      if (storesErr) throw storesErr;

      const stores: Store[] = (storeRows ?? []).map((s: any) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        active: s.active,
      }));

      // 4) bestaande lijnen ophalen
      const { data: existingLines, error: linesErr } = await supabase
        .from("picking_lines")
        .select("id, run_id, store_id, metal, picker, status")
        .eq("run_id", rid)
        .in("store_id", storeIds);

      if (linesErr) throw linesErr;

      // 5) missing lines aanmaken (per store: ZILVER + STAAL)
      const need: { run_id: string; store_id: string; metal: Metal; status: Status }[] = [];
      const key = (a: { store_id: string; metal: string }) => `${a.store_id}__${a.metal}`;
      const existingSet = new Set((existingLines ?? []).map((l: any) => key(l)));

      for (const s of stores) {
        for (const metal of ["ZILVER", "STAAL"] as Metal[]) {
          const k = `${s.id}__${metal}`;
          if (!existingSet.has(k)) {
            need.push({ run_id: rid, store_id: s.id, metal, status: "TE_DOEN" });
          }
        }
      }

      if (need.length > 0) {
        // Als je constraint op (run_id, store_id, metal) staat: dit werkt perfect.
        // Anders: laat me weten en ik pas dit aan naar jouw exacte constraint.
        const { error: insErr } = await supabase
          .from("picking_lines")
          .upsert(need, { onConflict: "run_id,store_id,metal" });

        if (insErr) throw insErr;
      }

      // 6) finale lijst ophalen met store info
      const { data: finalLines, error: finalErr } = await supabase
        .from("picking_lines")
        .select("id, run_id, store_id, metal, picker, status, stores(code,name)")
        .eq("run_id", rid)
        .in("store_id", storeIds);

      if (finalErr) throw finalErr;

      const sorted = (finalLines ?? []) as Line[];
      sorted.sort((a, b) => {
        const ac = a.stores?.code ?? "";
        const bc = b.stores?.code ?? "";
        if (ac !== bc) return ac.localeCompare(bc);
        // STAAL eerst? of ZILVER eerst? (nu STAAL bovenaan)
        const am = a.metal === "STAAL" ? 0 : 1;
        const bm = b.metal === "STAAL" ? 0 : 1;
        return am - bm;
      });

      setLines(sorted);
    } catch (e: any) {
      setError(e?.message ?? "Fout bij laden");
      setLines([]);
      setRunId(null);
    } finally {
      setLoading(false);
    }
  }

  // load bij wijziging datum/dag (maar enkel als ingelogd)
  useEffect(() => {
    if (!session) return;
    loadAll(runDate, weekday);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, runDate, weekday]);

  function queueSave(lineId: string, patch: Partial<Pick<Line, "picker" | "status">>) {
    // optimistisch updaten in UI
    setLines((prev) =>
      prev.map((l) => (l.id === lineId ? ({ ...l, ...patch } as Line) : l))
    );

    if (saveTimers.current[lineId]) clearTimeout(saveTimers.current[lineId]);

    saveTimers.current[lineId] = setTimeout(async () => {
      try {
        // ✅ Server-side update met service role (geen RLS/audit problemen)
        await postJSON<{ ok: true }>("/api/update-line", { id: lineId, patch });
      } catch (e: any) {
        setError(e?.message ?? "Opslaan mislukt");
        // herladen om terug consistent te worden
        if (runId) loadAll(runDate, weekday);
      }
    }, 250);
  }

  // UI helpers
  const title = useMemo(() => {
    const d = new Date(runDate + "T00:00:00");
    const day = DAY_OPTIONS.find((x) => x.weekday === weekday)?.label ?? "Picking";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `Picking — ${day} ${y}-${m}-${da}`;
  }, [runDate, weekday]);

  // ---- Render
  return (
    <div className="wrap">
      <style jsx>{`
        .wrap {
          max-width: 980px;
          margin: 0 auto;
          padding: 16px;
          font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
          color: #111827;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: flex-start;
          flex-wrap: wrap;
        }
        h1 {
          margin: 0;
          font-size: clamp(28px, 5vw, 44px);
          line-height: 1.05;
          letter-spacing: -0.02em;
        }
        .sub {
          margin-top: 8px;
          color: #374151;
          font-size: 14px;
        }
        .controls {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .ctrl {
          display: flex;
          gap: 8px;
          align-items: center;
          background: #f3f4f6;
          padding: 10px 12px;
          border-radius: 14px;
        }
        label {
          font-size: 13px;
          color: #111827;
          font-weight: 600;
          white-space: nowrap;
        }
        input[type="date"],
        select,
        input[type="text"],
        input[type="email"],
        input[type="password"] {
          font-size: 16px; /* iOS zoom fix */
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid #d1d5db;
          background: #fff;
          outline: none;
        }
        .btn {
          border: 0;
          background: #111827;
          color: #fff;
          padding: 10px 14px;
          border-radius: 12px;
          font-weight: 700;
        }
        .btn:disabled {
          opacity: 0.6;
        }
        .btnSecondary {
          border: 1px solid #d1d5db;
          background: #fff;
          color: #111827;
          padding: 10px 14px;
          border-radius: 12px;
          font-weight: 700;
        }

        .card {
          margin-top: 16px;
          background: #fff;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          overflow: hidden;
        }
        .tableHead {
          display: grid;
          grid-template-columns: 1.2fr 0.9fr 1.2fr 1fr;
          gap: 12px;
          padding: 12px 14px;
          background: #f9fafb;
          font-weight: 800;
          font-size: 13px;
          border-bottom: 1px solid #e5e7eb;
        }
        .row {
          display: grid;
          grid-template-columns: 1.2fr 0.9fr 1.2fr 1fr;
          gap: 12px;
          padding: 12px 14px;
          align-items: center;
          border-bottom: 1px solid #f1f5f9;
        }
        .row:last-child {
          border-bottom: 0;
        }
        .storeCode {
          font-weight: 900;
          font-size: 18px;
          letter-spacing: 0.02em;
        }
        .storeName {
          font-size: 12px;
          color: #6b7280;
          margin-top: 2px;
        }
        .metal {
          font-weight: 900;
          font-size: 18px;
        }
        .statusPill {
          font-weight: 900;
          border: 0;
          width: 100%;
        }
        .pickerInput {
          width: 100%;
        }
        .leftBar {
          width: 6px;
          border-radius: 999px;
          height: 100%;
        }
        .rowWrap {
          display: grid;
          grid-template-columns: 8px 1fr;
          gap: 10px;
        }

        .error {
          margin-top: 12px;
          background: #fff1f2;
          border: 1px solid #fecdd3;
          color: #9f1239;
          padding: 10px 12px;
          border-radius: 12px;
          font-weight: 700;
        }

        /* ✅ Mobile: maak er “cards” van (iPhone fix) */
        @media (max-width: 640px) {
          .card {
            border-radius: 18px;
          }
          .tableHead {
            display: none;
          }
          .row {
            grid-template-columns: 1fr;
            gap: 10px;
            padding: 12px 12px;
          }
          .rowWrap {
            grid-template-columns: 6px 1fr;
            gap: 10px;
          }
          .storeCode {
            font-size: 20px;
          }
          .metal {
            font-size: 18px;
          }
          .grid2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }
        }
      `}</style>

      <div className="topbar">
        <div>
          <h1>{title}</h1>
          <div className="sub">
            Klaar: {doneCount} / {totalCount}
            {loading ? " • Laden…" : ""}
          </div>
        </div>

        <div className="controls">
          {session && (
            <>
              <div className="ctrl">
                <label>Datum</label>
                <input
                  type="date"
                  value={runDate}
                  onChange={(e) => setRunDate(e.target.value)}
                />
              </div>

              <div className="ctrl">
                <label>Picking dag</label>
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {DAY_OPTIONS.map((d) => (
                    <option key={d.weekday} value={d.weekday}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <button className="btnSecondary" onClick={logout}>
                Logout
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/* LOGIN */}
      {!checkingSession && !session && (
        <div className="card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10 }}>Login</div>

          <div className="grid2">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>E-mail</label>
              <input
                type="email"
                value={email}
                placeholder="algemeen@..."
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label>Wachtwoord</label>
              <input
                type="password"
                value={password}
                placeholder="••••••••"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn" onClick={login} disabled={loginBusy || !email || !password}>
              {loginBusy ? "Bezig…" : "Inloggen"}
            </button>
          </div>
        </div>
      )}

      {/* LIST */}
      {session && (
        <div className="card">
          <div className="tableHead">
            <div>Winkel</div>
            <div>Metaal</div>
            <div>Picker</div>
            <div>Status</div>
          </div>

          {lines.length === 0 && !loading && (
            <div style={{ padding: 14, color: "#6b7280" }}>
              Geen winkels voor deze combinatie. (Controleer picking templates voor deze dag.)
            </div>
          )}

          {lines.map((l) => {
            const code = l.stores?.code ?? "";
            const name = l.stores?.name ?? "";
            return (
              <div key={l.id} className="rowWrap">
                <div className="leftBar" style={{ background: STATUS_LEFT[l.status] }} />
                <div
                  className="row"
                  style={{
                    background:
                      l.status === "TE_DOEN" ? "#fff" : STATUS_BG[l.status],
                    borderRadius: 12,
                  }}
                >
                  <div>
                    {/* ✅ enkel code groot, naam klein (geen CIT—CIT) */}
                    <div className="storeCode">{code}</div>
                    <div className="storeName">{name}</div>
                  </div>

                  <div className="metal">{l.metal}</div>

                  <div>
                    <input
                      className="pickerInput"
                      type="text"
                      value={l.picker ?? ""}
                      placeholder="Picker"
                      onChange={(e) => queueSave(l.id, { picker: e.target.value })}
                    />
                  </div>

                  <div>
                    <select
                      className="statusPill"
                      value={l.status}
                      onChange={(e) => queueSave(l.id, { status: e.target.value as Status })}
                      style={{
                        background: l.status === "TE_DOEN" ? "#fff" : STATUS_BG[l.status],
                        border: "1px solid #d1d5db",
                        padding: "10px 12px",
                        borderRadius: 12,
                      }}
                    >
                      <option value="TE_DOEN">Te doen</option>
                      <option value="BEZIG">Bezig</option>
                      <option value="KLAAR">Klaar</option>
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
