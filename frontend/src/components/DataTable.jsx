// ─── DataTable ───
// The register panel behind the Attendance Pulse dashboard's Daily Report and
// Average Time Report — and the body of every drill-down modal.
//
// Qlik's attendance sheet leaned on colour-coded tables (a red check-in cell =
// late, green = on time) as much as on its charts, so the dashboard engine
// needs a real table panel, not a chart fallback. Exported as its own module
// so the same component serves the dashboard surface and the drill modal, and
// so the rules below can be exercised in isolation.

import { useState, useMemo, useCallback } from "react";
import { Search, Download } from "lucide-react";

const COLORS = {
  accent:        "#8AC441",
  surface:       "var(--c-surface)",
  surfaceAlt:    "var(--c-surface-alt)",
  border:        "var(--c-border)",
  textPrimary:   "var(--c-text-primary)",
  textSecondary: "var(--c-text-secondary)",
  textMuted:     "var(--c-text-muted)",
};

// "09:43 AM" / "18:05" / "9:5" → minutes since midnight. Returns null for
// anything that isn't a clock, so a rule silently no-ops on unexpected data.
const parseClockMinutes = (v) => {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  let h = Number(m[1]);
  const mins = Number(m[2]);
  const mer = (m[3] || "").toUpperCase();
  if (mer === "PM" && h < 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  if (h > 23 || mins > 59) return null;
  return h * 60 + mins;
};

const CELL_TONES = {
  good:  { bg: "var(--sem-ok-bg)",     fg: "var(--sem-ok-fg)" },
  warn:  { bg: "var(--sem-warn-bg)",   fg: "var(--sem-warn-fg)" },
  bad:   { bg: "var(--sem-danger-bg)", fg: "var(--sem-danger-fg)" },
  info:  { bg: "var(--sem-info-bg)",   fg: "var(--sem-info-fg)" },
  muted: { bg: "var(--c-surface-alt)", fg: "var(--c-text-muted)" },
  // Over-allocation is not "good, but more" — a resource booked past capacity
  // is a delivery risk, so it gets its own tone rather than a deeper green.
  over:  { bg: "var(--sem-rose-bg)",   fg: "var(--sem-rose-fg)" },
};

// Attendance statuses come straight from the warehouse text column, so match
// loosely rather than against a fixed enum — new statuses just render plain.
const STATUS_TONES = [
  [/^present/i, "good"], [/remote/i, "info"], [/^absent/i, "bad"],
  [/missing\s*punch/i, "warn"], [/leave/i, "warn"],
  [/holiday|weekend/i, "muted"], [/^submitted/i, "info"],
];

/** Which tone (if any) a cell should carry, given its panel's rule. */
const cellTone = (value, rule) => {
  if (!rule || value == null || value === "") return null;
  const kind = rule.kind;
  if (kind === "status") {
    const hit = STATUS_TONES.find(([re]) => re.test(String(value)));
    return hit ? hit[1] : null;
  }
  if (kind === "permitted") return /^permitted$/i.test(String(value).trim()) ? "good" : "bad";
  if (kind === "countBad") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n >= (rule.bad ?? Infinity)) return "bad";
    if (n >= (rule.warn ?? Infinity)) return "warn";
    return n === 0 ? "good" : null;
  }
  // Utilisation / allocation expressed as a fraction of capacity, where
  // 1.0 = 100% of an 8-hour day. Both ends are bad: idle capacity below the
  // floor, and a resource booked past `over` who cannot actually deliver it.
  if (kind === "ratio") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n > (rule.over ?? 1.5)) return "over";
    if (n >= (rule.good ?? 0.95)) return "good";
    if (n >= (rule.warn ?? 0.7)) return "warn";
    return "bad";
  }
  if (kind === "clockEarly" || kind === "clockLate") {
    const t = parseClockMinutes(value);
    if (t == null) return null;
    const good = parseClockMinutes(rule.good);
    const warn = parseClockMinutes(rule.warn);
    if (good == null || warn == null) return null;
    // clockEarly: earlier is better (arrivals). clockLate: later is better (departures).
    if (kind === "clockEarly") return t <= good ? "good" : (t <= warn ? "warn" : "bad");
    return t >= good ? "good" : (t >= warn ? "warn" : "bad");
  }
  return null;
};

/** snake_case column → "Snake Case", unless the panel supplied a nicer label. */
const prettyHeader = (col, labels) =>
  (labels && labels[col]) ||
  String(col || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const csvEscape = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const downloadCsv = (filename, columns, rows, labels) => {
  const head = columns.map((c) => csvEscape(prettyHeader(c, labels))).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(r?.[c])).join(",")).join("\n");
  const blob = new Blob([`${head}\n${body}`], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/**
 * A sortable, searchable, colour-coded register. Rows are clickable when the
 * panel supplies a drill query.
 */
export const DataTablePanel = ({
  columns = [], rows = [], columnLabels, columnRules, onRowClick,
  maxHeight = 440, exportName = "table",
  // The backend caps every panel query at 200 rows. A register that silently
  // stops at the cap reads as "that's all of it" — say so instead.
  rowCap = 200,
  // First-column prefix marking a grand-total row. Such a row is pinned above
  // the sort, styled apart, and — importantly — exempt from conditional
  // colouring: a company-wide sum of 1,182 man-months is not a resource booked
  // at 118,200% of capacity, and painting it red says exactly that.
  summaryRowPrefix,
}) => {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(null); // { col, dir: 1 | -1 }

  const cols = useMemo(
    () => (columns?.length ? columns : Object.keys(rows?.[0] || {})),
    [columns, rows],
  );

  const isSummary = useCallback(
    (r) => !!summaryRowPrefix && String(r?.[cols[0]] ?? "").startsWith(summaryRowPrefix),
    [summaryRowPrefix, cols],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A grand total that ignores the search would describe a set the user
    // isn't looking at, so it drops out as soon as they narrow the table.
    if (!q) return rows || [];
    return (rows || []).filter(
      (r) => !isSummary(r) && cols.some((c) => String(r?.[c] ?? "").toLowerCase().includes(q)),
    );
  }, [rows, cols, query, isSummary]);

  const sorted = useMemo(() => {
    const body = filtered.filter((r) => !isSummary(r));
    const head = filtered.filter(isSummary);   // pinned above any sort
    if (!sort) return [...head, ...body];
    const { col, dir } = sort;
    const s = [...body].sort((a, b) => {
      const av = a?.[col], bv = b?.[col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls always sink, whichever way we're sorting
      if (bv == null) return -1;
      // Clock strings must compare as times, not as text — "09:00 PM" < "10:00 AM"
      // lexically but not chronologically.
      const at = parseClockMinutes(av), bt = parseClockMinutes(bv);
      if (at != null && bt != null) return (at - bt) * dir;
      const an = Number(av), bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return [...head, ...s];
  }, [filtered, sort, isSummary]);

  const toggleSort = (col) =>
    setSort((prev) => (prev?.col === col ? (prev.dir === 1 ? { col, dir: -1 } : null) : { col, dir: 1 }));

  const th = {
    position: "sticky", top: 0, zIndex: 1, background: COLORS.surfaceAlt,
    padding: "9px 12px", textAlign: "left", fontSize: 11.5, fontWeight: 700,
    color: COLORS.textSecondary, borderBottom: `1px solid ${COLORS.border}`,
    whiteSpace: "nowrap", cursor: "pointer", userSelect: "none",
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ position: "relative", flex: "0 1 260px" }}>
          <Search size={13} style={{ position: "absolute", left: 9, top: 8, color: COLORS.textMuted }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this table…"
            style={{
              width: "100%", padding: "6px 10px 6px 27px", fontSize: 12.5,
              border: `1px solid ${COLORS.border}`, borderRadius: 8,
              background: COLORS.surface, color: COLORS.textPrimary, outline: "none",
            }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginLeft: "auto" }}>
          {sorted.length === (rows || []).length
            ? `${sorted.length} row${sorted.length === 1 ? "" : "s"}`
            : `${sorted.length} of ${(rows || []).length} rows`}
        </div>
        <button
          data-html2canvas-ignore="true"
          onClick={() => downloadCsv(`${exportName.replace(/[^\w-]+/g, "_").slice(0, 60) || "table"}.csv`, cols, sorted, columnLabels)}
          title="Download as CSV"
          style={{
            background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 8,
            padding: "5px 9px", cursor: "pointer", color: COLORS.textMuted,
            display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600,
          }}
        >
          <Download size={13} /> CSV
        </button>
      </div>

      <div style={{ overflow: "auto", maxHeight, border: `1px solid ${COLORS.border}`, borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} style={th} onClick={() => toggleSort(c)} title="Click to sort">
                  {prettyHeader(c, columnLabels)}
                  {sort?.col === c && (
                    <span style={{ marginLeft: 4, color: COLORS.accent }}>{sort.dir === 1 ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, ri) => {
              const summary = isSummary(r);
              const base = summary ? COLORS.surfaceAlt : (ri % 2 ? COLORS.surfaceAlt : "transparent");
              return (
                <tr
                  key={ri}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  style={{ cursor: onRowClick ? "pointer" : "default", background: base }}
                  onMouseEnter={(e) => { if (onRowClick) e.currentTarget.style.background = `${COLORS.accent}14`; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = base; }}
                >
                  {cols.map((c) => {
                    const val = r?.[c];
                    const tone = summary ? null : cellTone(val, columnRules?.[c]);
                    const t = tone ? CELL_TONES[tone] : null;
                    return (
                      <td key={c} style={{
                        padding: "7px 12px", whiteSpace: "nowrap",
                        borderBottom: summary ? `2px solid ${COLORS.border}` : `1px solid ${COLORS.border}`,
                        color: t ? t.fg : COLORS.textPrimary,
                        background: t ? t.bg : undefined,
                        fontWeight: summary ? 700 : (t ? 600 : 400),
                      }}>
                        {val == null || val === "" ? "—" : String(val)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={cols.length} style={{ padding: 20, textAlign: "center", color: COLORS.textMuted, fontSize: 12.5 }}>
                  Nothing matches “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(rows || []).length >= rowCap && (
        <div style={{ fontSize: 11, color: COLORS.textMuted, textAlign: "center", marginTop: 6 }}>
          Showing the first {rowCap} rows — narrow the period or add a filter to see the rest.
        </div>
      )}
      {onRowClick && (
        <div style={{ fontSize: 11, color: COLORS.textMuted, textAlign: "center", marginTop: 6 }}>
          Click any row to see the detail behind it
        </div>
      )}
    </div>
  );
};

export default DataTablePanel;
