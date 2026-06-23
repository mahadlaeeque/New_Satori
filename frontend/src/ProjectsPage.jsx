// ─── Projects ───
// "Every project's health on one screen — work packages, deadlines, team."
//
// List view: every project with a WP-health rollup (active / behind / overdue),
// 90-day logged hours and team size, searchable + status/type filters.
// Click a project → drill-down modal: status mix, the active work-package list
// (owners, due dates, Behind/overdue flags), deliverable-type mix, and the
// team (logged hours + current allocation plan).
//
// Pairs with backend endpoints:
//   GET /api/projects
//   GET /api/projects/{code}
//
// Inline styles use the same CSS-variable token scheme as the rest of the app
// (semantic tints via var(--sem-…)) so dark mode flips without per-element work.

import { useState, useEffect, useMemo } from "react";
import {
  Search, X, Briefcase, Users, Clock, AlertCircle, Loader2, FileText, MapPin, ListChecks,
} from "lucide-react";
import { BenchRadarPanel, SuggestWorkModal } from "./components/BenchRadar.jsx";

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
  danger:        "#EF4444",
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

const progressPill = (progress) => {
  const p = (progress || "").toLowerCase();
  if (p === "completed")   return { bg: "var(--sem-ok-bg)", fg: "var(--sem-ok-fg)" };
  if (p === "in-progress") return { bg: "var(--sem-info-bg)", fg: "var(--sem-info-fg)" };
  return { bg: C.surfaceAlt, fg: C.textMuted };
};

// Strip the "E-938 - " code prefix from resource strings for display.
const personName = (s) => (s || "").replace(/^[A-Za-z]{1,4}-\d+\s*-?\s*/, "").trim() || (s || "");

// ─── Project drill-down modal ───
const ProjectDetailModal = ({ proj, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);
  useEffect(() => { setShowCompleted(false); }, [proj]);

  useEffect(() => {
    if (!proj) { setDetail(null); setError(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson(`/api/projects/${encodeURIComponent(proj.code)}`);
        if (!cancelled) setDetail(d);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, [proj]);

  if (!proj) return null;
  const d = detail;
  const statusMix = (d && d.status_mix) || {};
  const typeMix = (d && d.type_mix) || {};
  const activeWps = ((d && d.wps) || []).filter(w => (w.progress || "").toLowerCase() !== "completed");
  const completedWps = ((d && d.wps) || []).filter(w => (w.progress || "").toLowerCase() === "completed");
  const doneCount = statusMix["Completed"] || 0;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 860, maxHeight: "88vh",
        display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "18px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.textPrimary }}>{(d && d.name) || proj.name}</h2>
            <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {[(d && d.client) || proj.client, (d && d.type) || proj.type, (d && d.competency) || proj.competency].filter(Boolean).join(" · ")}
              {((d && d.location) || proj.location) && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <MapPin size={12} /> {(d && d.location) || proj.location}
                </span>
              )}
              {((d && d.status) || proj.status) && (
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: "var(--sem-ok-bg)", color: "var(--sem-ok-fg)" }}>
                  {(d && d.status) || proj.status}
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {error && (
            <div style={{ padding: "10px 14px", background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)", borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
              {error}
            </div>
          )}
          {!d && !error && <div style={{ padding: 24, color: C.textMuted, fontSize: 13, textAlign: "center" }}><Loader2 size={20} className="spin" /><div style={{ marginTop: 6 }}>Loading project…</div></div>}

          {d && (
            <>
              {/* Status mix chips */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
                {Object.entries(statusMix).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
                  const pill = progressPill(k);
                  return (
                    <span key={k} style={{ fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 999, background: pill.bg, color: pill.fg }}>
                      {k}: {n}
                    </span>
                  );
                })}
                {proj.wp_behind > 0 && (
                  <span style={{ fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 999, background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)" }}>
                    Behind: {proj.wp_behind}
                  </span>
                )}
                {proj.wp_overdue > 0 && (
                  <span style={{ fontSize: 12, fontWeight: 700, padding: "5px 12px", borderRadius: 999, background: "var(--sem-orange-bg)", color: "var(--sem-orange-fg)" }}>
                    Overdue: {proj.wp_overdue}
                  </span>
                )}
              </div>

              {/* Task / sub-task completion rollup (from PF_TASKS_SUBTASKS_REPORT) */}
              {d.task_totals && d.task_totals.total > 0 && (() => {
                const tt = d.task_totals;
                const pct = Math.round(100 * tt.done / tt.total);
                return (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", marginBottom: 18, padding: "12px 14px", background: C.surfaceAlt, borderRadius: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.textPrimary, display: "flex", alignItems: "center", gap: 6 }}>
                      <ListChecks size={15} /> Tasks & sub-tasks
                    </div>
                    <div style={{ fontSize: 12.5, color: C.textSecondary }}>
                      <b style={{ color: C.textPrimary }}>{tt.done.toLocaleString()}</b> / {tt.total.toLocaleString()} done · {pct}% complete
                      {tt.behind > 0 && <span style={{ color: "var(--sem-danger-fg)", fontWeight: 700 }}> · {tt.behind.toLocaleString()} behind</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 120, height: 6, background: C.border, borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: "var(--sem-ok-fg)" }} />
                    </div>
                  </div>
                );
              })()}

              {/* Active work packages */}
              <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
                <FileText size={14} /> Active work packages ({activeWps.length}{doneCount ? ` · ${doneCount} completed` : ""})
              </h3>
              {activeWps.length === 0 ? (
                <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10, marginBottom: 18 }}>
                  No active work packages{doneCount ? " — everything tracked is completed" : " on record"}.
                </div>
              ) : (
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
                  {activeWps.slice(0, 60).map((w, i) => {
                    const pill = progressPill(w.progress);
                    return (
                      <div key={w.code} style={{
                        padding: "10px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                        display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center",
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {w.description || w.code}
                          </div>
                          <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {[w.code, w.owner ? `owner ${w.owner}` : null, w.resource ? `assigned ${personName(w.resource)}` : null, w.tasks_total ? `${w.tasks_done}/${w.tasks_total} tasks` : null, w.end_date ? `due ${w.end_date}` : null].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          {w.overdue && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--sem-orange-bg)", color: "var(--sem-orange-fg)" }}>Overdue</span>
                          )}
                          {(w.performance || "").toLowerCase() === "behind" && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)" }}>Behind</span>
                          )}
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: pill.bg, color: pill.fg }}>
                            {w.progress || "—"}{w.plan_pct ? ` · ${w.plan_pct}%` : ""}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Completed WPs — collapsed by default */}
              {completedWps.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <button onClick={() => setShowCompleted(s => !s)} style={{
                    padding: "8px 14px", borderRadius: 8, border: `1px dashed ${C.border}`,
                    background: "transparent", color: C.textSecondary, fontWeight: 600, fontSize: 12.5, cursor: "pointer",
                  }}>
                    {showCompleted ? "Hide" : "Show"} {completedWps.length} completed work package{completedWps.length === 1 ? "" : "s"}{doneCount > completedWps.length ? ` (of ${doneCount})` : ""}
                  </button>
                  {showCompleted && (
                    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginTop: 10 }}>
                      {completedWps.map((w, i) => (
                        <div key={w.code} style={{
                          padding: "10px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                          display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", opacity: 0.75,
                        }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {w.description || w.code}
                            </div>
                            <div style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {[w.code, w.owner ? `owner ${w.owner}` : null, w.resource ? `assigned ${personName(w.resource)}` : null, w.end_date ? `due ${w.end_date}` : null].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: "var(--sem-ok-bg)", color: "var(--sem-ok-fg)", flexShrink: 0 }}>
                            Completed
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Deliverable types */}
              {Object.keys(typeMix).length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <h3 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px" }}>Deliverable types</h3>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {Object.entries(typeMix).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => (
                      <span key={k} style={{ fontSize: 11.5, fontWeight: 600, padding: "4px 11px", borderRadius: 999, background: C.surfaceAlt, color: C.textSecondary, border: `1px solid ${C.border}` }}>
                        {k} · {n}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Team */}
              <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
                <Users size={14} /> Team ({(d.team || []).length})
              </h3>
              {(d.team || []).length === 0 ? (
                <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
                  No logged hours or current allocations on this project.
                </div>
              ) : (
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                  {(d.team || []).map((t, i) => (
                    <div key={t.code || i} style={{
                      padding: "9px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                      display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center",
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: C.textPrimary }}>{personName(t.name) || t.code}</span>
                        <span style={{ fontSize: 11, color: C.textMuted }}> · {t.code}{t.dept ? ` · ${t.dept}` : ""}</span>
                      </div>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: C.textSecondary, fontVariantNumeric: "tabular-nums" }}>
                        {t.hrs_90d ? `${Math.round(t.hrs_90d)}h / 90d` : ""}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: t.alloc_pct > 0 ? "var(--sem-rose-bg)" : C.surfaceAlt, color: t.alloc_pct > 0 ? "var(--sem-rose-fg)" : C.textMuted }}>
                        {t.alloc_pct > 0 ? `${Math.round(t.alloc_pct)}% planned` : "hours only"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", background: C.surfaceAlt }}>
          <button onClick={onClose} style={{
            padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}>Close</button>
        </div>
      </div>
    </div>
  );
};

// ─── Page ───
const ProjectsPage = () => {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [suggestFor, setSuggestFor] = useState(null); // Bench Radar "Find work"

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson("/api/projects");
        if (!cancelled) setProjects(d.projects || []);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const statuses = useMemo(() => [...new Set(projects.map(p => p.status).filter(Boolean))].sort(), [projects]);
  const types = useMemo(() => [...new Set(projects.map(p => p.type).filter(Boolean))].sort(), [projects]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return projects.filter(p =>
      (!term || `${p.name} ${p.client} ${p.code} ${p.location} ${p.competency}`.toLowerCase().includes(term)) &&
      (!statusFilter || p.status === statusFilter) &&
      (!typeFilter || p.type === typeFilter));
  }, [projects, search, statusFilter, typeFilter]);

  const sel = {
    padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
    background: C.surface, color: C.textPrimary, fontSize: 14, fontWeight: 600,
  };

  return (
    <div style={{ padding: 24, maxWidth: 1500, margin: "0 auto" }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.textPrimary, display: "flex", alignItems: "center", gap: 12 }}>
        Delivery Engine
        <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: `${C.accent}22`, color: C.accentDark, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent }} />
          Enterprise AI · Connected to your data sources
        </span>
      </h1>
      <p style={{ margin: "4px 0 20px", fontSize: 13, color: C.textMuted }}>
        Ongoing and upcoming delivery — projects, work packages, deadlines, owners, and who frees up next. Scoped to the departments you can see.
      </p>

      {/* Bench Radar — upcoming roll-offs (moved here from the Availability Engine) */}
      <BenchRadarPanel onFindWork={(it) => setSuggestFor(it)} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 180px", gap: 12, marginBottom: 20 }}>
        <div style={{ position: "relative" }}>
          <Search size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: C.textMuted }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search project, client, code, location…"
            style={{ width: "100%", padding: "12px 16px 12px 40px", border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14, background: C.surface, color: C.textPrimary, boxSizing: "border-box" }} />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={sel}>
          <option value="">All statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={sel}>
          <option value="">All types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {loading ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
          <Loader2 size={24} className="spin" /><div style={{ marginTop: 8 }}>Loading projects…</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 16 }}>
          {filtered.map(p => (
            <div key={p.code} onClick={() => setSelected(p)} style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16,
              cursor: "pointer", transition: "box-shadow 0.15s, transform 0.15s",
            }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 6px 18px rgba(0,0,0,0.08)"; e.currentTarget.style.transform = "translateY(-2px)"; }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, justifyContent: "space-between" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                  <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[p.client, p.type, p.location].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <Briefcase size={16} style={{ color: C.textMuted, flexShrink: 0, marginTop: 2 }} />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "var(--sem-info-bg)", color: "var(--sem-info-fg)" }}>
                  {p.wp_active} active WP{p.wp_active === 1 ? "" : "s"}
                </span>
                {p.wp_completed > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "var(--sem-ok-bg)", color: "var(--sem-ok-fg)" }}>
                    {p.wp_completed} completed
                  </span>
                )}
                {p.wp_behind > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "var(--sem-danger-bg)", color: "var(--sem-danger-fg)" }}>
                    {p.wp_behind} behind
                  </span>
                )}
                {p.wp_overdue > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: "var(--sem-orange-bg)", color: "var(--sem-orange-fg)" }}>
                    {p.wp_overdue} overdue
                  </span>
                )}
                {p.wp_total === 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 999, background: C.surfaceAlt, color: C.textMuted }}>
                    no WP tracking
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 12, fontSize: 11.5, color: C.textSecondary }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Clock size={12} /> {Math.round(p.hrs_90d).toLocaleString()}h / 90d</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Users size={12} /> {p.team_90d} people</span>
                {p.wp_total > 0 && <span><FileText size={12} style={{ verticalAlign: "-2px" }} /> {p.wp_total} WPs total{p.wp_completed > 0 ? ` · ${Math.round(100 * p.wp_completed / p.wp_total)}% complete` : ""}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {!loading && (
        <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, textAlign: "center" }}>
          Showing {filtered.length} of {projects.length} projects · WP health from the PF work-package report · hours & team from timesheets (last 90 days)
        </div>
      )}

      <ProjectDetailModal proj={selected} onClose={() => setSelected(null)} />
      <SuggestWorkModal item={suggestFor} onClose={() => setSuggestFor(null)} />
    </div>
  );
};

export default ProjectsPage;
