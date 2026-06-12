// ─── Bench Radar + Suggest-work modal (shared) ───
// Lives in the Delivery Engine page (moved out of the Availability Engine at
// the owner's request). Kept as its own module so either page could mount it.
//
// BenchRadarPanel — upcoming roll-offs: people who are effectively booked
// today (>=80% allocated) whose forward-planned allocation drops to <=50%
// within the horizon. Each row's "Find work" opens SuggestWorkModal: Satori
// proposes skill-anchored task ideas for that person (department-tailored
// when no skills are tagged); each idea can be saved straight to Saved Tasks
// with the person assigned. Deliberately decoupled from Find Best Fit.
//
// Props:
//   BenchRadarPanel { onOpen?, onFindWork, department? } — onOpen optional;
//     when omitted the name renders as plain text (no employee drill-in).
//   SuggestWorkModal { item, onClose, onSaved? }

import { useState, useEffect, useRef } from "react";
import { Radar, ChevronRight, Sparkles, X, Loader2, CheckCircle, Plus } from "lucide-react";
import SatoriAvatar from "./SatoriAvatar.jsx";

const API_BASE = import.meta.env.VITE_API_BASE || "";

const C = {
  accent:        "#8AC441",
  accentDark:    "#68933F",
  surface:       "var(--c-surface)",
  surfaceAlt:    "var(--c-surface-alt)",
  border:        "var(--c-border)",
  textPrimary:   "var(--c-text-primary)",
  textSecondary: "var(--c-text-secondary)",
  textMuted:     "var(--c-text-muted)",
};

const fetchJson = async (url, options = {}) => {
  const token = localStorage.getItem("token");
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.detail || j.error || detail; } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
};

const cleanName = (emp) => {
  const raw = (emp?.name || "").trim();
  if (emp?.code) {
    const esc = String(emp.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = raw.replace(new RegExp("^" + esc + "\\s*[-–—]?\\s*", "i"), "");
    if (stripped !== raw) return stripped.trim() || raw;
  }
  const stripped = raw.replace(/^[A-Za-z]{1,4}-\d+\s*[-–—]?\s*/, "");
  return stripped.trim() || raw || "—";
};

export const rolloffContext = (it) =>
  `${cleanName(it)} (${it.code}${it.dept ? `, ${it.dept}` : ""}${it.position ? `, ${it.position}` : ""}) ` +
  `rolls off ${(it.current_projects || []).slice(0, 2).join(", ") || "their current project"} ` +
  `around the week of ${it.rolloff_week} (${it.current_pct}% → ${it.pct_at_rolloff}% allocated).`;

export const SuggestWorkModal = ({ item, onClose, onSaved }) => {
  const [sugs, setSugs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);      // bump = "More ideas" re-roll
  const [savedIdx, setSavedIdx] = useState(new Set());
  const [savingIdx, setSavingIdx] = useState(null);

  useEffect(() => {
    if (!item) { setSugs(null); setError(null); setSavedIdx(new Set()); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null); setSugs(null); setSavedIdx(new Set());
      try {
        const r = await fetchJson("/api/availability/suggest-work", {
          method: "POST",
          body: JSON.stringify({
            code: item.code, name: item.name, department: item.dept,
            position: item.position, current_projects: item.current_projects || [],
          }),
        });
        if (!cancelled) setSugs(r.suggestions || []);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [item, nonce]);

  const saveAsTask = async (s, i) => {
    if (savingIdx != null || !item) return;
    setSavingIdx(i);
    try {
      await fetchJson("/api/availability/tasks", {
        method: "POST",
        body: JSON.stringify({
          name: s.title,
          description: `${s.description} ${rolloffContext(item)}`,
          skills: s.skills || "",
          department: item.dept || "",
          assigned_employee_codes: [item.code],
          ai_reasoning: {
            [item.code]: {
              rank: 1,
              reasoning: s.description,
              name: item.name || null,
              position: item.position || null,
              department: item.dept || null,
            },
          },
        }),
      });
      setSavedIdx(prev => { const n = new Set(prev); n.add(i); return n; });
      onSaved && onSaved();
    } catch (e) {
      alert("Failed to save task: " + (e.message || e));
    } finally {
      setSavingIdx(null);
    }
  };

  if (!item) return null;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1100,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 640, maxHeight: "86vh",
        display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        <div style={{ padding: "18px 22px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 14 }}>
          <SatoriAvatar state={loading ? "thinking" : "idle"} size={52} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: C.textPrimary }}>
              What should {cleanName(item)} do next?
            </h2>
            <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 3 }}>
              {loading ? "Looking at their skills, role and current projects…"
                : "Where they'd do great next — matched to their skills and department."}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          {loading && (
            <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
              <Loader2 size={22} className="spin" />
              <div style={{ marginTop: 8 }}>Generating ideas for {cleanName(item)}…</div>
            </div>
          )}
          {error && (
            <div style={{ padding: "10px 14px", background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)", borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}
          {!loading && (sugs || []).map((s, i) => (
            <div key={i} style={{
              padding: "14px 16px", marginBottom: 10,
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>{s.title}</div>
              <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5, marginTop: 5 }}>{s.description}</div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10, marginTop: 9 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {(s.skills || "").split(",").map(sk => sk.trim()).filter(Boolean).slice(0, 6).map(sk => (
                    <span key={sk} style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: `${C.accent}18`, color: C.accentDark }}>{sk}</span>
                  ))}
                </div>
                {savedIdx.has(i) ? (
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--sem-ok-fg)", display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    <CheckCircle size={13} /> Saved to tasks
                  </span>
                ) : (
                  <button onClick={() => saveAsTask(s, i)} disabled={savingIdx != null}
                    title={`Save as a task assigned to ${cleanName(item)}`} style={{
                      padding: "5px 11px", borderRadius: 8, border: `1px solid ${C.accent}55`,
                      background: `${C.accent}12`, color: C.accentDark, fontWeight: 700, fontSize: 11.5,
                      cursor: savingIdx != null ? "default" : "pointer", whiteSpace: "nowrap", flexShrink: 0,
                      display: "inline-flex", alignItems: "center", gap: 4, opacity: savingIdx != null && savingIdx !== i ? 0.5 : 1,
                    }}>
                    {savingIdx === i ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Save as task
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: "12px 22px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: C.surfaceAlt }}>
          <button onClick={() => setNonce(n => n + 1)} disabled={loading} style={{
            padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 13,
            cursor: loading ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6,
            opacity: loading ? 0.6 : 1,
          }}><Sparkles size={13} /> More ideas</button>
          <button onClick={onClose} style={{
            padding: "9px 16px", borderRadius: 8, border: "none",
            background: C.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer",
          }}>Done</button>
        </div>
      </div>
    </div>
  );
};

export const BenchRadarPanel = ({ onOpen, onFindWork, department }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const autoOpened = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson(`/api/availability/bench-radar?weeks=8&department=${encodeURIComponent(department || "")}`);
        if (!cancelled) {
          setData(d);
          // Auto-expand once when someone frees up within a fortnight.
          if (!autoOpened.current && (d.items || []).some(i => i.weeks_until <= 2)) {
            autoOpened.current = true;
            setOpen(true);
          }
        }
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, [department]);

  if (error || !data) return null; // radar is additive — never block the page
  const items = data.items || [];
  const fmtWk = (iso) => {
    try { return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
    catch { return iso; }
  };

  return (
    <div data-tour="bench-radar" style={{ marginBottom: 20, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: "100%", padding: "12px 16px", border: "none", background: "transparent", color: C.textPrimary,
        display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontWeight: 700, fontSize: 14,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Radar size={16} style={{ color: C.accentDark }} /> Bench Radar
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: items.length ? "var(--sem-warn-bg)" : C.surfaceAlt, color: items.length ? "var(--sem-warn-fg)" : C.textMuted }}>
            {items.length ? `${items.length} rolling off in the next ${data.weeks_horizon} weeks` : `no roll-offs in the next ${data.weeks_horizon} weeks`}{department ? ` · ${department}` : ""}
          </span>
        </span>
        <ChevronRight size={16} style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {items.length === 0 && (
            <div style={{ padding: 14, color: C.textMuted, fontSize: 13, textAlign: "center" }}>
              Everyone who is booked today stays booked through the planning horizon.
            </div>
          )}
          {items.map((it) => (
            <div key={it.code}
              onClick={onOpen ? () => onOpen({ code: it.code, name: it.name, department: it.dept, position: it.position }) : undefined}
              style={{
                padding: 12, border: `1px solid ${C.border}`, borderRadius: 10, cursor: onOpen ? "pointer" : "default",
                display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 12, alignItems: "center",
                transition: "box-shadow 0.15s, transform 0.15s",
              }}
              onMouseEnter={e => { if (onOpen) { e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(-1px)"; } }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>
                  {cleanName(it)} <span style={{ color: C.textMuted, fontWeight: 500, fontSize: 12 }}>· {it.code}</span>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[it.position, it.dept].filter(Boolean).join(" · ")}
                  {it.current_projects && it.current_projects.length > 0 && (
                    <> · rolling off {it.current_projects.slice(0, 2).join(", ")}{it.current_projects.length > 2 ? "…" : ""}</>
                  )}
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {it.current_pct}% → {it.pct_at_rolloff}%
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, whiteSpace: "nowrap",
                background: it.full_free ? "var(--sem-ok-bg)" : "var(--sem-warn-bg)",
                color: it.full_free ? "var(--sem-ok-fg)" : "var(--sem-warn-fg)",
              }}>
                {it.full_free ? "fully free" : "partially free"} in {it.weeks_until}w · wk of {fmtWk(it.rolloff_week)}
              </span>
              <button onClick={(e) => { e.stopPropagation(); onFindWork && onFindWork(it); }}
                title={`Find the next assignment for ${cleanName(it)}`} style={{
                  padding: "6px 11px", borderRadius: 8, border: "none", cursor: "pointer", whiteSpace: "nowrap",
                  background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`, color: "#fff",
                  fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5,
                }}>
                <Sparkles size={12} /> Find work
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
