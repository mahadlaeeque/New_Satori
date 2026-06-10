// ─── Availability Engine ───
// "Who's free, who's loaded, who fits this project."
//
// Page composition:
//   1. 6-card KPI strip (Total / On Bench / Partial / Allocated / High Activity / No Timesheet)
//   2. Search box + status filter + Create Task button
//   3. Skill/competency tag row with per-tag DISTINCT-employee counts
//   4. 3-column employee card grid (avatar, status pill, allocation bar, hrs/projects, skill tags)
//   5. Modals: Create Task / Project   →   Find Best Fit (top 5 ranked with AI reasoning)
//   6. Saved Tasks panel
//
// Pairs with backend endpoints:
//   GET  /api/availability/kpis
//   GET  /api/availability/skills
//   GET  /api/availability/departments
//   GET  /api/availability/employees ?status= &skill= &department= &q=
//   POST /api/availability/find-best-fit
//   GET  /api/availability/tasks
//   POST /api/availability/tasks
//   PUT  /api/availability/tasks/{id}
//   DEL  /api/availability/tasks/{id}
//
// Inline styles use the same CSS-variable token scheme as Growgnition.jsx so
// dark mode flips through `[data-satori-theme="dark"]` without per-element work.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Users, Search, Plus, X, Sparkles, MapPin, Briefcase, Clock,
  Activity, Filter, AlertCircle, CheckCircle, Loader2, Trash2,
  ArrowRight, TrendingUp, ChevronRight, FileText, Star, Calendar,
  Download, LayoutGrid, Grid3x3, Radar
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE || "";

// Theme-aware tokens. Same approach as Growgnition.jsx COLORS.
const C = {
  primary:       "var(--c-primary)",
  primaryLight:  "var(--c-primary-light)",
  accent:        "#8AC441",
  accentDark:    "#68933F",
  surface:       "var(--c-surface)",
  surfaceAlt:    "var(--c-surface-alt)",
  border:        "var(--c-border)",
  textPrimary:   "var(--c-text-primary)",
  textSecondary: "var(--c-text-secondary)",
  textMuted:     "var(--c-text-muted)",
  danger:        "#EF4444",
  warning:       "#F59E0B",
  info:          "#0A5F89",
};

// Status band colours — same vocabulary as the backend (_avail_employees_sql).
const STATUS_COLOR = {
  Bench:     { fg: "#0E7E3E", bg: "#DCFCE7", border: "#86EFAC" },
  Partial:   { fg: "#B45309", bg: "#FEF3C7", border: "#FCD34D" },
  Allocated: { fg: "#9F1239", bg: "#FFE4E6", border: "#FDA4AF" },
};

// ─── Token + fetch helpers ───
const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const fetchJson = async (url, options = {}) => {
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
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

// Initials helper for the avatar circles.
const initials = (name) => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]).join("").toUpperCase();
};

// The warehouse Resource_Name carries a code prefix (e.g. "C-064 - Jane Doe").
// Strip it for display so cards show just the person's name; the bare employee
// code is surfaced only in the detail view.
const cleanName = (emp) => {
  const raw = (emp?.name || "").trim();
  // Prefer stripping the exact known code prefix.
  if (emp?.code) {
    const esc = String(emp.code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = raw.replace(new RegExp("^" + esc + "\\s*[-–—]?\\s*", "i"), "");
    if (stripped !== raw) return stripped.trim() || raw;
  }
  // Fallback: strip only a clear code-LIKE prefix that uses the dash form
  // (e.g. "C-064") so we never clip a genuine name like "Ali" or "Jo".
  const stripped = raw.replace(/^[A-Za-z]{1,4}-\d+\s*[-–—]?\s*/, "");
  return stripped.trim() || raw || "—";
};

const fmtNumber = (n) => Number(n || 0).toLocaleString();

// Deterministic avatar tint per employee name so it's stable across renders.
const avatarTint = (name) => {
  const palette = ["#8AC441", "#0A5F89", "#353085", "#F59E0B", "#9333EA", "#0EA5E9", "#10B981", "#EF4444"];
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
};

// ─── KPI Card ───
const KPICard = ({ label, value, accent, subtitle }) => (
  <div style={{
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderTop: `3px solid ${accent}`,
    borderRadius: 12,
    padding: "18px 20px",
    minWidth: 0,
  }}>
    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>
      {label}
    </div>
    <div style={{ fontSize: 28, fontWeight: 800, color: accent, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
      {fmtNumber(value)}
    </div>
    {subtitle && (
      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{subtitle}</div>
    )}
  </div>
);

// ─── Employee Card ───
const EmployeeCard = ({ emp, onClick }) => {
  const status = emp.status || "Bench";
  const c = STATUS_COLOR[status] || STATUS_COLOR.Bench;
  const allocPct = Math.max(0, Math.min(100, Number(emp.allocation_pct || 0)));
  const tags = useMemo(() => {
    const out = [];
    if (emp.competency && emp.competency.trim()) out.push(emp.competency.trim());
    if (emp.position && emp.position.trim() && emp.position.trim() !== emp.competency) out.push(emp.position.trim());
    return out.slice(0, 3);
  }, [emp.competency, emp.position]);

  return (
    <div
      onClick={onClick}
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding: 18,
        cursor: onClick ? "pointer" : "default",
        transition: "box-shadow 0.15s, transform 0.15s",
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 6px 18px rgba(0,0,0,0.08)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{
            width: 40, height: 40, borderRadius: "50%",
            background: avatarTint(cleanName(emp)) + "22",
            color: avatarTint(cleanName(emp)),
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 700, fontSize: 14, flexShrink: 0,
          }}>{initials(cleanName(emp))}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cleanName(emp)}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{emp.position || "—"}</div>
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700,
          padding: "4px 10px", borderRadius: 999,
          background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
          flexShrink: 0,
        }}>{status}</span>
      </div>

      <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <MapPin size={12} />
        {emp.location || "—"} {emp.department && (<><span style={{ opacity: 0.5 }}>·</span> {emp.department}</>)}
      </div>

      <div style={{ marginTop: 12 }}>
        <div style={{ height: 6, background: C.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${allocPct}%`, background: STATUS_COLOR[status]?.fg || C.accent, transition: "width 0.3s" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>{emp.project_count || 0} project{emp.project_count === 1 ? "" : "s"}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, fontVariantNumeric: "tabular-nums" }}>{Math.round(allocPct)}%</span>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: C.textMuted, display: "flex", alignItems: "center", gap: 6 }}>
        <Clock size={11} />
        {Number(emp.hrs_90d) === 0
          ? <span style={{ color: C.danger, fontWeight: 600 }}>No timesheet · 0h / 90d</span>
          : <span>{Math.round(Number(emp.hrs_90d))}h logged / last 90d</span>}
      </div>

      {tags.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {tags.map((t, i) => (
            <span key={i} style={{
              fontSize: 11, fontWeight: 600,
              padding: "3px 8px", borderRadius: 6,
              background: `${C.accent}15`, color: C.accentDark,
            }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Skill Dropdown ───
// Replaces the previous big tag row — that view got cluttered fast at
// ~50 skills × counts. Same data, much cleaner control. "All skills" is
// the default; selecting a skill applies the same filter param to the
// /api/availability/employees query.
const SkillDropdown = ({ skills, active, onChange }) => (
  <select
    value={active || ""}
    onChange={e => onChange(e.target.value || null)}
    style={{
      padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
      background: C.surface, color: C.textPrimary, fontSize: 14, fontWeight: 600,
      width: "100%", boxSizing: "border-box", cursor: "pointer",
    }}
  >
    <option value="">All Skills</option>
    {(skills || []).map(s => (
      <option key={s.skill} value={s.skill}>{s.skill} ({fmtNumber(s.count)})</option>
    ))}
  </select>
);

// ─── Create Task Modal ───
const CreateTaskModal = ({ open, onClose, onSubmit, locations, loading, error }) => {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState("");

  useEffect(() => {
    if (!open) {
      setName(""); setLocation(""); setDescription(""); setSkills("");
    }
  }, [open]);

  if (!open) return null;
  const canSubmit = name.trim() && !loading;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 720,
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
              <Sparkles size={20} color={C.accent} /> Create Task / Project
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSecondary, lineHeight: 1.5 }}>
              Describe your project. Satori recommends the best-fit employees across everyone you can see — based on availability, skills, and recent engagement. Optionally narrow by location.
            </p>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ padding: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Project Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. New CRM integration" style={{
              width: "100%", marginTop: 6, padding: "10px 12px",
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14,
              background: C.surface, color: C.textPrimary, boxSizing: "border-box",
            }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Location</label>
            <select value={location} onChange={e => setLocation(e.target.value)} style={{
              width: "100%", marginTop: 6, padding: "10px 12px",
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14,
              background: C.surface, color: C.textPrimary, boxSizing: "border-box",
            }}>
              <option value="">Any location</option>
              {(locations || []).map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Project Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="What is the project about, target outcome, timeline..." style={{
              width: "100%", marginTop: 6, padding: "10px 12px",
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14,
              background: C.surface, color: C.textPrimary, resize: "vertical", boxSizing: "border-box", fontFamily: "inherit",
            }} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Skills / Keywords Needed</label>
            <input value={skills} onChange={e => setSkills(e.target.value)} placeholder="e.g. Salesforce, Python, stakeholder management" style={{
              width: "100%", marginTop: 6, padding: "10px 12px",
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14,
              background: C.surface, color: C.textPrimary, boxSizing: "border-box",
            }} />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>Comma-separated. The AI uses these as substring matches against competency, position, and location.</div>
          </div>
        </div>

        {error && (
          <div style={{ margin: "0 24px 16px", padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <div style={{ padding: "16px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8, background: C.surfaceAlt }}>
          <button onClick={onClose} style={{
            padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}>Cancel</button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit({ name: name.trim(), location, description: description.trim(), skills_keywords: skills.trim() })}
            style={{
              padding: "10px 20px", borderRadius: 8, border: "none",
              background: canSubmit ? `linear-gradient(135deg, ${C.accent}, ${C.accentDark})` : "#E5E7EB",
              color: "#fff", fontWeight: 700, fontSize: 14, cursor: canSubmit ? "pointer" : "not-allowed",
              display: "inline-flex", alignItems: "center", gap: 6,
              opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {loading ? <><Loader2 size={14} className="spin" /> Searching…</> : <>Find Best Fit <ArrowRight size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── Best Fit Results Modal ───
const BestFitResultsModal = ({ open, onClose, project, recommendations, onSaveTask, saving }) => {
  const [selectedCodes, setSelectedCodes] = useState([]);
  useEffect(() => { if (!open) setSelectedCodes([]); }, [open]);
  useEffect(() => {
    if (open && recommendations && recommendations.length > 0) {
      // Default-select the top candidate.
      setSelectedCodes([recommendations[0].code]);
    }
  }, [open, recommendations]);

  if (!open) return null;
  const toggle = (code) => setSelectedCodes(s => s.includes(code) ? s.filter(c => c !== code) : [...s, code]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 840, maxHeight: "85vh", display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
              <Sparkles size={20} color={C.accent} /> Best-Fit Recommendations
            </h2>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: C.textSecondary }}>
              For <strong style={{ color: C.textPrimary }}>{project?.name}</strong>{project?.location ? <> · <strong style={{ color: C.textPrimary }}>{project.location}</strong></> : null}. Ranked by availability, skill match, and recent engagement.
            </p>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {(!recommendations || recommendations.length === 0) ? (
            <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
              <AlertCircle size={32} style={{ opacity: 0.5 }} />
              <div style={{ marginTop: 12, fontSize: 14 }}>No matching candidates found.</div>
            </div>
          ) : recommendations.map(rec => {
            const e = rec.employee || {};
            const c = STATUS_COLOR[e.status] || STATUS_COLOR.Bench;
            const checked = selectedCodes.includes(rec.code);
            return (
              <div key={rec.code} onClick={() => toggle(rec.code)} style={{
                border: `1px solid ${checked ? C.accentDark : C.border}`,
                background: checked ? `${C.accent}10` : C.surface,
                borderRadius: 12, padding: 16, cursor: "pointer", transition: "all 0.15s",
                display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, alignItems: "flex-start",
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: rec.rank === 1 ? `linear-gradient(135deg, ${C.accent}, ${C.accentDark})` : `${C.surfaceAlt}`,
                  color: rec.rank === 1 ? "#fff" : C.textSecondary,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 800, fontSize: 14, border: `1px solid ${C.border}`,
                }}>#{rec.rank}</div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary }}>{e.name}</div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg }}>{e.status}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: `${C.info}15`, color: C.info }}>
                      <Star size={10} style={{ marginRight: 4, verticalAlign: "middle" }} />
                      Match {rec.match_score}/100
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                    {e.position} {e.location && `· ${e.location}`} · {Math.round(Number(e.allocation_pct || 0))}% allocated · {Math.round(Number(e.hrs_90d || 0))}h / 90d
                  </div>
                  <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 8, lineHeight: 1.5 }}>
                    {rec.reasoning}
                  </div>
                </div>

                <div style={{
                  width: 20, height: 20, borderRadius: 4, marginTop: 4,
                  border: `2px solid ${checked ? C.accentDark : C.border}`,
                  background: checked ? C.accentDark : C.surface,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {checked && <CheckCircle size={14} color="#fff" />}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: "16px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, background: C.surfaceAlt }}>
          <div style={{ fontSize: 13, color: C.textMuted }}>{selectedCodes.length} selected</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{
              padding: "10px 18px", borderRadius: 8, border: `1px solid ${C.border}`,
              background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 14, cursor: "pointer",
            }}>Close</button>
            <button
              disabled={selectedCodes.length === 0 || saving}
              onClick={() => onSaveTask(selectedCodes)}
              style={{
                padding: "10px 20px", borderRadius: 8, border: "none",
                background: selectedCodes.length > 0 ? `linear-gradient(135deg, ${C.accent}, ${C.accentDark})` : "#E5E7EB",
                color: "#fff", fontWeight: 700, fontSize: 14,
                cursor: selectedCodes.length > 0 ? "pointer" : "not-allowed",
                opacity: selectedCodes.length > 0 ? 1 : 0.6,
                display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              {saving ? <><Loader2 size={14} /> Saving…</> : <>Save Task <CheckCircle size={14} /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Saved Tasks panel (collapsible) ───
const SavedTasksPanel = ({ tasks, onDelete, onToggleStatus, onOpen }) => {
  const [open, setOpen] = useState(false);
  if (!tasks || tasks.length === 0) return null;
  // stopPropagation helper for the in-row controls (status dropdown, delete)
  // so clicking those doesn't also trigger the row's onClick → detail modal.
  const stop = e => e.stopPropagation();
  return (
    <div style={{ marginBottom: 20, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: "100%", padding: "12px 16px", border: "none", background: "transparent", color: C.textPrimary,
        display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontWeight: 700, fontSize: 14,
      }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><FileText size={16} /> Saved Tasks · {tasks.length}</span>
        <ChevronRight size={16} style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "transform 0.15s" }} />
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map(t => (
            <div
              key={t.id}
              onClick={() => onOpen && onOpen(t)}
              style={{
                padding: 12, border: `1px solid ${C.border}`, borderRadius: 10,
                display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center",
                cursor: onOpen ? "pointer" : "default",
                transition: "box-shadow 0.15s, transform 0.15s",
              }}
              onMouseEnter={e => { if (onOpen) { e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(-1px)"; } }}
              onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>{t.name}</div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                  {t.department || "—"}
                  {Array.isArray(t.assigned_employee_codes) && t.assigned_employee_codes.length > 0
                    ? ` · assigned to ${t.assigned_employee_codes.length} person${t.assigned_employee_codes.length === 1 ? "" : "s"}`
                    : " · unassigned"}
                </div>
              </div>
              <select
                value={t.status || "open"}
                onClick={stop}
                onChange={e => { stop(e); onToggleStatus(t.id, e.target.value); }}
                style={{
                  padding: "6px 10px", borderRadius: 6, border: `1px solid ${C.border}`,
                  background: C.surfaceAlt, color: C.textSecondary, fontSize: 12, fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
              </select>
              <button
                onClick={e => { stop(e); onDelete(t.id); }}
                title="Delete task"
                style={{
                  background: "transparent", border: "none", cursor: "pointer", padding: 6, color: C.danger,
                }}
              ><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Employee Detail Modal ───
// Suggested skills shown as quick-add chips when assigning skills. Keyed by a
// substring of the employee's department/competency so suggestions are
// function-specific; GENERAL is always appended. The practice head can still
// type any skill they want — these are just starting points.
const SKILL_SUGGESTIONS = {
  qlik:      ["Qlik Sense", "QlikView", "NPrinting", "Qlik Cloud", "Qlik Application Automation", "Data Modeling", "Set Analysis", "Section Access", "Mashups", "Qlik Replicate", "Talend", "ETL", "Data Warehousing", "Star Schema", "SQL", "Dashboard Design", "Data Visualization", "Qlik Sense Scripting"],
  "sap":     ["SAP FICO", "SAP MM", "SAP SD", "SAP PP", "SAP QM", "SAP WM/EWM", "SAP PM", "SAP ABAP", "SAP BASIS", "SAP S/4HANA", "SAP HANA", "SAP HCM", "SAP SuccessFactors", "SAP Fiori", "SAP BTP", "SAP Ariba", "SAP MDG", "SAP Solution Manager", "Functional Configuration", "Integration (IDoc/BAPI)"],
  abap:      ["SAP ABAP", "SAP Fiori", "SAPUI5", "OData", "CDS Views", "RAP (RESTful ABAP)", "ABAP OO", "BAPI/BADI", "Enhancements (User Exits)", "Adobe Forms", "SmartForms", "Workflow", "Gateway", "ABAP on HANA", "AMDP", "Proxy/IDoc"],
  fiori:     ["SAP Fiori", "SAPUI5", "JavaScript", "ABAP", "OData", "CDS Views", "Fiori Elements", "BTP", "HTML5", "CSS", "Fiori Launchpad", "App Deployment"],
  basis:     ["SAP BASIS", "HANA Admin", "System Migration", "OS/DB Migration", "SAP Security", "GRC", "Solution Manager", "Kernel Upgrades", "Transport Management", "Performance Tuning", "High Availability", "SAP on Cloud", "Patching"],
  finance:   ["SAP FICO", "SAP Controlling", "Financial Reporting", "IFRS", "Budgeting & Forecasting", "GL/AP/AR", "Asset Accounting", "Cost Center Accounting", "Profitability Analysis (CO-PA)", "Excel", "Power BI", "Taxation", "Audit"],
  controlling:["SAP CO", "Cost Center Accounting", "Internal Orders", "Product Costing", "CO-PA", "Profit Center Accounting", "Financial Reporting", "Variance Analysis"],
  hcm:       ["SAP HCM", "SAP SuccessFactors", "Payroll", "SLCM", "Time Management", "Employee Central", "Org Management", "Recruitment", "Performance & Goals", "Compensation", "Workday HCM"],
  workday:   ["Workday HCM", "Workday Integrations", "Workday Studio", "Workday Reporting", "EIB", "Calculated Fields", "Business Process Framework"],
  digital:   ["Python", "N8N", "Claude", "LangChain", "LangGraph", "RAG", "Prompt Engineering", "OpenAI API", "React", "Node.js", "FastAPI", "SQL", "Power BI", "Vector Databases", "Docker", "REST APIs", "Automation", "AI/ML", "TypeScript"],
  "emerging":["Python", "N8N", "Claude", "LLMs", "Agentic AI", "RAG", "LangChain", "Automation", "React", "SQL", "AI/ML", "Computer Vision", "NLP", "Generative AI", "MLOps", "Hugging Face"],
  dt:        ["Python", "N8N", "Claude", "Automation", "React", "SQL", "AI/ML", "RPA", "Power Automate", "Process Mining", "Integration", "APIs"],
  analytics: ["Power BI", "Tableau", "SQL", "Python", "Data Modeling", "Qlik Sense", "DAX", "Data Warehousing", "ETL", "Statistics", "R", "Looker", "Snowflake", "BigQuery", "Data Storytelling"],
  cloud:     ["AWS", "Azure", "GCP", "Kubernetes", "Terraform", "CI/CD", "Docker", "Linux", "Networking", "Ansible", "CloudFormation", "Serverless", "DevOps", "Monitoring (Prometheus/Grafana)", "IAM/Security"],
  sales:     ["CRM", "Pipeline Management", "Account Management", "Negotiation", "Presales", "Solution Selling", "Lead Generation", "Proposal Writing", "Stakeholder Management", "Forecasting", "Salesforce", "Client Relationship"],
  "account": ["Account Management", "Client Relationship", "Upselling/Cross-selling", "Pipeline Management", "Negotiation", "CRM", "Stakeholder Management", "Contract Management"],
  pmo:       ["Project Management", "Agile/Scrum", "JIRA", "Stakeholder Management", "MS Project", "PMP", "Risk Management", "Budget Management", "Resource Planning", "Kanban", "Confluence", "Program Management", "PRINCE2"],
  "supply":  ["SAP MM", "SAP SD", "SAP WM/EWM", "SAP PP", "Logistics", "Procurement", "Inventory Management", "Demand Planning", "S&OP", "SAP IBP"],
  professional:["Consulting", "Requirements Gathering", "Solution Design", "Stakeholder Management", "Project Management", "Business Analysis", "Documentation", "Client Workshops"],
  kpo:       ["Data Entry", "Process Excellence", "Quality Assurance", "Reporting", "Excel", "Business Analysis", "Documentation", "Research"],
  marketing: ["Digital Marketing", "Content Strategy", "SEO/SEM", "Social Media", "Brand Management", "Marketing Analytics", "Campaign Management", "Adobe Creative Suite"],
  hr:        ["Recruitment", "Talent Management", "Employee Engagement", "HR Operations", "Payroll", "Performance Management", "HRIS", "Onboarding"],
  textile:   ["Production Planning", "Quality Control", "Supply Chain", "ERP", "Lean Manufacturing", "Inventory Management"],
};
const GENERAL_SKILLS = ["Python", "SQL", "Power BI", "Claude", "N8N", "Project Management", "Communication", "Data Analysis", "Excel", "Stakeholder Management", "Documentation", "Problem Solving", "Agile/Scrum", "Presentation Skills", "Requirements Gathering", "Team Leadership", "Time Management", "Business Analysis"];
// Suggest a fresh batch each render, EXCLUDING anything the person already
// picked. Because the pool is large, new chips keep appearing as they add
// skills — the suggestions only run out when they've essentially picked
// everything relevant (i.e. they've stopped because there's nothing left).
const suggestionsFor = (department, competency, already) => {
  const key = `${department || ""} ${competency || ""}`.toLowerCase();
  const picked = [];
  for (const [k, list] of Object.entries(SKILL_SUGGESTIONS)) {
    if (key.includes(k)) picked.push(...list);
  }
  const taken = new Set((already || []).map((s) => s.toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const s of [...picked, ...GENERAL_SKILLS]) {
    const low = s.toLowerCase();
    if (taken.has(low) || seen.has(low)) continue;
    seen.add(low); out.push(s);
    if (out.length >= 40) break;
  }
  return out;
};

// Drill-down for one employee. Fetches /api/availability/employees/{code}/detail
// when an employee is selected, then renders their projects (Allocation_data)
// and 90-day timesheet activity. The card-level fields (name, position,
// status, allocation bar) come from the card prop directly so the header
// renders instantly while the detail fetch is in flight.

// ─── Week-by-week allocation timeline ───
// Renders the per-week allocated% for an employee across recent + FUTURE weeks
// (Allocation_Data is a weekly feed running into 2028). Each bar = one week,
// coloured by status; future/planned weeks are dashed + faded; the first future
// week carries a dashed "now" divider. The headline shows weeks-on-bench (the
// number a flat "on bench" list hides — 1 week vs 75 weeks are very different).
const WK_STATUS_COLOR = { allocated: STATUS_COLOR.Allocated, partial: STATUS_COLOR.Partial, bench: STATUS_COLOR.Bench };
const WeeklyTimeline = ({ data, loading }) => {
  if (loading && !data) return <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>Loading weekly allocation…</div>;
  const weeks = (data && data.weeks) || [];
  if (!weeks.length) return <div style={{ padding: 12, color: C.textMuted, fontSize: 13 }}>No weekly allocation data.</div>;
  const wob = data.weeks_on_bench || 0;
  const cur = Math.round(data.current_pct || 0);
  const MAXH = 60, CAP = 150;
  let firstFutureSeen = false;
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        {wob > 0
          ? <span style={{ fontSize: 12, fontWeight: 700, color: STATUS_COLOR.Bench.fg }}>On bench {wob} week{wob > 1 ? "s" : ""} (and counting)</span>
          : <span style={{ fontSize: 12, fontWeight: 700, color: cur >= 100 ? STATUS_COLOR.Allocated.fg : STATUS_COLOR.Partial.fg }}>{cur}% allocated this week</span>}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, overflowX: "auto", paddingBottom: 6 }}>
        {weeks.map((w, i) => {
          const col = WK_STATUS_COLOR[w.status] || STATUS_COLOR.Bench;
          const h = Math.max(3, Math.round(Math.min(w.allocated_pct, CAP) / CAP * MAXH));
          const showNow = w.is_future && !firstFutureSeen;
          if (w.is_future) firstFutureSeen = true;
          return (
            <div key={i}
              title={`${w.week_date} · ${Math.round(w.allocated_pct)}% · ${w.project_count} project${w.project_count === 1 ? "" : "s"}${w.is_future ? " (planned)" : ""}`}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, minWidth: 22, borderLeft: showNow ? `2px dashed ${C.accent}` : "none", paddingLeft: showNow ? 4 : 0 }}>
              <div style={{ height: MAXH, display: "flex", alignItems: "flex-end" }}>
                <div style={{ width: 13, height: h, borderRadius: "3px 3px 0 0", background: col.fg, opacity: w.is_future ? 0.4 : 1, border: w.is_future ? `1px dashed ${col.fg}` : "none" }} />
              </div>
              <div style={{ fontSize: 9, color: C.textMuted }}>{w.week_no}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ fontSize: 10, color: C.textMuted }}>← past · week #</span>
        <span style={{ fontSize: 10, color: C.accent, fontWeight: 600 }}>now (dashed) · planned →</span>
      </div>
    </div>
  );
};

// ─── Attendance tab (last 30 days) ───
// Day-by-day attendance from /api/availability/employees/{code}/attendance.
// Working-day counts come from the COMPANY calendar (same rule as the chat
// agent) so this tab and Ask-Me-Anything can never disagree on working days.
const attPill = (statusRaw) => {
  const s = (statusRaw || "").toLowerCase();
  if (s.includes("present")) return { fg: "#0E7E3E", bg: "#DCFCE7" };
  if (s.includes("remote"))  return { fg: "#0A5F89", bg: "#E0F2FE" };
  if (s.includes("leave"))   return { fg: "#B45309", bg: "#FEF3C7" };
  if (s.includes("absent"))  return { fg: "#B91C1C", bg: "#FEE2E2" };
  if (s.includes("missing")) return { fg: "#C2410C", bg: "#FFEDD5" };
  return { fg: "var(--c-text-muted)", bg: "var(--c-surface-alt)" };
};

const fmtAttDay = (iso) => {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch { return iso; }
};

const AttendanceTab = ({ data, loading, error }) => {
  if (loading && !data) return <div style={{ padding: 20, color: C.textMuted, fontSize: 13 }}>Loading attendance…</div>;
  if (error) return (
    <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
      <AlertCircle size={16} /> {error}
    </div>
  );
  if (!data) return null;
  const s = data.summary || {};
  const rate = s.attendance_rate;
  const cards = [
    {
      label: "Attendance rate",
      value: rate != null ? `${rate}%` : "—",
      sub: `${s.attended || 0} of ${s.working_days || 0} working days`,
      color: rate == null ? C.textPrimary : rate >= 90 ? "#0E7E3E" : rate >= 70 ? "#B45309" : C.danger,
    },
    { label: "Present / Remote", value: `${s.present || 0} / ${s.remote || 0}`, sub: `${s.missing_punch || 0} missing punch` },
    { label: "Leave / Absent", value: `${s.on_leave || 0} / ${s.absent || 0}`, sub: "days", color: (s.absent || 0) > 0 ? C.danger : C.textPrimary },
    { label: "Late arrivals", value: `${s.late_arrivals || 0}`, sub: s.avg_checkin ? `avg in ${s.avg_checkin} · out ${s.avg_checkout || "—"}` : "no punches", color: (s.late_arrivals || 0) > 0 ? "#C2410C" : C.textPrimary },
  ];
  const detail = data.days_detail || [];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        {cards.map((k, i) => (
          <div key={i} style={{ background: C.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{k.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: k.color || C.textPrimary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{k.value}</div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{k.sub}</div>
          </div>
        ))}
      </div>
      <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
        <Calendar size={14} /> Day by day (last {data.days || 30} days)
      </h3>
      {detail.length === 0 ? (
        <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
          No attendance records in this window.
        </div>
      ) : (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
          {detail.map((d, i) => {
            const pill = attPill(d.status);
            const offDay = !d.is_working_day;
            return (
              <div key={d.date} style={{
                padding: "9px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                display: "grid", gridTemplateColumns: "118px 1fr 130px 60px", gap: 10, alignItems: "center",
                opacity: offDay ? 0.55 : 1,
              }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.textSecondary, fontVariantNumeric: "tabular-nums" }}>{fmtAttDay(d.date)}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999, background: pill.bg, color: pill.fg }}>
                    {d.status || "—"}
                  </span>
                  {d.leave_type && <span style={{ fontSize: 11, color: C.textMuted }}>{d.leave_type}</span>}
                  {d.late && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#FEE2E2", color: "#B91C1C" }}>
                      Late
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {d.checkin ? `${d.checkin} → ${d.checkout || "—"}` : ""}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {d.worked_hrs != null ? `${d.worked_hrs}h` : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Resource one-pager (PDF export) ───
// A4-proportioned, staffing-ready profile sheet rendered off-screen and
// captured with html2canvas → jsPDF. This is a PRINT artifact: colors are
// deliberately hardcoded light (the theme-token convention doesn't apply —
// a PDF must look identical regardless of the app's dark/light mode).
const OP = {
  ink: "#0F172A", sub: "#475569", muted: "#94A3B8", line: "#E2E8F0",
  panel: "#F8FAFC", green: "#8AC441", greenDark: "#68933F",
};
const ResourceOnePager = ({ emp, detail, att, innerRef }) => {
  const prof = (detail && detail.profile) || {};
  const s = (att && att.summary) || null;
  const projects = ((detail && detail.projects) || []).filter(p => !p.on_bench).slice(0, 6);
  const ts = (detail && detail.timesheet) || {};
  const topTs = (ts.by_project || []).slice(0, 5);
  const skills = (detail && detail.skills) || [];
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const head = { fontSize: 11, fontWeight: 800, color: OP.greenDark, textTransform: "uppercase", letterSpacing: "1px", margin: "0 0 8px" };
  const kpi = (label, value, sub) => (
    <div style={{ flex: 1, background: OP.panel, border: `1px solid ${OP.line}`, borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: OP.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: OP.ink, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, color: OP.sub, marginTop: 2 }}>{sub}</div>}
    </div>
  );
  return (
    <div ref={innerRef} style={{
      position: "fixed", left: -10000, top: 0, width: 794, background: "#ffffff",
      fontFamily: "'Segoe UI', system-ui, sans-serif", color: OP.ink, zIndex: -1,
    }}>
      {/* Brand band */}
      <div style={{ background: `linear-gradient(135deg, ${OP.green}, ${OP.greenDark})`, padding: "14px 36px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "#fff", fontWeight: 800, fontSize: 15, letterSpacing: "0.5px" }}>Satori · TMC Capability Intelligence</div>
        <div style={{ color: "#fff", fontSize: 11, opacity: 0.9 }}>Resource Profile · {today}</div>
      </div>

      <div style={{ padding: "26px 36px 18px" }}>
        {/* Identity */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 18, borderBottom: `2px solid ${OP.line}` }}>
          <div style={{
            width: 58, height: 58, borderRadius: "50%", background: `${OP.green}30`, color: OP.greenDark,
            display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 22, flexShrink: 0,
          }}>{initials(cleanName(emp))}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{cleanName(emp)}</div>
            <div style={{ fontSize: 13, color: OP.sub, marginTop: 3 }}>
              {[emp.position, emp.department, emp.location].filter(Boolean).join("  ·  ")}
            </div>
            {prof.email && <div style={{ fontSize: 12, color: OP.greenDark, fontWeight: 600, marginTop: 2 }}>{prof.email}</div>}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: OP.sub, background: OP.panel, border: `1px solid ${OP.line}`, borderRadius: 999, padding: "4px 12px", display: "inline-block" }}>{emp.code}</div>
            {prof.tenure_label && (
              <div style={{ fontSize: 11, color: OP.sub, marginTop: 6 }}>
                Tenure <b>{prof.tenure_label}</b>{prof.joining_date ? ` · since ${prof.joining_date}` : ""}
              </div>
            )}
            {prof.employee_type && <div style={{ fontSize: 11, color: OP.muted, marginTop: 2 }}>{prof.employee_type}</div>}
          </div>
        </div>

        {/* KPI row */}
        <div style={{ display: "flex", gap: 10, margin: "16px 0 20px" }}>
          {kpi("Allocation", `${Math.round(Number(emp.allocation_pct || 0))}%`, emp.status || "")}
          {kpi("Hours / 90d", `${Math.round(Number(ts.total_hrs_90d || emp.hrs_90d || 0))}h`, `${(ts.by_project || []).length} projects logged`)}
          {s && kpi("Attendance / 30d", s.attendance_rate != null ? `${s.attendance_rate}%` : "—", `${s.attended || 0} of ${s.working_days || 0} working days`)}
          {s && kpi("Late arrivals / 30d", `${s.late_arrivals || 0}`, s.avg_checkin ? `avg in ${s.avg_checkin}` : "")}
        </div>

        {/* Skills */}
        <div style={{ marginBottom: 20 }}>
          <h3 style={head}>Skills</h3>
          {skills.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {skills.map(sk => (
                <span key={sk} style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 999, background: `${OP.green}1F`, color: OP.greenDark, border: `1px solid ${OP.green}55` }}>{sk}</span>
              ))}
            </div>
          ) : <div style={{ fontSize: 11.5, color: OP.muted }}>No skills tagged yet.</div>}
        </div>

        {/* Current allocations */}
        <div style={{ marginBottom: 20 }}>
          <h3 style={head}>Current project allocations</h3>
          {projects.length ? projects.map((p, i) => {
            const pct = Math.max(0, Math.min(100, Number(p.allocation_pct || 0)));
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0", borderBottom: i < projects.length - 1 ? `1px solid ${OP.line}` : "none" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.project_name || p.project_id}</div>
                  <div style={{ fontSize: 10.5, color: OP.muted }}>{[p.client_name, p.project_type, p.competency].filter(Boolean).join(" · ") || " "}</div>
                </div>
                <div style={{ width: 130 }}>
                  <div style={{ height: 6, background: OP.panel, border: `1px solid ${OP.line}`, borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: OP.green }} />
                  </div>
                </div>
                <div style={{ width: 44, textAlign: "right", fontSize: 12.5, fontWeight: 800 }}>{Math.round(Number(p.allocation_pct || 0))}%</div>
              </div>
            );
          }) : <div style={{ fontSize: 11.5, color: OP.muted }}>No active project allocations this week.</div>}
        </div>

        {/* Recent delivery */}
        <div style={{ marginBottom: 8 }}>
          <h3 style={head}>Recent delivery — logged hours (last 90 days)</h3>
          {topTs.length ? topTs.map((t, i) => {
            const total = Number(ts.total_hrs_90d || 1);
            const bar = Math.min(100, (Number(t.hrs || 0) / total) * 100);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", borderBottom: i < topTs.length - 1 ? `1px solid ${OP.line}` : "none" }}>
                <div style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.project}</div>
                <div style={{ width: 130 }}>
                  <div style={{ height: 6, background: OP.panel, border: `1px solid ${OP.line}`, borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${bar}%`, background: OP.greenDark }} />
                  </div>
                </div>
                <div style={{ width: 50, textAlign: "right", fontSize: 12, fontWeight: 800 }}>{Math.round(Number(t.hrs || 0))}h</div>
              </div>
            );
          }) : <div style={{ fontSize: 11.5, color: OP.muted }}>No timesheet entries in the last 90 days.</div>}
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${OP.line}`, padding: "10px 36px", display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 9.5, color: OP.muted }}>Generated by Satori from live workforce data · Internal use only</span>
        <span style={{ fontSize: 9.5, color: OP.muted }}>tmcltd.com</span>
      </div>
    </div>
  );
};

const EmployeeDetailModal = ({ emp, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [weekly, setWeekly] = useState(null);
  const [weeklyLoading, setWeeklyLoading] = useState(false);

  // Tabs: overview (existing detail) | attendance (last 30 days).
  // Attendance is fetched when the modal opens, keyed on emp only — the
  // previous lazy-on-tab version listed its own loading flag in the effect
  // deps, so setting it re-ran the effect and the cleanup cancelled the
  // in-flight fetch: the result was discarded and the tab showed
  // "Loading…" forever. Same proven pattern as the weekly/detail fetches.
  const [tab, setTab] = useState("overview");
  const [att, setAtt] = useState(null);
  const [attLoading, setAttLoading] = useState(false);
  const [attError, setAttError] = useState(null);
  useEffect(() => { setTab("overview"); }, [emp]);
  useEffect(() => {
    if (!emp) { setAtt(null); setAttError(null); return; }
    let cancelled = false;
    (async () => {
      setAttLoading(true); setAtt(null); setAttError(null);
      try {
        const a = await fetchJson(`/api/availability/employees/${encodeURIComponent(emp.code)}/attendance?days=30`);
        if (!cancelled) setAtt(a);
      } catch (e) { if (!cancelled) setAttError(String(e.message || e)); }
      finally { if (!cancelled) setAttLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [emp]);

  useEffect(() => {
    if (!emp) { setWeekly(null); return; }
    let cancelled = false;
    (async () => {
      setWeeklyLoading(true);
      try {
        const w = await fetchJson(`/api/availability/employees/${encodeURIComponent(emp.code)}/weekly`);
        if (!cancelled) setWeekly(w);
      } catch { if (!cancelled) setWeekly(null); }
      finally { if (!cancelled) setWeeklyLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [emp]);

  useEffect(() => {
    if (!emp) { setDetail(null); setError(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const d = await fetchJson(`/api/availability/employees/${encodeURIComponent(emp.code)}/detail`);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [emp]);

  // ── One-pager PDF export ──
  // The ResourceOnePager mounts off-screen only while exporting; html2canvas
  // captures it at 2× and jsPDF wraps it as a single A4 page (scaled to fit).
  const [exporting, setExporting] = useState(false);
  const onePagerRef = useRef(null);
  const exportPdf = async () => {
    if (exporting || !detail || !emp) return;
    setExporting(true);
    try {
      await new Promise(r => setTimeout(r, 120)); // let the hidden sheet mount + paint
      const el = onePagerRef.current;
      if (!el) throw new Error("export node missing");
      const html2canvas = (await import("html2canvas")).default;
      const { jsPDF } = await import("jspdf");
      const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 2, useCORS: true, logging: false });
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const ratio = canvas.height / canvas.width;
      let w = pw, h = pw * ratio;
      if (h > ph) { h = ph; w = ph / ratio; } // taller than A4 → fit height
      pdf.addImage(canvas.toDataURL("image/png"), "PNG", (pw - w) / 2, 0, w, h);
      pdf.save(`${(cleanName(emp) || "resource").replace(/[^\w-]+/g, "_")}_profile.pdf`);
    } catch (e) {
      console.error("one-pager export failed", e);
    } finally {
      setExporting(false);
    }
  };

  // ── Skills (practice-head assigned) ──
  const [skills, setSkills] = useState([]);
  const [canEditSkills, setCanEditSkills] = useState(false);
  const [newSkill, setNewSkill] = useState("");
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillErr, setSkillErr] = useState(null);
  useEffect(() => {
    setSkills((detail && detail.skills) || []);
    setCanEditSkills(!!(detail && detail.can_edit_skills));
  }, [detail]);
  const addSkill = async (explicit) => {
    const s = (explicit != null ? explicit : newSkill).trim();
    if (!s || skillBusy || !emp) return;
    setSkillBusy(true); setSkillErr(null);
    try {
      const r = await fetchJson(`/api/availability/employees/${encodeURIComponent(emp.code)}/skills`,
        { method: "POST", body: JSON.stringify({ skill: s }) });
      setSkills(r.skills || []); setNewSkill("");
    } catch (e) { setSkillErr(String(e.message || e)); }
    finally { setSkillBusy(false); }
  };
  const removeSkill = async (s) => {
    if (skillBusy || !emp) return;
    setSkillBusy(true); setSkillErr(null);
    try {
      const r = await fetchJson(`/api/availability/employees/${encodeURIComponent(emp.code)}/skills?skill=${encodeURIComponent(s)}`,
        { method: "DELETE" });
      setSkills(r.skills || []);
    } catch (e) { setSkillErr(String(e.message || e)); }
    finally { setSkillBusy(false); }
  };

  if (!emp) return null;
  const status = emp.status || "Bench";
  const c = STATUS_COLOR[status] || STATUS_COLOR.Bench;
  const allocPct = Math.max(0, Math.min(100, Number(emp.allocation_pct || 0)));

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 760, maxHeight: "88vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
            <div style={{
              width: 48, height: 48, borderRadius: "50%",
              background: avatarTint(cleanName(emp)) + "22",
              color: avatarTint(cleanName(emp)),
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 700, fontSize: 17, flexShrink: 0,
            }}>{initials(cleanName(emp))}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.textPrimary }}>{cleanName(emp)}</h2>
                {emp.code && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                    background: C.surfaceAlt, color: C.textSecondary, border: `1px solid ${C.border}`,
                    fontVariantNumeric: "tabular-nums",
                  }}>{emp.code}</span>
                )}
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                  background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
                }}>{status}</span>
              </div>
              <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 4 }}>
                {emp.position || "—"}{emp.department && ` · ${emp.department}`}{emp.location && ` · ${emp.location}`}
              </div>
              {detail?.profile?.email && (
                <a href={`mailto:${detail.profile.email}`} style={{ fontSize: 12, color: C.accent, fontWeight: 600, textDecoration: "none", marginTop: 2, display: "inline-block" }}>
                  {detail.profile.email}
                </a>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 4, padding: "0 24px", borderBottom: `1px solid ${C.border}`, background: C.surface }}>
          {[["overview", "Overview"], ["attendance", "Attendance (30d)"]].map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} style={{
              padding: "10px 14px", border: "none", background: "transparent", cursor: "pointer",
              fontSize: 13, fontWeight: 700,
              color: tab === key ? C.accent : C.textMuted,
              borderBottom: tab === key ? `2px solid ${C.accent}` : "2px solid transparent",
              marginBottom: -1,
            }}>{label}</button>
          ))}
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {tab === "attendance" && <AttendanceTab data={att} loading={attLoading} error={attError} />}
          {tab === "overview" && <>
          {/* Snapshot row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Peak allocation</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.textPrimary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{Math.round(allocPct)}%</div>
              <div style={{ height: 4, background: C.border, borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${allocPct}%`, background: c.fg }} />
              </div>
            </div>
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Projects (current)</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.textPrimary, marginTop: 4 }}>{emp.project_count || 0}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{emp.competency || "—"}</div>
            </div>
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Hours / last 90d</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: Number(emp.hrs_90d) === 0 ? C.danger : C.textPrimary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {Math.round(Number(emp.hrs_90d || 0))}h
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{Number(emp.hrs_90d) === 0 ? "No timesheet activity" : "logged hours"}</div>
            </div>
            <div style={{ background: C.surfaceAlt, borderRadius: 10, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Tenure</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.textPrimary, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                {detail?.profile?.tenure_label || detail?.profile?.employee_type || (loading ? "…" : "—")}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {detail?.profile?.tenure_label
                  ? [`since ${detail.profile.joining_date}`, detail.profile.employee_type].filter(Boolean).join(" · ")
                  : (detail?.profile?.employee_status || "—")}
              </div>
            </div>
          </div>

          {error && (
            <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {/* Skills (practice-head assigned; feed the find-best-fit ranker) */}
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
              <Star size={14} /> Skills
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              {skills.length === 0 && (
                <span style={{ fontSize: 13, color: C.textMuted }}>
                  {canEditSkills ? "No skills assigned yet — add some below." : "No skills assigned yet."}
                </span>
              )}
              {skills.map((s) => (
                <span key={s} style={{
                  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
                  borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                  background: C.accent + "18", color: C.accent, border: `1px solid ${C.accent}40`,
                }}>
                  {s}
                  {canEditSkills && (
                    <button onClick={() => removeSkill(s)} disabled={skillBusy} title="Remove skill"
                      style={{ display: "inline-flex", background: "none", border: "none", cursor: "pointer", color: C.accent, padding: 0, opacity: skillBusy ? 0.5 : 0.8 }}>
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEditSkills && (() => {
              const suggestions = suggestionsFor(emp.department, detail && detail.projects && detail.projects[0] && detail.projects[0].competency, skills);
              return (
                <>
                  <div style={{ marginTop: 10, display: "flex", gap: 8, maxWidth: 460 }}>
                    <input
                      list="skill-suggestions"
                      value={newSkill}
                      onChange={(e) => setNewSkill(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSkill(); } }}
                      placeholder="Add a skill (e.g. SAP FICO, Qlik Sense, Python)…"
                      maxLength={80}
                      style={{
                        flex: 1, padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
                        background: C.surface, color: C.textPrimary, fontSize: 13, outline: "none",
                      }}
                    />
                    <datalist id="skill-suggestions">
                      {suggestions.map((s) => <option key={s} value={s} />)}
                    </datalist>
                    <button onClick={() => addSkill()} disabled={skillBusy || !newSkill.trim()} style={{
                      padding: "8px 14px", borderRadius: 8, border: "none", cursor: (skillBusy || !newSkill.trim()) ? "default" : "pointer",
                      background: C.accent, color: "#fff", fontWeight: 600, fontSize: 13,
                      display: "inline-flex", alignItems: "center", gap: 6, opacity: (skillBusy || !newSkill.trim()) ? 0.6 : 1,
                    }}>
                      <Plus size={14} /> Add
                    </button>
                  </div>
                  {suggestions.length > 0 && (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>Suggested:</span>
                      {suggestions.slice(0, 8).map((s) => (
                        <button key={s} onClick={() => addSkill(s)} disabled={skillBusy} title={`Add ${s}`}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 9px",
                            borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: skillBusy ? "default" : "pointer",
                            background: C.surfaceAlt, color: C.textSecondary, border: `1px solid ${C.border}`,
                          }}>
                          <Plus size={11} /> {s}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
            {skillErr && <div style={{ fontSize: 12, color: "#991B1B", marginTop: 6 }}>{skillErr}</div>}
          </div>

          {/* Weekly allocation timeline (past → planned) */}
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
              <Calendar size={14} /> Weekly allocation
            </h3>
            <WeeklyTimeline data={weekly} loading={weeklyLoading} />
          </div>

          {/* Projects */}
          <div style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
              <Briefcase size={14} /> Project allocations
            </h3>
            {loading && !detail ? (
              <div style={{ padding: 20, color: C.textMuted, fontSize: 13 }}>Loading…</div>
            ) : detail && detail.projects && detail.projects.length > 0 ? (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                {detail.projects.map((p, i) => {
                  const pct = Math.max(0, Math.min(100, Number(p.allocation_pct || 0)));
                  const pColor = pct >= 100 ? STATUS_COLOR.Allocated.fg : pct > 0 ? STATUS_COLOR.Partial.fg : STATUS_COLOR.Bench.fg;
                  return (
                    <div key={i} style={{
                      padding: "12px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                      display: "grid", gridTemplateColumns: "1fr 90px", gap: 14, alignItems: "center",
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.project_name || p.project_id}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {[p.client_name, p.project_type, p.competency].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      <div>
                        <div style={{ height: 6, background: C.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct}%`, background: pColor }} />
                        </div>
                        <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{Math.round(pct)}%</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
                No project allocations on record.
              </div>
            )}
          </div>

          {/* Plan vs actuals — this week's allocation plan against 90d logged hours */}
          {detail?.plan_vs_actual?.items?.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
                <TrendingUp size={14} /> Plan vs actuals
              </h3>
              {(detail.plan_vs_actual.not_logging > 0 || detail.plan_vs_actual.unplanned > 0) && (
                <div style={{ fontSize: 12, color: "#B45309", fontWeight: 600, marginBottom: 8 }}>
                  {[
                    detail.plan_vs_actual.not_logging > 0 ? `${detail.plan_vs_actual.not_logging} allocated project${detail.plan_vs_actual.not_logging > 1 ? "s" : ""} with no logged hours` : null,
                    detail.plan_vs_actual.unplanned > 0 ? `${detail.plan_vs_actual.unplanned} project${detail.plan_vs_actual.unplanned > 1 ? "s" : ""} logged without an allocation` : null,
                  ].filter(Boolean).join(" · ")}
                </div>
              )}
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "8px 14px", display: "grid", gridTemplateColumns: "1fr 110px 110px 60px", gap: 12, fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px", background: C.surfaceAlt }}>
                  <span>Project</span>
                  <span style={{ textAlign: "right" }}>Planned</span>
                  <span style={{ textAlign: "right" }}>Logged share</span>
                  <span style={{ textAlign: "right" }}>Hours</span>
                </div>
                {detail.plan_vs_actual.items.map((r, i) => {
                  const planned = Math.max(0, Math.min(100, Number(r.planned_pct || 0)));
                  const share = Math.max(0, Math.min(100, Number(r.share_pct || 0)));
                  return (
                    <div key={i} style={{
                      padding: "10px 14px", borderTop: `1px solid ${C.border}`,
                      display: "grid", gridTemplateColumns: "1fr 110px 110px 60px", gap: 12, alignItems: "center",
                    }}>
                      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.project_name}</span>
                        {r.flag === "not_logging" && (
                          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#FEF3C7", color: "#B45309" }}>Not logging</span>
                        )}
                        {r.flag === "unplanned" && (
                          <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#E0F2FE", color: "#0A5F89" }}>Unplanned</span>
                        )}
                      </div>
                      <div>
                        <div style={{ height: 6, background: C.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${planned}%`, background: STATUS_COLOR.Allocated.fg }} />
                        </div>
                        <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{Math.round(Number(r.planned_pct || 0))}%</div>
                      </div>
                      <div>
                        <div style={{ height: 6, background: C.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${share}%`, background: C.accent }} />
                        </div>
                        <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 4, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{share}%</div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(Number(r.hrs_90d || 0))}h</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Timesheet by project */}
          <div>
            <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
              <Clock size={14} /> Timesheet activity (last 90 days)
            </h3>
            {loading && !detail ? (
              <div style={{ padding: 20, color: C.textMuted, fontSize: 13 }}>Loading…</div>
            ) : detail && detail.timesheet && detail.timesheet.by_project && detail.timesheet.by_project.length > 0 ? (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                {detail.timesheet.by_project.map((t, i) => {
                  const totalHrs = Number(detail.timesheet.total_hrs_90d || 1);
                  const bar = Math.min(100, (Number(t.hrs || 0) / totalHrs) * 100);
                  return (
                    <div key={i} style={{
                      padding: "12px 14px", borderTop: i === 0 ? "none" : `1px solid ${C.border}`,
                      display: "grid", gridTemplateColumns: "1fr 110px 90px", gap: 12, alignItems: "center",
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.project}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t.tickets} ticket{t.tickets === 1 ? "" : "s"}{t.last_entry ? ` · last ${t.last_entry}` : ""}</div>
                      </div>
                      <div>
                        <div style={{ height: 6, background: C.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${bar}%`, background: C.accent }} />
                        </div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(Number(t.hrs || 0))}h</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
                No timesheet entries in the last 90 days.
              </div>
            )}
          </div>
          </>}
        </div>

        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: C.surfaceAlt }}>
          <button onClick={exportPdf} disabled={exporting || !detail} title="Download a staffing-ready PDF profile" style={{
            padding: "9px 16px", borderRadius: 8, border: "none",
            background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`, color: "#fff",
            fontWeight: 700, fontSize: 13, cursor: (exporting || !detail) ? "default" : "pointer",
            display: "inline-flex", alignItems: "center", gap: 6, opacity: (exporting || !detail) ? 0.6 : 1,
          }}>
            {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            {exporting ? "Exporting…" : "Export one-pager (PDF)"}
          </button>
          <button onClick={onClose} style={{
            padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}>Close</button>
        </div>
        {exporting && <ResourceOnePager emp={emp} detail={detail} att={att} innerRef={onePagerRef} />}
      </div>
    </div>
  );
};

// ─── Task Detail Modal ───
// Opens when a saved task is clicked. Renders:
//   - Title + status pill + dept · created date
//   - Project description (if set)
//   - Skills / keywords (parsed CSV)
//   - Assignees list: each row = the employee snapshot stored in
//     ai_reasoning at save time (name/position/status/allocation/competency)
//     plus the AI's per-person reasoning and match score. Clicking an
//     assignee row swaps to the EmployeeDetailModal for that person.
//   - Footer: status dropdown + delete button.
const TaskDetailModal = ({ task, onClose, onOpenEmployee, onToggleStatus, onDelete }) => {
  if (!task) return null;

  const assignedCodes = Array.isArray(task.assigned_employee_codes) ? task.assigned_employee_codes : [];
  const reasoningBlob = (task.ai_reasoning && typeof task.ai_reasoning === "object") ? task.ai_reasoning : {};
  const assignees = assignedCodes
    .map(code => ({ code, ...(reasoningBlob[code] || {}) }))
    .sort((a, b) => (a.rank || 99) - (b.rank || 99));

  const skillTokens = (task.skills_keywords || "")
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const status = task.status || "open";
  const STATUS_BADGE = {
    open:        { fg: "#1D4ED8", bg: "#DBEAFE" },
    in_progress: { fg: "#B45309", bg: "#FEF3C7" },
    done:        { fg: "#0E7E3E", bg: "#DCFCE7" },
  };
  const sb = STATUS_BADGE[status] || STATUS_BADGE.open;
  const statusLabel = status === "in_progress" ? "In progress" : status.charAt(0).toUpperCase() + status.slice(1);
  const createdAt = task.created_at ? String(task.created_at).split(".")[0].replace("T", " ") : null;

  // Confirm-then-delete inline (avoids window.confirm chained inside modal which iOS handles weirdly).
  const handleDeleteClick = () => {
    if (window.confirm(`Delete task "${task.name}"? This cannot be undone.`)) {
      onDelete && onDelete(task.id);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 16, width: "100%", maxWidth: 820, maxHeight: "88vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: C.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
                <Sparkles size={18} color={C.accent} /> {task.name}
              </h2>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                background: sb.bg, color: sb.fg,
              }}>{statusLabel}</span>
            </div>
            <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 6 }}>
              {task.department || "—"}
              {createdAt && <> · <span style={{ color: C.textMuted }}>created {createdAt}</span></>}
              {" · "}
              {assignees.length > 0
                ? `${assignees.length} assignee${assignees.length === 1 ? "" : "s"}`
                : "unassigned"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {/* Description */}
          {(task.description || "").trim() && (
            <div style={{ marginBottom: 18, padding: "12px 14px", background: C.surfaceAlt, borderRadius: 10, fontSize: 13, color: C.textSecondary, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {task.description}
            </div>
          )}

          {/* Skills / keywords */}
          {skillTokens.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Skills / keywords</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {skillTokens.map((s, i) => (
                  <span key={i} style={{
                    fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999,
                    background: `${C.accent}15`, color: C.accentDark,
                  }}>{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Assignees */}
          <h3 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: C.textPrimary, textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: 6 }}>
            <Users size={14} /> Assigned employees
          </h3>
          {assignees.length === 0 ? (
            <div style={{ padding: 14, color: C.textMuted, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
              No employees were assigned to this task.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {assignees.map(a => {
                const sc = STATUS_COLOR[a.status] || STATUS_COLOR.Bench;
                const allocPct = Math.max(0, Math.min(100, Number(a.allocation_pct || 0)));
                const empPayload = a.name ? {
                  code: a.code, name: a.name, position: a.position || "",
                  department: a.department || "", location: a.location || "",
                  competency: a.competency || "", status: a.status || "Bench",
                  allocation_pct: a.allocation_pct ?? 0, hrs_90d: a.hrs_90d ?? 0,
                  project_count: 0,
                } : null;
                return (
                  <div
                    key={a.code}
                    onClick={() => empPayload && onOpenEmployee && onOpenEmployee(empPayload)}
                    style={{
                      padding: 14, border: `1px solid ${C.border}`, borderRadius: 12,
                      cursor: empPayload ? "pointer" : "default",
                      display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 12, alignItems: "flex-start",
                      transition: "box-shadow 0.15s, transform 0.15s",
                    }}
                    onMouseEnter={e => { if (empPayload) { e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(-1px)"; } }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: "50%",
                      background: a.name ? (avatarTint(a.name) + "22") : C.surfaceAlt,
                      color: a.name ? avatarTint(a.name) : C.textMuted,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: 13, flexShrink: 0,
                    }}>{a.name ? initials(a.name) : "?"}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.textPrimary }}>{a.name || a.code}</div>
                        {a.rank && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                            background: a.rank === 1 ? `${C.accent}22` : C.surfaceAlt,
                            color: a.rank === 1 ? C.accentDark : C.textSecondary,
                          }}>#{a.rank}</span>
                        )}
                        {a.status && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                            background: sc.bg, color: sc.fg,
                          }}>{a.status}</span>
                        )}
                        {a.match_score != null && (
                          <span style={{
                            fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                            background: `${C.info}15`, color: C.info,
                          }}>
                            <Star size={10} style={{ marginRight: 4, verticalAlign: "middle" }} />
                            {a.match_score}/100
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                        {a.position || "—"}
                        {a.competency && a.competency !== a.position && ` · ${a.competency}`}
                        {a.allocation_pct != null && ` · ${Math.round(allocPct)}% allocated at time of selection`}
                        {a.hrs_90d != null && ` · ${Math.round(Number(a.hrs_90d))}h / 90d`}
                      </div>
                      {a.reasoning && (
                        <div style={{ fontSize: 13, color: C.textSecondary, marginTop: 8, lineHeight: 1.5 }}>
                          {a.reasoning}
                        </div>
                      )}
                    </div>
                    {empPayload && (
                      <div style={{ alignSelf: "center", color: C.textMuted, flexShrink: 0 }}>
                        <ArrowRight size={16} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — status + delete */}
        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, background: C.surfaceAlt }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Status</span>
            <select
              value={status}
              onChange={e => onToggleStatus && onToggleStatus(task.id, e.target.value)}
              style={{
                padding: "7px 12px", borderRadius: 8, border: `1px solid ${C.border}`,
                background: C.surface, color: C.textPrimary, fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleDeleteClick} style={{
              padding: "9px 14px", borderRadius: 8, border: `1px solid ${C.danger}`,
              background: "transparent", color: C.danger, fontWeight: 600, fontSize: 13, cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}>
              <Trash2 size={14} /> Delete
            </button>
            <button onClick={onClose} style={{
              padding: "9px 16px", borderRadius: 8, border: `1px solid ${C.border}`,
              background: C.surface, color: C.textSecondary, fontWeight: 600, fontSize: 13, cursor: "pointer",
            }}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Main Page ───
// ─── Bench Radar — upcoming roll-offs ───
// People who are effectively booked TODAY (>=80% allocated) but whose
// forward-planned allocation drops to <=50% within the horizon. This is the
// early-warning view the flat bench list can't give: capacity you can plan
// for BEFORE it sits idle. Clicking a row opens the employee detail modal.
const BenchRadarPanel = ({ onOpen }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchJson("/api/availability/bench-radar?weeks=8");
        if (!cancelled) {
          setData(d);
          // Auto-expand when someone frees up within a fortnight — that's
          // actionable now; otherwise stay collapsed with the count visible.
          if ((d.items || []).some(i => i.weeks_until <= 2)) setOpen(true);
        }
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
    })();
    return () => { cancelled = true; };
  }, []);

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
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: items.length ? "#FEF3C7" : C.surfaceAlt, color: items.length ? "#B45309" : C.textMuted }}>
            {items.length ? `${items.length} rolling off in the next ${data.weeks_horizon} weeks` : `no roll-offs in the next ${data.weeks_horizon} weeks`}
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
              onClick={() => onOpen && onOpen({ code: it.code, name: it.name, department: it.dept, position: it.position })}
              style={{
                padding: 12, border: `1px solid ${C.border}`, borderRadius: 10, cursor: "pointer",
                display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "center",
                transition: "box-shadow 0.15s, transform 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.06)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
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
                background: it.full_free ? "#DCFCE7" : "#FEF3C7",
                color: it.full_free ? "#0E7E3E" : "#B45309",
              }}>
                {it.full_free ? "fully free" : "partially free"} in {it.weeks_until}w · wk of {fmtWk(it.rolloff_week)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Capacity heatmap (people × weeks) ───
// Each cell = that week's total Flag='Allocated' percent from the weekly
// allocation feed (which extends into FORWARD-PLANNED weeks) — green is FREE
// capacity, red is fully booked, deep red is overallocated, matching the
// engine's existing bench=green / allocated=red vocabulary. Semantic status
// tints are intentionally literal hex (same rule as the status badges).
const heatCell = (pct) => {
  if (pct <= 0)   return { bg: "#DCFCE7", fg: "#0E7E3E" };   // free
  if (pct < 50)   return { bg: "#FEF9C3", fg: "#854D0E" };   // lightly loaded
  if (pct < 100)  return { bg: "#FDE68A", fg: "#92400E" };   // partial
  if (pct <= 110) return { bg: "#FECACA", fg: "#9F1239" };   // fully booked
  return { bg: "#E11D48", fg: "#FFFFFF" };                    // overallocated
};

const CapacityHeatmap = ({ department, searchTerm, onOpen }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const d = await fetchJson(`/api/availability/capacity?department=${encodeURIComponent(department || "")}`);
        if (!cancelled) setData(d);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [department]);

  if (loading && !data) {
    return <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}><Loader2 size={24} className="spin" /><div style={{ marginTop: 8 }}>Loading capacity grid…</div></div>;
  }
  if (error) {
    return <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}><AlertCircle size={16} /> {error}</div>;
  }
  if (!data) return null;

  const weeks = data.weeks || [];
  const weekNos = data.week_nos || [];
  const cur = data.current_week;
  const firstFuture = weeks.findIndex(w => cur && w > cur);
  const term = (searchTerm || "").trim().toLowerCase();
  const people = (data.people || []).filter(p =>
    !term || `${p.name} ${p.code} ${p.dept}`.toLowerCase().includes(term));

  const legend = [
    ["Free", heatCell(0)], ["Partial", heatCell(60)],
    ["Booked", heatCell(100)], ["Overallocated", heatCell(120)],
  ];
  const CELL_W = 34;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {legend.map(([label, c0]) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: C.textSecondary, fontWeight: 600 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: c0.bg, border: `1px solid ${C.border}` }} /> {label}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 11, color: C.accent, fontWeight: 600 }}>← past · now (dashed) · planned →</span>
      </div>
      {data.truncated && (
        <div style={{ fontSize: 12, color: "#B45309", fontWeight: 600, marginBottom: 10 }}>
          Showing {people.length} of {data.total_people} people — pick a department to see everyone.
        </div>
      )}
      {people.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: C.textMuted, fontSize: 13 }}>No people match the current filters.</div>
      ) : (
        <div style={{ overflowX: "auto", paddingBottom: 4 }}>
          {/* Header row: week numbers */}
          <div style={{ display: "grid", gridTemplateColumns: `230px repeat(${weeks.length}, ${CELL_W}px)`, gap: 2, alignItems: "center", marginBottom: 2 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.5px" }}>Resource · week #</div>
            {weeks.map((w, i) => (
              <div key={w} title={w} style={{
                fontSize: 9.5, color: i === firstFuture ? C.accent : C.textMuted, textAlign: "center", fontWeight: 700,
                borderLeft: i === firstFuture ? `2px dashed ${C.accent}` : "2px solid transparent",
              }}>{weekNos[i] || ""}</div>
            ))}
          </div>
          {people.map((p) => (
            <div key={p.code} style={{ display: "grid", gridTemplateColumns: `230px repeat(${weeks.length}, ${CELL_W}px)`, gap: 2, alignItems: "center", marginBottom: 2 }}>
              <button onClick={() => onOpen({ code: p.code, name: p.name, department: p.dept })} title={`Open ${cleanName(p)}`} style={{
                textAlign: "left", background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px",
                fontSize: 12, fontWeight: 600, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {cleanName(p)} <span style={{ color: C.textMuted, fontWeight: 500 }}>· {p.code}</span>
              </button>
              {weeks.map((w, i) => {
                const pct = Math.round(Number(p.pcts?.[i] ?? 0));
                const c0 = heatCell(pct);
                const future = firstFuture >= 0 && i >= firstFuture;
                return (
                  <div key={w} title={`${cleanName(p)} · ${w} · ${pct}%${future ? " (planned)" : ""}`} style={{
                    height: 24, borderRadius: 4, background: c0.bg, opacity: future ? 0.65 : 1,
                    borderLeft: i === firstFuture ? `2px dashed ${C.accent}` : "none",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 9, fontWeight: 800, color: c0.fg, fontVariantNumeric: "tabular-nums",
                  }}>{pct > 100 ? pct : ""}</div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const AvailabilityEnginePage = () => {
  const [kpis, setKpis] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [skills, setSkills] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [locations, setLocations] = useState([]);
  const [tasks, setTasks] = useState([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [skillFilter, setSkillFilter] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");

  // Loading / error
  const [loadingList, setLoadingList] = useState(true);
  const [errorList, setErrorList] = useState(null);

  // Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [bestFitOpen, setBestFitOpen] = useState(false);
  const [bestFitLoading, setBestFitLoading] = useState(false);
  const [bestFitError, setBestFitError] = useState(null);
  const [bestFitProject, setBestFitProject] = useState(null);
  const [bestFitRecs, setBestFitRecs] = useState([]);
  const [savingTask, setSavingTask] = useState(false);

  // Employee detail drawer state
  const [detailEmp, setDetailEmp] = useState(null);

  // View mode: card grid | capacity heatmap (people × weeks)
  const [viewMode, setViewMode] = useState("cards");

  // Saved-task detail modal state
  const [selectedTask, setSelectedTask] = useState(null);

  const searchDebounce = useRef(null);

  // ── Initial fetches (KPIs + skills + departments + tasks) ──
  useEffect(() => {
    (async () => {
      try {
        const [k, s, d, t, loc] = await Promise.all([
          fetchJson("/api/availability/kpis"),
          fetchJson("/api/availability/skills"),
          fetchJson("/api/availability/departments"),
          fetchJson("/api/availability/tasks"),
          fetchJson("/api/availability/locations"),
        ]);
        setKpis(k);
        setSkills(s.skills || []);
        setDepartments(d.departments || []);
        setTasks(t.tasks || []);
        setLocations(loc.locations || []);
      } catch (e) {
        console.error("[AvailabilityEngine] init error:", e);
      }
    })();
  }, []);

  // ── Fetch the whole active workforce ONCE, then filter client-side. ──
  // (Filtering server-side per keystroke was unreliable; with ~1.2k employees
  // client-side filtering is instant and robust.)
  const fetchEmployees = useCallback(async () => {
    setLoadingList(true);
    setErrorList(null);
    try {
      const data = await fetchJson(`/api/availability/employees?limit=2000`);
      setEmployees(data.employees || []);
    } catch (e) {
      setErrorList(String(e.message || e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  // Search (name incl. code, position, dept, location, competency, code) +
  // status + skill, all applied client-side over the loaded list.
  const filteredEmployees = useMemo(() => {
    let list = employees;
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      list = list.filter((e) => {
        const hay = [e.name, cleanName(e), e.position, e.department, e.location, e.competency, e.code]
          .filter(Boolean).join(" ").toLowerCase();
        return term.split(/\s+/).every((w) => hay.includes(w));
      });
    }
    if (statusFilter) list = list.filter((e) => (e.status || "") === statusFilter);
    if (deptFilter) list = list.filter((e) => (e.department || "") === deptFilter);
    if (skillFilter) {
      const sk = skillFilter.toLowerCase();
      // Match competency, position OR department — so picking a practice like
      // "Qlik" (which is a department, not just a competency value) returns the
      // whole practice, matching what the chat agent considers "Qlik".
      list = list.filter((e) =>
        (e.competency || "").toLowerCase().includes(sk) ||
        (e.position || "").toLowerCase().includes(sk) ||
        (e.department || "").toLowerCase().includes(sk));
    }
    return list;
  }, [employees, searchTerm, statusFilter, deptFilter, skillFilter]);

  // ── Create task: Find Best Fit ──
  const handleFindBestFit = async (payload) => {
    setBestFitLoading(true);
    setBestFitError(null);
    try {
      const data = await fetchJson("/api/availability/find-best-fit", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setBestFitProject(payload);
      setBestFitRecs(data.recommendations || []);
      setCreateOpen(false);
      setBestFitOpen(true);
    } catch (e) {
      setBestFitError(String(e.message || e));
    } finally {
      setBestFitLoading(false);
    }
  };

  // ── Save the task with selected assignees ──
  const handleSaveTask = async (selectedCodes) => {
    if (!bestFitProject) return;
    setSavingTask(true);
    try {
      // Snapshot employee info alongside the AI reasoning so the task
      // detail modal renders rich info even after the assignees fall out
      // of the current filtered employee list (or move depts, etc.).
      const reasoningByCode = {};
      bestFitRecs.forEach(r => {
        const e = r.employee || {};
        reasoningByCode[r.code] = {
          rank: r.rank,
          match_score: r.match_score,
          reasoning: r.reasoning,
          name: e.name || null,
          position: e.position || null,
          department: e.department || null,
          location: e.location || null,
          status: e.status || null,
          allocation_pct: e.allocation_pct ?? null,
          competency: e.competency || null,
          hrs_90d: e.hrs_90d ?? null,
        };
      });
      const body = {
        ...bestFitProject,
        assigned_employee_codes: selectedCodes,
        ai_reasoning: reasoningByCode,
      };
      await fetchJson("/api/availability/tasks", { method: "POST", body: JSON.stringify(body) });
      const t = await fetchJson("/api/availability/tasks");
      setTasks(t.tasks || []);
      setBestFitOpen(false);
    } catch (e) {
      alert("Failed to save task: " + (e.message || e));
    } finally {
      setSavingTask(false);
    }
  };

  const handleDeleteTask = async (id) => {
    if (!window.confirm("Delete this task?")) return;
    try {
      await fetchJson(`/api/availability/tasks/${id}`, { method: "DELETE" });
      setTasks(ts => ts.filter(t => t.id !== id));
    } catch (e) {
      alert("Delete failed: " + (e.message || e));
    }
  };

  const handleToggleStatus = async (id, status) => {
    try {
      await fetchJson(`/api/availability/tasks/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      setTasks(ts => ts.map(t => t.id === id ? { ...t, status } : t));
    } catch (e) {
      alert("Update failed: " + (e.message || e));
    }
  };

  const kpiBlocks = useMemo(() => ([
    { label: "Total Employees", key: "total_employees", accent: C.info,        subtitle: "active workforce" },
    { label: "On Bench",        key: "on_bench",        accent: "#10B981",     subtitle: "available now" },
    { label: "Partial",         key: "partial",         accent: C.warning,     subtitle: "some capacity" },
    { label: "Allocated",       key: "allocated",       accent: "#9333EA",     subtitle: "no capacity" },
    { label: "High Activity",   key: "high_activity",   accent: "#0EA5E9",     subtitle: "120+ hrs / 90d" },
    { label: "No Timesheet",    key: "no_timesheet",    accent: C.danger,      subtitle: "0 hrs logged" },
  ]), []);

  return (
    <div style={{ padding: 24, maxWidth: 1600, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.textPrimary, display: "flex", alignItems: "center", gap: 12 }}>
          Availability Engine
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999,
            background: `${C.accent}22`, color: C.accentDark, display: "inline-flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.accent }} />
            Enterprise AI · Connected to your data sources
          </span>
        </h1>
      </div>
      <p style={{ margin: "4px 0 20px", fontSize: 13, color: C.textMuted }}>Capacity, skills and engagement across the active workforce — backed by live BigQuery data.</p>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 16, marginBottom: 20 }}>
        {kpiBlocks.map(b => (
          <KPICard key={b.key} label={b.label} value={kpis?.[b.key]} accent={b.accent} subtitle={b.subtitle} />
        ))}
      </div>

      {/* Bench Radar — upcoming roll-offs (collapsible) */}
      <BenchRadarPanel onOpen={(e) => setDetailEmp(e)} />

      {/* Tasks panel (collapsible) */}
      <SavedTasksPanel tasks={tasks} onDelete={handleDeleteTask} onToggleStatus={handleToggleStatus} onOpen={setSelectedTask} />

      {/* Search + status + skill + Create Task row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 190px 190px 150px", gap: 12, marginBottom: 20 }}>
        <div style={{ position: "relative" }}>
          <Search size={16} style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: C.textMuted }} />
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search name, skill, position, location…"
            style={{
              width: "100%", padding: "12px 16px 12px 40px",
              border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 14,
              background: C.surface, color: C.textPrimary, boxSizing: "border-box",
            }}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{
          padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.surface, color: C.textPrimary, fontSize: 14, fontWeight: 600,
        }}>
          <option value="">All Statuses</option>
          <option value="Bench">Bench</option>
          <option value="Partial">Partial</option>
          <option value="Allocated">Allocated</option>
        </select>
        <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} style={{
          padding: "12px 14px", borderRadius: 10, border: `1px solid ${C.border}`,
          background: C.surface, color: C.textPrimary, fontSize: 14, fontWeight: 600,
        }}>
          <option value="">All Departments</option>
          {(departments || []).map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <SkillDropdown skills={skills} active={skillFilter} onChange={setSkillFilter} />
        <button onClick={() => setCreateOpen(true)} style={{
          padding: "12px 18px", borderRadius: 10, border: "none",
          background: `linear-gradient(135deg, ${C.accent}, ${C.accentDark})`,
          color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer",
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        }}>
          <Plus size={16} /> Create Task
        </button>
      </div>

      {/* View toggle: cards | capacity heatmap */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <div data-tour="avail-toggle" style={{ display: "inline-flex", background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3, gap: 2 }}>
          {[["cards", "Cards", LayoutGrid], ["heatmap", "Capacity heatmap", Grid3x3]].map(([key, label, Icon]) => (
            <button key={key} onClick={() => setViewMode(key)} style={{
              padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer",
              background: viewMode === key ? C.surface : "transparent",
              color: viewMode === key ? C.accentDark : C.textMuted,
              fontWeight: 700, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 6,
              boxShadow: viewMode === key ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
            }}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </div>

      {/* Employee grid / heatmap */}
      {errorList && (
        <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={16} /> {errorList}
        </div>
      )}
      {viewMode === "heatmap" ? (
        <>
          <CapacityHeatmap department={deptFilter} searchTerm={searchTerm} onOpen={(e) => setDetailEmp(e)} />
          <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, textAlign: "center" }}>
            Weekly allocated % per person, past and forward-planned weeks · click a name to drill in · status and skill filters apply to the card view
          </div>
        </>
      ) : loadingList ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
          <Loader2 size={24} className="spin" /> <div style={{ marginTop: 8 }}>Loading employees…</div>
        </div>
      ) : filteredEmployees.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted, background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 12 }}>
          <Users size={28} style={{ opacity: 0.4 }} />
          <div style={{ marginTop: 8, fontSize: 14 }}>No employees match the current filters.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {filteredEmployees.map(emp => <EmployeeCard key={emp.code} emp={emp} onClick={() => setDetailEmp(emp)} />)}
        </div>
      )}

      {viewMode === "cards" && (
        <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, textAlign: "center" }}>
          Showing {filteredEmployees.length} of {employees.length} active employees · status from current project allocations (real billable vs bench, latest actual weeks)
        </div>
      )}

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleFindBestFit}
        locations={locations}
        loading={bestFitLoading}
        error={bestFitError}
      />
      <BestFitResultsModal
        open={bestFitOpen}
        onClose={() => setBestFitOpen(false)}
        project={bestFitProject}
        recommendations={bestFitRecs}
        onSaveTask={handleSaveTask}
        saving={savingTask}
      />
      <EmployeeDetailModal emp={detailEmp} onClose={() => setDetailEmp(null)} />
      <TaskDetailModal
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onOpenEmployee={(emp) => { setSelectedTask(null); setDetailEmp(emp); }}
        onToggleStatus={(id, status) => { handleToggleStatus(id, status); setSelectedTask(t => t && t.id === id ? { ...t, status } : t); }}
        onDelete={(id) => { handleDeleteTask(id); setSelectedTask(null); }}
      />
    </div>
  );
};

export default AvailabilityEnginePage;
