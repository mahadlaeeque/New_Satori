/**
 * One place that turns a warehouse column name into something a person reads.
 *
 * Raw identifiers were reaching users in chart legends, axis labels, tooltips,
 * table headers and CSV exports: "avg_utilisation_pct", "resource_months",
 * "hours_logged". Title-casing alone is not enough — it only gets you
 * "Avg Utilisation Pct", which is still the database talking.
 *
 * Order matters: the dictionary is applied token by token, so "avg" and "pct"
 * expand wherever they appear rather than only in names we happened to list.
 * Anything not in the dictionary falls through to Title Case, so a new column
 * is readable by default instead of leaking.
 *
 * Spelling is British ("Utilisation") to match the labels already on the
 * dashboards and in the Qlik apps these replaced.
 */

// Single tokens, expanded wherever they appear in a name.
const WORDS = {
  avg: "Average", mean: "Average", med: "Median",
  min: "Minimum", max: "Maximum", tot: "Total", cnt: "Count", num: "Number",
  pct: "Percentage", perc: "Percentage", pc: "Percentage", ratio: "Ratio",
  util: "Utilisation", utilisation: "Utilisation", utilization: "Utilisation",
  hrs: "Hours", hr: "Hour", qty: "Quantity", amt: "Amount", val: "Value",
  emp: "Employee", dept: "Department", res: "Resource", mgr: "Manager",
  proj: "Project", alloc: "Allocation", cap: "Capacity", comp: "Competency",
  gl: "Growth Level", ts: "Timesheet", wp: "Work Package", dq: "Data Quality",
  ytd: "Year to Date", mtd: "Month to Date", qtd: "Quarter to Date",
  wk: "Week", mo: "Month", yr: "Year", dt: "Date", ts_date: "Date",
  no: "Number", nbr: "Number", id: "ID", ip: "IP", kpi: "KPI", pmo: "PMO",
  sla: "SLA", eta: "ETA", wfh: "Remote",
};

// Whole names that deserve a hand-written label rather than a token expansion.
const EXACT = {
  avg_utilisation_pct: "Average Utilisation Percentage",
  resource_months: "Resource-Months",
  hours_logged: "Hours Logged",
  logged_hrs: "Hours Logged",
  total_hours: "Total Hours",
  attendance_pct: "Attendance Percentage",
  late_days: "Late Arrivals",
  logged: "Logged",
  planned: "Planned",
  assigned: "Assigned",
  unassigned: "Un-Assigned",
  attended: "Attended",
  absent: "Absent",
  punches: "Punches",
  days: "Days",
  hours: "Hours",
  total: "Total",
  allocated: "Allocated",
  actual_util: "Actual Utilisation",
  alloc_frac: "Allocation",
  variance: "Variance",
  employee_code: "Employee Code",
  resource_name: "Resource Name",
  growth_level: "Growth Level",
  emp_competency: "Competency",
  nid: "Employee Code",
};

export function humanLabel(key) {
  if (key === null || key === undefined) return "";
  const raw = String(key).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (EXACT[lower]) return EXACT[lower];
  // Already human (has a space or a capital mid-word) — leave it alone.
  if (/\s/.test(raw) || /[a-z][A-Z]/.test(raw)) return raw;
  return lower
    .split(/[_\-.]+/)
    .filter(Boolean)
    .map((t) => WORDS[t] || t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

export default humanLabel;
