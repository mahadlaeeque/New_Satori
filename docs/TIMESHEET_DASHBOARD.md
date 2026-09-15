# Project Flow Timesheet — Qlik replication notes

Source: Qlik Sense app `47d13770-301d-49fa-9ec8-0b1cddbb0fcb`, sheet
"Project Flow Dashboard". Extracted via the Engine JSON-RPC API
(`GetFullPropertyTree` / `GetProperties` / `GetScript`), not from screenshots,
so the measures below are the app's actual expressions.

## What the Qlik app is

Its fact table is two loads stacked:

| Qlik source | FLAG | meaning |
|---|---|---|
| `TMC_TIMESHEET_V2.qvd` | `Assigned` | hours against a requested timesheet ticket |
| `TMC_TIMESHEET_ADHOC_TICKET.qvd` | `Un-Assigned` | adhoc hours |

`Satori_Project.Timesheet_Data` in BigQuery is that same stacked fact, `FLAG`
included, so every measure on the sheet is a `SUM(TICKET_HOURS)` sliced by
`FLAG`.

## Object-by-object mapping

| Qlik object | Measure in Qlik | Satori panel | Status |
|---|---|---|---|
| KPI `FzSFJj` | `Count(distinct TICKET_PROJECT_CODE)` | `pb_ts_projects` | built |
| KPI `gRwJT` | `Count(distinct USER_EMPLOYEE_ID)` | `pb_ts_people` | built |
| KPI `PnyKmbn` | `Sum(TICKET_HOURS)` | `pb_ts_hours` | built |
| KPI `vSEpBN` | `Count({<FLAG={'Assigned','Un-Assigned'}>} distinct USER_EMPLOYEE_ID)` | `pb_ts_submitted` | built |
| KPI `mBUp` | `count(distinct if(isnull(...), USER_EMPLOYEE_ID))` | `pb_ts_zero` | built, redefined — see below |
| combo `dJzhmB` "Monthly Trend" | Assigned / Un-Assigned hours by Month | `pb_ts_trend` | built |
| combo `HFgj` "Planned vs. Actual Hours by Project" | Assigned / Un-Assigned hours by project | `pb_ts_project` | built, **retitled** |
| pie `hrVER` "Timesheet Status" | `Sum(TICKET_HOURS)` by `TICKET_STATUS` | `pb_ts_status` | built |
| combo `PvbfS` "…by Approver" | Assigned / Un-Assigned hours by `Approver_Name` | — | **blocked, no data** |
| table `FBcrbsB` "Detail Report" | employee × department × project | `pb_ts_detail` | built |
| pivot `VpqWS` "Daily Report" | 7 dimensions × total hours | `pb_ts_daily` | built, flat not pivoted |
| — | — | `pb_ts_dept` | added (hours by department) |
| — | — | `pb_ts_dq` | added (data quality) |

Filters: 8 listboxes in Qlik. Seven reproduced (`Project`, `Resource`, `Year`,
`Month`, `Week`, `Date`, `Ticket Status`) plus `Department` and `Assignment`
from the app's other sheets. **`Timesheet Exempt` is blocked** —
`USER_ATTENDANCE_EXEMPT` has no column in `Employee_Data`.

## The two titles that were wrong in Qlik

`HFgj` and `PvbfS` are both titled "Planned vs. Actual Hours by …", but neither
plots a planned measure. Both series are `Sum(TICKET_HOURS)`, one filtered to
`FLAG='Assigned'` and one to `FLAG='Un-Assigned'`. `TICKET_PLANNED_HOURS` exists
on the table and is used by **no object on the sheet**. The Satori panel keeps
the identical maths and drops the wrong title.

(Only 43,653 of 297,195 rows carry a planned value at all, so a genuine
planned-vs-actual chart would show a near-zero plan bar on most projects. That
is a separate piece of work, not a rename.)

## `# of Zero Employee` was redefined, deliberately

Qlik's expression counts `USER_EMPLOYEE_ID` values where planned hours, actual
hours and FLAG are all null — i.e. users present in the USER dimension with no
ticket rows at all. That is an artefact of Qlik's associative model, and it is
why its "Total Employee" KPI reads 1,793 (every row of `TMC_USER`) while only
1,811 users appear in the fact.

The Satori tile counts the scoped employee master minus everyone who logged
anything in the window — the number a manager can act on. Expect a different
figure from Qlik's.

## Join direction, and why totals include unmatched people

36,317 of 297,195 rows — 238,507 hours across 279 people — carry employee codes
with no active record in `Employee_Data` (leavers, contractors, interns). An
INNER JOIN would delete 15% of the company's logged hours and make this
dashboard quietly disagree with Qlik, so:

* **unscoped users** get a LEFT JOIN; attributes fall back to `Unspecified`
  and the person shows as `(unmatched) <code>`. Totals match the fact.
* **department-scoped users** get INNER-JOIN semantics (`ts_scope`), because
  the lenient version would leak hours outside their scope.
* `pb_ts_dq` counts the unmatched hours so they stay visible instead of being
  quietly absorbed.

## Two bugs found and fixed while building this

1. **`Employee_Data` holds duplicate rows for 7 employee codes** (E-1898 three
   times), some differing only in name spelling — `E-1474 - Hussain Ahmed`
   vs `E-1474 Hussain Ahmed`. Joined raw, those people's timesheet rows came
   back two or three times: the 2026 window returned **198,287 rows against a
   fact holding 198,010**, and 1,694 hours were double-counted. The `emp` CTE
   now keeps one row per code, choosing the most complete record and breaking
   ties on the name so the result is stable between runs.

2. **The `resource_name` filter could return an empty dashboard.** Its options
   come from raw `Employee_Data`, so those 7 people appeared twice in the
   dropdown, while any CTE that dedupes the master keeps only one spelling —
   so one of the two entries matched nothing. `_PB_CANON_NAME` now normalises
   the name on *both* sides. **This bug also affected the existing Delivery
   dashboard**, which uses the same filter field; it is fixed there too.

## Numbers will not match Qlik, and the reason is upstream

The BigQuery feed is a subset of what Qlik reads — in every month, not just
recent ones, so this is not sync lag:

| | Qlik | BigQuery | gap |
|---|---|---|---|
| fact rows | 324,361 | 297,195 | −8.4% |
| total hours | 1,668,655 | 1,588,771 | −4.8% |
| distinct users in fact | 1,811 | 1,160 | −36% |
| distinct projects in fact | 450 | 307 | −32% |

Examples: May 2025 is 15,313 rows in Qlik and 13,102 in BigQuery; Nov 2025 is
11,217 against 10,317. `pipeline/drive_to_bq.py` loads `timesheet.csv` verbatim
with no filtering or joins, and no rows are lost to date-parse failures (the
per-month counts sum exactly to the table total). **The CSV being exported to
Drive is itself short.** Whoever produces that export should be the next stop —
until then the shapes on this dashboard are right and the magnitudes run a few
per cent under Qlik.

Separately, BigQuery trails by ~2 days (max `DATE_KEY` 2026-09-13 vs Qlik's
2026-09-15), which is ordinary sync cadence. The period label says how far the
data actually reaches so a partly-loaded month does not read as a quiet month.

## Verification performed

All 12 panels executed against production BigQuery: no errors, ~0.9–2.4 s each.
All 9 filter predicates exercised through the real `{where}` path, plus a
two-filter combination and the `{f:ts_month}` window move. The Assigned series
starting only in March 2026 (304 hours, then ramping) was confirmed against
Qlik — that is when assigned timesheets went live, not a query artefact.

Not yet done: rendering in the browser. The code is not deployed and needs a
local `uvicorn` run to be seen on screen.
