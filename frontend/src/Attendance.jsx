// ─── Attendance ───
// Dedicated attendance surface (separate from the Availability Engine, which
// keeps its 30-day modal tab): the full employee directory with this-month
// stats, and a click-through to any person's COMPLETE attendance record laid
// out month by month — summary chips per month plus the day-by-day detail.
//
// Pairs with backend endpoints:
//   GET /api/attendance/employees                  (dept-scoped directory)
//   GET /api/attendance/employees/{code}/history   (full monthly history)
//
// Inline styles use the same CSS-variable token scheme as Growgnition.jsx so
// dark mode flips through `[data-satori-theme="dark"]` without per-element work.

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Search, Clock, ChevronLeft, ChevronDown, ChevronRight, CalendarDays,
  AlertCircle, Loader2, MapPin, Briefcase, UserCheck,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_BASE || "";

const C = {
  primary:       "var(--c-primary)",
  accent:        "#8AC441",
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

const authHeaders = () => {
  const token = localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const fetchJson = async (url) => {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.detail || j.error || detail; } catch (_) { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
};

// Resource_Name carries a code prefix ("E-1571 - Jane Doe") — strip for display.
const cleanName = (name, code) => {
  const raw = (name || "").trim();
  if (code) {
    const esc = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = raw.replace(new RegExp("^" + esc + "\\s*[-–—]?\\s*", "i"), "");
    if (stripped !== raw) return stripped.trim() || raw;
  }
  return raw.replace(/^[A-Za-z]{1,4}-\d+\s*[-–—]?\s*/, "").trim() || raw || "—";
};

const initials = (name) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";

const avatarTint = (name) => {
  const palette = ["#8AC441", "#0A5F89", "#353085", "#F59E0B", "#9333EA", "#0EA5E9", "#10B981", "#EF4444"];
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
};

// Status → chip palette (same semantic vocabulary as the rest of Satori).
const statusChip = (status) => {
  const s = (status || "").toLowerCase();
  if (s.includes("present"))  return { fg: "var(--sem-ok-fg, #065F46)",   bg: "var(--sem-ok-bg, #ECFDF5)" };
  if (s.includes("remote"))   return { fg: "#0A5F89", bg: "rgba(10,95,137,0.10)" };
  if (s.includes("leave"))    return { fg: "var(--sem-warn-fg, #92400E)", bg: "var(--sem-warn-bg, #FFFBEB)" };
  if (s.includes("absent"))   return { fg: "#B91C1C", bg: "rgba(239,68,68,0.10)" };
  if (s.includes("missing"))  return { fg: "#6D28D9", bg: "rgba(147,51,234,0.10)" };
  return { fg: "var(--c-text-muted)", bg: "var(--c-surface-alt)" };
};

const rateColor = (r) => (r == null ? C.textMuted : r >= 90 ? "#10B981" : r >= 75 ? C.warning : C.danger);

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];
const monthLabel = (mkey) => {
  const [y, m] = String(mkey || "").split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MONTH_NAMES[m - 1]} ${y}` : mkey;
};
const dayLabel = (iso) => {
  try {
    const d = new Date(iso + "T00:00:00");
    return { day: d.getDate(), wd: d.toLocaleDateString(undefined, { weekday: "short" }) };
  } catch { return { day: iso, wd: "" }; }
};

// ─── Small building blocks ─────────────────────────────────────────────────

const Chip = ({ label, value, fg, bg }) => (
  <div style={{
    display: "flex", flexDirection: "column", alignItems: "center", minWidth: 74,
    padding: "8px 12px", borderRadius: 10, background: bg || C.surfaceAlt,
  }}>
    <span style={{ fontSize: 16, fontWeight: 700, color: fg || C.textPrimary }}>{value ?? "—"}</span>
    <span style={{ fontSize: 10.5, color: C.textMuted, marginTop: 2, whiteSpace: "nowrap" }}>{label}</span>
  </div>
);

const Avatar = ({ name, size = 36 }) => (
  <div style={{
    width: size, height: size, borderRadius: "50%", flexShrink: 0,
    background: avatarTint(name), color: "#fff", display: "flex",
    alignItems: "center", justifyContent: "center",
    fontSize: size * 0.36, fontWeight: 700,
  }}>{initials(name)}</div>
);

// ─── Detail view: one employee, all months ─────────────────────────────────

const EmployeeHistory = ({ code, listRow, onBack }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openMonths, setOpenMonths] = useState({});

  useEffect(() => {
    let dead = false;
    setData(null); setError(null);
    fetchJson(`/api/attendance/employees/${encodeURIComponent(code)}/history`)
      .then((d) => { if (!dead) { setData(d); if (d.months?.length) setOpenMonths({ [d.months[0].month]: true }); } })
      .catch((e) => { if (!dead) setError(String(e.message || e)); });
    return () => { dead = true; };
  }, [code]);

  const name = cleanName(data?.profile?.name || listRow?.name, code);

  return (
    <div>
      <button onClick={onBack} style={{
        display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 16,
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: "8px 14px", cursor: "pointer", color: C.textPrimary, fontSize: 13, fontWeight: 600,
      }}>
        <ChevronLeft size={15} /> All employees
      </button>

      {error && (
        <div style={{ padding: 20, borderRadius: 12, background: "rgba(239,68,68,0.08)", color: "#B91C1C", fontSize: 13 }}>
          <AlertCircle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}
        </div>
      )}
      {!data && !error && (
        <div style={{ padding: 60, textAlign: "center", color: C.textMuted }}>
          <Loader2 size={22} className="spin" style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 13 }}>Loading full attendance history…</div>
        </div>
      )}

      {data && (
        <>
          {/* Header card: identity + overall record */}
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
            padding: 20, marginBottom: 16,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <Avatar name={name} size={52} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 19, fontWeight: 700, color: C.textPrimary }}>{name}</div>
                <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 3, display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <span>{data.profile?.code || code}</span>
                  {data.profile?.dept && <span><Briefcase size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />{data.profile.dept}{data.profile?.position ? ` · ${data.profile.position}` : ""}</span>}
                  {data.profile?.location && <span><MapPin size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />{data.profile.location}</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Chip label="Attendance" value={data.overall?.attendance_rate != null ? `${data.overall.attendance_rate}%` : "—"} fg={rateColor(data.overall?.attendance_rate)} />
                <Chip label="Avg check-in" value={data.overall?.avg_checkin} />
                <Chip label="Avg check-out" value={data.overall?.avg_checkout} />
                <Chip label="Late days" value={data.overall?.late} fg={data.overall?.late ? C.warning : undefined} />
                <Chip label="Months" value={data.overall?.months} />
              </div>
            </div>
          </div>

          {/* Month accordions, newest first */}
          {(data.months || []).map((m) => {
            const open = !!openMonths[m.month];
            return (
              <div key={m.month} style={{
                background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
                marginBottom: 12, overflow: "hidden",
              }}>
                <button
                  onClick={() => setOpenMonths((p) => ({ ...p, [m.month]: !p[m.month] }))}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 12,
                    padding: "14px 18px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  {open ? <ChevronDown size={16} color={C.textMuted} /> : <ChevronRight size={16} color={C.textMuted} />}
                  <span style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary, minWidth: 150 }}>
                    {monthLabel(m.month)}
                  </span>
                  <span style={{
                    fontSize: 12.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20,
                    color: "#fff", background: rateColor(m.attendance_rate),
                  }}>
                    {m.attendance_rate != null ? `${m.attendance_rate}%` : "—"}
                  </span>
                  <span style={{ fontSize: 12, color: C.textSecondary, flex: 1 }}>
                    {m.attended}/{m.working_days} working days · {m.late} late · avg in {m.avg_checkin || "—"} · out {m.avg_checkout || "—"}
                  </span>
                </button>

                {open && (
                  <div style={{ padding: "0 18px 16px" }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                      <Chip label="Working days" value={m.working_days} />
                      <Chip label="Present" value={m.present} fg="var(--sem-ok-fg, #065F46)" bg="var(--sem-ok-bg, #ECFDF5)" />
                      <Chip label="Remote" value={m.remote} fg="#0A5F89" bg="rgba(10,95,137,0.10)" />
                      <Chip label="On leave" value={m.on_leave} fg="var(--sem-warn-fg, #92400E)" bg="var(--sem-warn-bg, #FFFBEB)" />
                      <Chip label="Absent" value={m.absent} fg="#B91C1C" bg="rgba(239,68,68,0.10)" />
                      <Chip label="Missing punch" value={m.missing} fg="#6D28D9" bg="rgba(147,51,234,0.10)" />
                      <Chip label="Late / on-time" value={`${m.late} / ${m.ontime}`} />
                      <Chip label="Worked hrs" value={m.total_worked_hrs} />
                      <Chip label="Avg hrs/day" value={m.avg_worked_hrs} />
                    </div>

                    <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 10 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                        <thead>
                          <tr style={{ background: C.surfaceAlt }}>
                            {["Date", "Day", "Status", "Check-in", "Check-out", "Worked hrs", "Notes"].map((h) => (
                              <th key={h} style={{
                                textAlign: "left", padding: "8px 12px", color: C.textMuted,
                                fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4,
                                whiteSpace: "nowrap",
                              }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {m.days.map((d) => {
                            const off = !d.is_working_day;
                            const chip = statusChip(d.status);
                            const dl = dayLabel(d.date);
                            return (
                              <tr key={d.date} style={{
                                borderTop: `1px solid ${C.border}`,
                                opacity: off ? 0.5 : 1,
                                background: off ? C.surfaceAlt : "transparent",
                              }}>
                                <td style={{ padding: "7px 12px", color: C.textPrimary, whiteSpace: "nowrap" }}>{d.date}</td>
                                <td style={{ padding: "7px 12px", color: C.textSecondary }}>{dl.wd}</td>
                                <td style={{ padding: "7px 12px" }}>
                                  <span style={{
                                    fontSize: 11.5, fontWeight: 600, padding: "2px 9px",
                                    borderRadius: 20, color: chip.fg, background: chip.bg, whiteSpace: "nowrap",
                                  }}>{d.status}</span>
                                </td>
                                <td style={{ padding: "7px 12px", whiteSpace: "nowrap" }}>
                                  <span style={{ color: d.late ? C.warning : C.textPrimary, fontWeight: d.late ? 700 : 400 }}>
                                    {d.checkin || "—"}
                                  </span>
                                  {d.late && (
                                    <span style={{
                                      marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#fff",
                                      background: C.warning, borderRadius: 4, padding: "1px 5px",
                                    }}>LATE</span>
                                  )}
                                </td>
                                <td style={{ padding: "7px 12px", color: C.textPrimary }}>{d.checkout || "—"}</td>
                                <td style={{ padding: "7px 12px", color: C.textPrimary }}>{d.worked_hrs ?? "—"}</td>
                                <td style={{ padding: "7px 12px", color: C.textSecondary, fontSize: 12 }}>{d.leave_type || ""}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

// ─── Directory (default view) ──────────────────────────────────────────────

const AttendancePage = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("");
  const [selected, setSelected] = useState(null); // employee row → detail view

  const load = useCallback(() => {
    setError(null);
    fetchJson("/api/attendance/employees")
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const employees = data?.employees || [];
  const depts = useMemo(
    () => [...new Set(employees.map((e) => e.dept).filter(Boolean))].sort(),
    [employees]
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return employees.filter((e) => {
      if (dept && e.dept !== dept) return false;
      if (!needle) return true;
      return `${e.name || ""} ${e.code || ""} ${e.position || ""}`.toLowerCase().includes(needle);
    });
  }, [employees, q, dept]);

  if (selected) {
    return (
      <div style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
        <EmployeeHistory code={selected.code} listRow={selected} onBack={() => setSelected(null)} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: C.textPrimary, display: "flex", alignItems: "center", gap: 10 }}>
            <UserCheck size={22} color={C.accent} /> Attendance
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: C.textSecondary }}>
            Everyone in your scope, this month at a glance — click a person for their complete record, month by month.
          </p>
        </div>
        {data?.month_working_days != null && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600,
            color: C.textSecondary, background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 20, padding: "7px 14px",
          }}>
            <CalendarDays size={14} color={C.accent} />
            {data.month_working_days} working days so far this month
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
          <Search size={15} style={{ position: "absolute", left: 12, top: 11, color: C.textMuted }} />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, code or position…"
            style={{
              width: "100%", padding: "9px 12px 9px 36px", borderRadius: 10,
              border: `1px solid ${C.border}`, background: C.surface,
              color: C.textPrimary, fontSize: 13, outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
        {depts.length > 1 && (
          <select value={dept} onChange={(e) => setDept(e.target.value)} style={{
            padding: "9px 12px", borderRadius: 10, border: `1px solid ${C.border}`,
            background: C.surface, color: C.textPrimary, fontSize: 13,
          }}>
            <option value="">All departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>

      {error && (
        <div style={{ padding: 20, borderRadius: 12, background: "rgba(239,68,68,0.08)", color: "#B91C1C", fontSize: 13 }}>
          <AlertCircle size={15} style={{ verticalAlign: "middle", marginRight: 6 }} />{error}
          <button onClick={load} style={{ marginLeft: 12, border: "none", background: "transparent", color: "#B91C1C", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>Retry</button>
        </div>
      )}
      {!data && !error && (
        <div style={{ padding: 60, textAlign: "center", color: C.textMuted }}>
          <Loader2 size={22} className="spin" style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 13 }}>Loading attendance…</div>
        </div>
      )}

      {data && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: C.surfaceAlt }}>
                  {["Employee", "Department", "Present", "Remote", "Leave", "Absent", "Late", "Avg check-in", "Attendance", "Last seen"].map((h) => (
                    <th key={h} style={{
                      textAlign: "left", padding: "10px 14px", color: C.textMuted, fontWeight: 600,
                      fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const nm = cleanName(e.name, e.code);
                  return (
                    <tr
                      key={e.code}
                      onClick={() => setSelected(e)}
                      style={{ borderTop: `1px solid ${C.border}`, cursor: "pointer" }}
                      onMouseEnter={(ev) => (ev.currentTarget.style.background = C.surfaceAlt)}
                      onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ padding: "9px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <Avatar name={nm} size={32} />
                          <div>
                            <div style={{ fontWeight: 600, color: C.textPrimary }}>{nm}</div>
                            <div style={{ fontSize: 11.5, color: C.textMuted }}>{e.code}{e.position ? ` · ${e.position}` : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: "9px 14px", color: C.textSecondary, whiteSpace: "nowrap" }}>{e.dept}</td>
                      <td style={{ padding: "9px 14px", color: C.textPrimary }}>{e.present ?? 0}</td>
                      <td style={{ padding: "9px 14px", color: C.textPrimary }}>{e.remote ?? 0}</td>
                      <td style={{ padding: "9px 14px", color: C.textPrimary }}>{e.on_leave ?? 0}</td>
                      <td style={{ padding: "9px 14px", color: (e.absent || 0) > 0 ? C.danger : C.textPrimary }}>{e.absent ?? 0}</td>
                      <td style={{ padding: "9px 14px", color: (e.late || 0) > 0 ? C.warning : C.textPrimary }}>{e.late ?? 0}</td>
                      <td style={{ padding: "9px 14px", color: C.textPrimary, whiteSpace: "nowrap" }}>
                        <Clock size={12} style={{ verticalAlign: "-1px", marginRight: 5, color: C.textMuted }} />
                        {e.avg_checkin || "—"}
                      </td>
                      <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}>
                        <span style={{
                          fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 20,
                          color: "#fff", background: rateColor(e.attendance_rate),
                        }}>
                          {e.attendance_rate != null ? `${e.attendance_rate}%` : "—"}
                        </span>
                      </td>
                      <td style={{ padding: "9px 14px", color: C.textSecondary, whiteSpace: "nowrap" }}>{e.last_seen || "—"}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} style={{ padding: 40, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
                      No employees match your search.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ padding: "10px 14px", fontSize: 12, color: C.textMuted, borderTop: `1px solid ${C.border}` }}>
            {filtered.length} of {employees.length} employees
            {data.scoped_to?.length ? ` · scoped to ${data.scoped_to.join(", ")}` : ""}
          </div>
        </div>
      )}
    </div>
  );
};

export default AttendancePage;
