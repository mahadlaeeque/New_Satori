# Governance (Work Packages) dashboard

Satori prebuilt `governance` — a port of the Qlik **Governance Dashboard - PF**
(app `cae76136-881d-42be-a2d1-eee0318dbc8f`, stream Governance), built on
4 Nov 2026 from the app's own object model (Engine API: sheets, master items,
measure expressions), not from screenshots.

## What was ported

Qlik's app has 15 sheets. The dashboard covers the governance ones — **WP
Analysis**, **Task Analysis**, **WP KPI Breakdown**, **Exception Report** and
the **WP Detail / Task-Subtask** tables. Not ported: *Risk Register* / *Risk
Detail* (no risk table reaches BigQuery), *Employee Analysis* / *Allocation*
(already covered by Workforce & Bench and Delivery), and the NPrinting /
backup / migration-count sheets (internal).

| Qlik object | Qlik expression (Level-C = WP) | Satori panel |
|---|---|---|
| KPI Total WP | `Count({<FLAG={'Level-C'}>} distinct WP_ID)` | Total Work Packages = `COUNT(DISTINCT WP_CODE)` |
| KPI Assigned / Not Assigned | `IS_USER_ASSIGNED={'Assigned'}` | WP has ≥1 resource row ≠ `'NA'` |
| KPIs Backlog, Initiation Pending, Upcoming, Future Task | `PG_STATUS={…}` | folded into **Not Started** |
| KPIs In-Progress On-Track / Behind, Completed On-Time / Delayed | `PG_STATUS` × `PF_STATUS` | same, on `Progress_Status` × `Performance_Status` |
| KPI Total Task / Sub Task | Level-D / Level-E `distinct TASK_ID` | `COUNT(DISTINCT TASK_SUBTASK_ID)` by `T_ST_FLAG`, under the selected WPs |
| Pie Progress Status | by `Progress_Status` | donut |
| Bar Performance Analysis | `Performance_Status -= {'NA'}` | bar, NA excluded |
| Pie Task Progress Analysis | `WP_PORTAL_STATUS` / task `Progress_Status` | Portal Status donut + Task Progress donut |
| Combo by MonthYear (Backlog…Completed) | calendar on `wp_baseline_start_date` | Baseline Timeline, stacked by month of `WP_BASELINE_START_DATE` |
| Bar Project Analysis / By Resource / By Owner | `distinct WP_ID` by dimension | same; click → the WPs behind the bar |
| Table WP Detail / Exception Report | per-WP columns, `PLAN%`, `ACTUAL%` | WP Detail Report / Exception Report; `ACTUAL` omitted (it is `'?'` on every row of the feed) |
| Drill wp_task_drill | Project → Phase → Deliverable → WP → Task → Sub-task | row click → tasks and sub-tasks of that WP |
| Filter pane: Status, Project, Line of Business, System Label, Build, Phase, Deliverable | | Project, Build, Deliverable Type, Assignment, Resource, WP Owner, Progress, Performance, Portal Status, Source System, Baseline Year, Baseline Month. *Line of Business* and *Phase* have no column in `WP_Report` (Phase exists only on the task report). |

## Grain and rules

- `WP_Report` is ~490k rows for ~10.2k work packages: one row per (WP,
  resource) **plus outright duplicates** — one WP arrives 49,000 times. The
  `src` CTE is `SELECT DISTINCT`, every count is per distinct `WP_CODE`, the
  register is one row per WP with resources rolled up. Status, dates and PLAN
  are constant within a WP (0 WPs carry two values), so `ANY_VALUE` is exact.
- Resource labels are normalised to `E-293 - Rai Sohaib Amjad` (the feed
  writes both `E-293 Rai …` and `E-1187 - Hashim …`); `'NA'` → Not Assigned.
  The registry probe and the CTE share `_PB_WP_RESOURCE` so a dropdown value
  always matches a row.
- Filters apply at row grain (`wrows`), so *Resource* narrows a WP's rows and
  the WP roll-up inherits every selection. `{where}` uses contract B
  (`WHERE TRUE {where}`).
- Practice-head scope: a scoped user sees WPs with at least one of their own
  people assigned (inner join on the resource's employee code), as the
  Timesheet dashboard does for hours.
- `Tasks_Subtasks_Report` (~10M exploded rows) is read only through the
  selected WPs (two KPIs, one donut, the row drill) — never scanned alone.
  Its dates are `%d-%b-%Y` strings and are shown as-is.

## Reconciliation with Qlik — the feed is stale and narrow

Checked 4 Nov 2026 with `EvaluateEx` against the live Qlik app:

| | Qlik | BigQuery `WP_Report` |
|---|---|---|
| Work packages | 12,454 (`WP_ID`) / 14,422 (`WP_CODE`) | 10,172 |
| Projects | 116 | 75 |
| Completed / In-Progress | 7,442 / 2,428 | 5,843 / 2,256 |
| Tasks / Sub-tasks | 63,086 / 9,396 | 45,568 / 6,315 |
| Newest `WP_LAST_STATUS_DATE` | reloaded 4 Nov 2026 06:03 | **11 Jun 2026** |

41 projects (3,321 WPs) present in Qlik are absent from BigQuery — all the
newer codes (1263, 1276, 1300, 1323, 1333, 1359, 1382, 1389 …) — and the
Drive CSV `pfwpreport` has not changed since June (`Tasks_Subtasks_Report`
md5 unchanged since 3 Sep). The sync job reloads it every 30 minutes; it is
the Qlik→Drive export that stopped. Until that export is refreshed the
dashboard is correct for what it holds and five months behind Qlik. The
period pill says so on every open: *feed last updated 11 Jun 2026*.

## Runner change that came out of this

`_dashboard_run_impl` no longer runs the zero-rows self-heal on prebuilt
dashboards (`dashboard_id` starting `pb-`, or `config.prebuilt`). Testing a
"Not Assigned" selection, the heal asked Gemini to "fix" the legitimately
empty By Resource chart and returned the **unfiltered** chart flagged
`recovered`. For hand-written SQL, empty is the answer. Error repair still
runs.

## Files

`backend/main.py`: `_PB_WP_RESOURCE`, twelve `wp_*` registry entries,
`dash_governance` (key `governance`), the `deterministic` guard, the
`prebuilt` flag on `/api/dashboards/prebuilt/{key}`.
