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
  ArrowRight, TrendingUp, ChevronRight, FileText, Star
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
const CreateTaskModal = ({ open, onClose, onSubmit, departments, loading, error }) => {
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState("");

  useEffect(() => {
    if (!open) {
      setName(""); setDepartment(""); setDescription(""); setSkills("");
    }
  }, [open]);

  if (!open) return null;
  const canSubmit = name.trim() && department.trim() && !loading;

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
              Describe your project. Satori will scan the chosen department and recommend the best-fit employees based on availability, skills, and recent engagement.
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
            <label style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.6px" }}>Department *</label>
            <select value={department} onChange={e => setDepartment(e.target.value)} style={{
              width: "100%", marginTop: 6, padding: "10px 12px",
              border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14,
              background: C.surface, color: C.textPrimary, boxSizing: "border-box",
            }}>
              <option value="">Choose department...</option>
              {(departments || []).map(d => <option key={d} value={d}>{d}</option>)}
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
            onClick={() => onSubmit({ name: name.trim(), department, description: description.trim(), skills_keywords: skills.trim() })}
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
              For <strong style={{ color: C.textPrimary }}>{project?.name}</strong> in <strong style={{ color: C.textPrimary }}>{project?.department}</strong>. Ranked by availability, skill match, and recent engagement.
            </p>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {(!recommendations || recommendations.length === 0) ? (
            <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
              <AlertCircle size={32} style={{ opacity: 0.5 }} />
              <div style={{ marginTop: 12, fontSize: 14 }}>No candidates found in this department.</div>
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
// Drill-down for one employee. Fetches /api/availability/employees/{code}/detail
// when an employee is selected, then renders their projects (Allocation_data)
// and 90-day timesheet activity. The card-level fields (name, position,
// status, allocation bar) come from the card prop directly so the header
// renders instantly while the detail fetch is in flight.
const EmployeeDetailModal = ({ emp, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: C.textMuted, padding: 4 }}><X size={20} /></button>
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {/* Snapshot row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
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
          </div>

          {error && (
            <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertCircle size={16} /> {error}
            </div>
          )}

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
const AvailabilityEnginePage = () => {
  const [kpis, setKpis] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [skills, setSkills] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [tasks, setTasks] = useState([]);

  // Filters
  const [statusFilter, setStatusFilter] = useState("");
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

  // Saved-task detail modal state
  const [selectedTask, setSelectedTask] = useState(null);

  const searchDebounce = useRef(null);

  // ── Initial fetches (KPIs + skills + departments + tasks) ──
  useEffect(() => {
    (async () => {
      try {
        const [k, s, d, t] = await Promise.all([
          fetchJson("/api/availability/kpis"),
          fetchJson("/api/availability/skills"),
          fetchJson("/api/availability/departments"),
          fetchJson("/api/availability/tasks"),
        ]);
        setKpis(k);
        setSkills(s.skills || []);
        setDepartments(d.departments || []);
        setTasks(t.tasks || []);
      } catch (e) {
        console.error("[AvailabilityEngine] init error:", e);
      }
    })();
  }, []);

  // ── Employee list re-fetches on filter change ──
  const fetchEmployees = useCallback(async () => {
    setLoadingList(true);
    setErrorList(null);
    try {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set("status", statusFilter);
      if (skillFilter)  qs.set("skill", skillFilter);
      if (searchTerm.trim()) qs.set("q", searchTerm.trim());
      qs.set("limit", "500");
      const data = await fetchJson(`/api/availability/employees?${qs.toString()}`);
      setEmployees(data.employees || []);
    } catch (e) {
      setErrorList(String(e.message || e));
    } finally {
      setLoadingList(false);
    }
  }, [statusFilter, skillFilter, searchTerm]);

  // Debounce free-text search
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => { fetchEmployees(); }, 220);
    return () => searchDebounce.current && clearTimeout(searchDebounce.current);
  }, [fetchEmployees]);

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

      {/* Tasks panel (collapsible) */}
      <SavedTasksPanel tasks={tasks} onDelete={handleDeleteTask} onToggleStatus={handleToggleStatus} onOpen={setSelectedTask} />

      {/* Search + status + skill + Create Task row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 220px 180px", gap: 12, marginBottom: 20 }}>
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

      {/* Employee grid */}
      {errorList && (
        <div style={{ padding: "10px 14px", background: "#FEE2E2", color: "#991B1B", borderRadius: 8, fontSize: 13, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={16} /> {errorList}
        </div>
      )}
      {loadingList ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted }}>
          <Loader2 size={24} className="spin" /> <div style={{ marginTop: 8 }}>Loading employees…</div>
        </div>
      ) : employees.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.textMuted, background: C.surface, border: `1px dashed ${C.border}`, borderRadius: 12 }}>
          <Users size={28} style={{ opacity: 0.4 }} />
          <div style={{ marginTop: 8, fontSize: 14 }}>No employees match the current filters.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
          {employees.map(emp => <EmployeeCard key={emp.code} emp={emp} onClick={() => setDetailEmp(emp)} />)}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: C.textMuted, textAlign: "center" }}>
        Showing {employees.length} employees · status bands derived from MAX(allocation %) over the last 90 days
      </div>

      <CreateTaskModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleFindBestFit}
        departments={departments}
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
