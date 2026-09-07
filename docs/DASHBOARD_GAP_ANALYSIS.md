# Attendance & Delivery — requirement gap analysis and closure

Reviewed **7 Sep 2026** against the approved baselines (Attendance FR-A1–A20,
Delivery FR-D1–D19) by reading `backend/main.py` and probing the live warehouse,
not by clicking the deployed UI. Every SQL change below was executed against
BigQuery through `/api/dashboard/run` before it was committed to the file.

---

## 1. Three findings from the earlier UI-only review were wrong

Reading the code changed the diagnosis on three points. Correcting them matters
because two of them were on the "must fix before release" list.

### 1.1 Row-level security IS implemented — FR-A18 / FR-D18 are met

`_pb_scope()` resolves the signed-in user's department scope via
`_get_user_dept_scope()` and injects a hierarchy-expanded
`EmployeeHierarchyNode IN (...)` predicate into the `emp` CTE of every panel.
Scoped users also lose the Department filter (offering it would only hand them
dropdown values that return nothing) and get per-employee charts instead of
per-department ones.

It looked absent from the UI because the reviewing account is an **admin**, and
admins are deliberately unscoped:

    if (user.get("role") or "").lower() != "admin":
        dept_scope = _get_user_dept_scope(int(user["sub"]))

**Action:** none in code. Verify by signing in as a non-admin practice head.
The earlier "no row-level security" finding should be withdrawn.

### 1.2 The punch map is ~1 km, not ~11 km

`_geo_layer()` rounds coordinates to **2 decimals** (~1 km) and the code comment
explains the earlier 1-decimal version merged every site in a city into one dot.
Only the panel *subtitle* still said "~11 km" — stale text from before that fix.

**Action:** subtitle corrected. No behaviour change.

### 1.3 Utilisation above 1.0 is by design, and the measure is sound

`allocation_percent` is 0–100 **per project row**, so someone booked on three
projects at 100% legitimately scores 3.0 — Qlik carried an "Over Allocation" tab
for exactly this. More importantly, the arithmetic checks out at population
level:

| Measure | Value |
|---|---|
| Median person-month (2026) | **20 man-days** against a ~21-working-day month |
| Person-months above 22 man-days | 1,813 of 6,059 (30% — overtime) |
| Person-months above 44 man-days (2× capacity) | **60 (1.0%)** |
| Person-months above 100 man-days | **4** |
| Worst case | 294 man-days |

So this is a long-tail data-quality problem in ~1% of rows, not a broken
denominator. The root cause is upstream: E-599 carries 2,273 hours across **909
distinct** `TICKET_ID`s in April 2026 — not duplicated rows, so
`Timesheet_Data.EMPLOYEE_CODE` is probably the ticket owner rather than the
person who did the work, and a lead accumulates their whole team's tickets.

**Action:** the denominator was left alone. Instead the new reconciliation panel
exposes hours against capacity per person and flags rows above 2× capacity as a
**data check**, and a KPI counts them (currently **3**). Fixing the attribution
is a pipeline change, tracked separately.

### 1.4 Also corrected: Holiday and Weekend statuses do exist

`attendance_status_text` carries 10 values including `Holiday` and `Weekend`.
They are excluded from the panels by the company working-day calendar
(`cal` CTE, majority vote per date) — deliberately, and documented in the code.
The earlier "statuses were dropped" finding was wrong.

---

## 2. What was built this pass

All of it in `_pb_dashboard_defs()` in `backend/main.py`.

### Attendance

| Req | Change | Verified |
|---|---|---|
| **FR-A16** | **Department Report** — new table. People, days, attendance %, avg check-in/out, avg duration, late days, absences, leave days per department. Row click drills to the people behind it. | 66 departments returned |
| **FR-A17** | **Leave & Requests Report** — new table. One row per person per leave day with leave category, covering both approved leave and pending requests, with a pinned totals row. | 175 leave days, 8 leave types |
| **FR-A1** | Added **Date** (day-level, Qlik's "Dated") and **Leave Type** filters. | registry + panel |
| **FR-A13** | Daily Report extended from 7 to **11 columns** — added Department, Duration, Leave Type and Punch-Out Location; row cap 200 → 400. | 400 rows, 11 cols |
| SAT-10 | The period label now says **"· month still in progress"** when the window runs to today, so a part-month register stops reading as a company-wide attendance failure. | — |
| 1.2 | Map subtitle corrected to ~1 km. | — |

New helper `_pb_duration_row_sql()` gives a row-level worked span (the
non-aggregate twin of the existing average), blanking spans outside 0–24h so
punch errors don't render as 30-hour days.

### Delivery

| Req | Change | Verified |
|---|---|---|
| **FR-D6** | **Capacity & Hours Reconciliation** — new table, the highest-value gap. Working days, leave days, net available days, capacity hours, hours logged, bench days, utilisation % per person, plus a totals row and a data-check column. Leave comes from the attendance feed because the allocation book has no concept of it (a week off still reads as 100% allocated). | 1,000 rows; company total 184 working days, 1,614,440 capacity hours, 859,156 logged → **53%**, 4,459 leave days |
| **FR-D1 / D10** | **Project Delivery — Planned vs Logged Hours** — new table. Project, client, type, status, people, tickets, planned, logged, variance, variance %. Joined `Timesheet_Data.TICKET_PROJECT_CODE` → `Project_Master.Project_Code`. | 258 projects, 20 codes unresolved (shown as `Project <code>`, not dropped) |
| **FR-D8** | **Avg Utilisation by Growth Level** — new chart, GL 01–13 ordered by seniority. | 14 bands; overall 61.5% ties to the existing KPI |
| **FR-D5** | Period label now names how far actuals reach: *"2026 · logged hours to 31 Aug"*, so a failed timesheet load reads as stale data rather than a quiet month. | — |
| **FR-D12/D13** | Added **Growth Level** and **Employee Status** filters. | registry + panel |
| 1.3 | **Rows Failing the Hours Check** KPI. | value 3 |

Two correctness decisions worth knowing about:

- **Variance is NULL when there is no estimate.** 20 of ~260 projects carry
  hours with no `TICKET_PLANNED_HOURS`. Subtracting zero would report the whole
  logged total as an overrun — a runaway project that isn't one.
- **"Planned", not "budget".** `TICKET_PLANNED_HOURS` is a per-ticket estimate
  (1.71M planned vs 1.57M logged company-wide), not a sold budget. There is no
  budget-hours feed in this warehouse, so the column is labelled for what it
  actually is.

---

## 3. Still open, and why

### Blocked on the warehouse, not the dashboard

`Attendance_Data` has 30 columns; these are not among them, so no dashboard
change can produce them:

| Req | Missing | Needs |
|---|---|---|
| FR-A1 | Device Login Type | a device/login column in the attendance feed |
| FR-A13 | Geofence site name, geofence distance | the Odoo geofence master + the 1,500 m attribution rule (BR-05) in the pipeline |
| FR-A13 | Device brand, IP address (check-in and check-out) | the same feed — and an HR/Legal decision first |
| FR-D2 / FR-D9 | Skill placeholders (unfilled demand) | a skill master; this warehouse has no equivalent |
| FR-D1 / FR-D10 | True budget hours | a budget feed; `TICKET_PLANNED_HOURS` is the current stand-in |

### Frontend or architecture, not a panel

| Req | Gap |
|---|---|
| FR-A2 | Selecting inside a chart drills rather than cross-filtering the screen. A product decision (see decision D-1 in the conformance review), not a bug. |
| FR-A3 / FR-A4 | No clear-all, no selection history, no bookmarks. Each filter has its own "Clear filter". |
| FR-D14 | Tables are flat with a row drill, not an 8-level pivot. |
| SAT-04 | Chart drill-down fails on some panels (`Attendance % by Department`). Untouched this pass. |
| SAT-05 | AI Insights panel errors on every dashboard. Untouched this pass. |
| SAT-07 | Delivery took 25–35 s to render against a 3 s target. The two new full-width tables add query load — worth measuring before release. |

---

## 4. Verification

Every new statement was run against BigQuery before being written into
`main.py`. To re-check after any edit:

    cd backend && python validate_prebuilts.py attendance delivery

That exercises the real production path (`_substitute_params` →
`_substitute_where` → `normalize_bq_project` → `_autofix_dashboard_sql` →
`bq_run_query`) twice per panel — bare, and with a representative selection —
so a pass means the panel works when a user opens it.

Both passes were run by hand against BigQuery for every new panel before this
was written — bare, and with an injected predicate in the position `{where}`
occupies:

| Panel | Bare | Filtered |
|---|---|---|
| Department Report | 66 departments | date / status / leave_type all resolve (66 / 56 / 13 departments) |
| Leave & Requests Report | 175 days, totals row 175 | leave_type → 56 days, totals row recomputes to 56 |
| Daily Report (extended) | 400 rows, 11 columns | — |
| Capacity Reconciliation | 1,000 rows | employee_status + Employee_GL → 242 people, 192,610 hrs |
| Project Delivery | 258 projects | — |
| Avg Utilisation by Growth Level | 14 bands, 61.5% overall | Employee_GL → 63.7%, matching the unfiltered band |
| Hours Check KPI | 3 | — |

The filtered pass matters more than it looks: an injected predicate is written
**unaliased**, so every column a filter targets has to be re-exposed by the
`emp` CTE, or the panel only dies once somebody touches a dropdown. That is why
`growth_level` and `position` were added to the delivery `emp` CTE rather than
read off `Employee_Data` at the point of use.

---

## 5. Verified end-to-end (7 Sep 2026)

Run against a local backend on real BigQuery through `/api/dashboards/prebuilt/<key>`
then `/api/dashboard/run` — the same path a user's browser takes.

**Attendance Pulse — 6 KPIs, 8 charts, all returning:**

| Panel | Result |
|---|---|
| Attendance Rate / Avg In / Avg Out / Avg Duration | 84.5% · 09:58 AM · 06:53 PM · 8:58 |
| Late Arrivals / Absences | 2,867 · 553 |
| Punch map | 896 geo cells |
| Status mix / by department / daily trend | 9 · 50 · 5 rows |
| Average Time Report / Daily Report | 200 · 400 rows (11 columns) |
| **Department Report** (FR-A16) | **66 rows**; drill on "SAP Finance" returns 117 people |
| **Leave & Requests Report** (FR-A17) | **182 rows** incl. totals |

**Delivery Dashboard — 7 KPIs, 7 charts, all returning:**

| Panel | Result |
|---|---|
| Avg Utilisation (Elapsed) | 61.6% |
| Man-Months elapsed / planned | 6,216 · 3,185 |
| Hours Logged YTD | 860,259 |
| Under 70% / Over-allocated | 68 · 19 |
| **Hours Check** (data quality) | **3** |
| Trend / monthly pivot / competency / bands | 12 · 1,000 · 25 · 4 rows |
| **Avg Utilisation by Growth Level** (FR-D8) | **14 bands** |
| **Capacity Reconciliation** (FR-D6) | **1,000 rows** |
| **Project Delivery** (FR-D1/D10) | **258 projects** |

All 7 delivery filters resolve, including the new `growth_level` and
`employee_status`.

### Config bugs found and fixed during that run

1. **`VERTEX_PROJECT` selected the BigQuery project.** Vertex is no longer the
   AI backend (AI Studio via `GEMINI_API_KEY` is), but that variable still
   picked the warehouse. A stale `VERTEX_PROJECT=ai-vertex-mahad` in one shell
   sent every query to a retired project and surfaced only as a 403 on
   `bigquery.jobs.create`. Project resolution now lives in one place
   (`bigquery_client.resolve_project`), prefers the clearly-named `BQ_PROJECT`
   / `GCP_PROJECT`, keeps `VERTEX_PROJECT` for back-compat, and **ignores**
   `ai-vertex-mahad` — `normalize_bq_project()` already treats that name as
   dead and rewrites SQL away from it, so accepting it as a setting was
   self-contradictory.
2. **`load_dotenv()` ran ~30 lines AFTER the project was read**, so a `.env`
   file could never influence the warehouse target. Anyone fixing a wrong
   project by writing a `.env` would have seen no effect and no error. It now
   runs first.
3. **`pb_att_daily` was capped at 200 rows.** The runner caps a panel unless it
   declares `maxRows`, so the SQL `LIMIT 400` was being truncated. Declared.

### A note on `py_compile` not being enough

A patch briefly left `))@app.post("/api/dashboard/run")` on one line. `@` is
Python's matrix-multiply operator, so that is a *valid expression* —
`py_compile` passed, the module imported, uvicorn started clean, and the route
simply never registered. Every call returned 404. Syntax checks cannot catch a
detached decorator; only calling the endpoint can.

---

## 6. Load time — 60s to 7s

### What was wrong

`dashboard_run` executed everything **serially**: 8 KPIs, then 8 charts, then
up to 8 filter-dropdown probes, then the period query — each its own BigQuery
round trip. The delivery prebuilt issues ~23 jobs; at 2-4s apiece that is a
minute of wall clock, none of it CPU.

### What changed

- All panels, filter probes and the period query are submitted together to a
  `ThreadPoolExecutor` (capped at 10 workers — a dashboard can ask for 25
  queries and the per-project concurrent-query limit is real). Threads, not
  asyncio: `bq_run_query` and the self-heal path are synchronous, and the
  BigQuery client caches one thread-safe HTTP session.
- `get_bq_client()` now double-checked-locks its lazy init. Concurrent first
  use could otherwise build two clients and discard one — the same
  discarded-client pattern that breaks the genai transport elsewhere here.
- `json.dumps(config)` was being rebuilt inside the filter loop, once per
  dropdown, over a config holding a dozen multi-kilobyte SQL strings. Hoisted.

### Measured, same machine, same data

| Dashboard | Before | After |
|---|---|---|
| Attendance Pulse | 35.5 s | **6.9 s** |
| Delivery Dashboard | 57.1 s | **7.6 s** |

Both now return every panel with zero errors.

### Two bugs this surfaced

1. **KPIs were hard-capped at 6** (`[:6]`) while charts allowed 8. Delivery
   defines 7 KPIs, so the new data-quality tile was silently dropped by the
   runner and never rendered — the config was correct all along. Cap raised to
   8 to match charts.
2. **The period query skipped half the substitution pipeline.** It ran only
   `_substitute_params`, never `_substitute_where` or `_autofix_dashboard_sql`.
   Delivery's `periodSql` is built on the `dw` CTE chain, which carries
   `{where}` — so a literal `"{where}"` reached BigQuery, and a broad `except`
   swallowed the syntax error, leaving the header with no period at all.
   Attendance was unaffected only because its period query has no `{where}`.
   It now runs the same pipeline as every panel.

### Progressive loading — done

7 s used to be one blocking request: a bare spinner, then everything at once.
It is now streamed.

**Backend.** `dashboard_run` is a thin wrapper around
`_dashboard_run_impl(body, user, emit=None)`, so the work has exactly one
implementation and the two routes differ only in how they deliver it. The new
`POST /api/dashboard/run/stream` returns a `StreamingResponse` of Server-Sent
Events fed by a bounded `queue.Queue(maxsize=64)` and a daemon worker thread.
`X-Accel-Buffering: no` is set because nginx buffers proxied responses by
default, which would hold the whole stream to the end and defeat the point.

Event contract:

| event | payload | purpose |
|---|---|---|
| `meta` | `total`, `title`, `panels[{id,title,kind}]` | lets the client name panels before any land |
| `tick` | `ready`, `total` | completion order — drives the percentage |
| `panel` | `kind`, `index`, `card`, `done`, `total`, `label` | definition order — drives the caption |
| `filters` | `filterOptions` | the post-panel tail |
| `period` | `period` | the post-panel tail |
| `result` | the whole payload | one authoritative object for the store |
| `error` / `done` | — | terminal |

**Why two counters.** The assembly loops walk panels in *definition* order, so
a slow first KPI pins the count at zero even after six others have returned —
right for a caption ("Fetching Daily Report…"), useless as a percentage.
`tick` is emitted from each future's own `add_done_callback`, so it moves in
*completion* order. The client takes the number from `tick` and the caption
from `panel`. Measured on Attendance: first movement at **1.65 s** instead of
**4.5 s**, then a steady climb to 5.2 s.

`tick` is the one event `emit` publishes with `put_nowait` and drops on a full
queue. It fires on a pool worker thread, so blocking there would stall the very
queries the client is waiting for; a dropped tick costs a little animation
smoothness and nothing else, because the authoritative counts ride on `panel`
and `result`.

**Two bugs found while building it.**

1. `with ThreadPoolExecutor(...)` calls `shutdown(wait=True)` on exit, so the
   card-building loops could not start until every future had finished — the
   stream emitted all 20-odd events in the same millisecond at 6810 ms. The
   pool is now closed with `shutdown(wait=False)` in a `finally`, which stops
   new submissions but lets the queued work run, so each `fut.result()` returns
   the moment that panel is ready. **A `with` block on an executor is a barrier,
   not just cleanup.**
2. `_say`, `_total_panels` and the `meta` emit sat *below* the pool block, so
   nothing could be emitted from a submit-time callback. They moved above it.

**Frontend** (`frontend/src/Growgnition.jsx`). `DashboardRenderer.fetchData`
consumes the SSE stream by hand (`res.body.getReader()` — `EventSource` cannot
POST), buffering partial frames because a frame can straddle two chunks. It
falls back to `/api/dashboard/run` only on 404/405/501 or a body it cannot
read; a real query failure arrives as an `error` event and must *not* trigger a
fallback, since re-running the dashboard would only fail again, slowly. The
fallback path was verified by simulating a 404 on the stream route.

`DashboardLoader` replaces the blind spinner: the TMC monogram inside an SVG
progress ring, a percentage, a caption naming the panel in flight, a
determinate bar and "n of m panels ready". The number eases upward continuously
but is capped by the share of the panel actually in flight, so it always moves
and never claims progress that hasn't happened. Panels are scaled into 0–88%
because filter options and the period label land after them — a bar that hit
100% and then sat there would be its own kind of lie.
