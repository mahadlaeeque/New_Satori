# Can we put all the tables on one dashboard view? — measured answer

Context: Yousuf Muhammad asked for "a single dashboard that provides a
complete and unified view of all reflections, without requiring to navigate
across multiple sheets". Numair Mazhar's objection was that consolidating
"will reduce performance and will start looking like a pdf instead of
dashboard".

Both claims were testable. Measured against the live Satori Delivery board
(satori-v2, production BigQuery) on 8 Oct 2026.

## 1. Query time is not the constraint

One real chart query, replicated N times in a single dashboard config:

| panels requested | wall clock |
|---|---|
| 1 | 3,150 ms |
| 2 | 4,513 ms |
| 4 | 3,764 ms |
| 8 | 4,343 ms |

Going from 1 panel to 8 costs about 1.2 seconds, not 8×. Panels fan out
across a thread pool, so the wall clock is roughly **the slowest single
query**, not the sum of them. Adding tables to a view is close to free in
query time.

So the performance objection does not hold for Satori. It may well hold for
the Qlik app it was made about — that is a different engine with a different
execution model, and nothing here contradicts it.

## 2. The real blocker was a silent panel cap

`_dashboard_run_impl` capped KPIs, charts and filters at `[:8]` each and
dropped the remainder **without any error**:

| panels asked for | panels returned |
|---|---|
| 6 | 6 |
| 8 | 8 |
| 10 | **8** — 2 silently dropped |
| 16 | **8** — 8 silently dropped |

This is what actually blocks a unified view. Build a 12-table dashboard and
four tables simply never appear — no error, no warning, and the dashboard
looks complete. (The same cap already bit us once: the Delivery
data-quality KPI was invisible for weeks because it sat ninth in the list.)

**Fixed.** Caps raised to 20 panels / 12 filters, and anything still cut is
logged server-side *and* returned in the payload as `truncated: [...]` so the
UI can say so. A missing table can no longer be invisible.

The worker pool went from 10 to 16 at the same time — with 10, a 16-panel
board queued a second wave and roughly doubled the wait. BigQuery allows 100
concurrent interactive queries per project, so 16 stays an order of magnitude
inside the limit the cap exists to respect.

## 3. What does cost something: payload, and it is three tables

Delivery board, 14 panels, 553 KB total:

| size | rows | panel |
|---|---|---|
| 240 KB | 1,000 | `pb_dl_recon` (table) |
| 220 KB | 1,000 | `pb_dl_monthly` (table) |
| 74 KB | 278 | `pb_dl_project` (table) |
| 5 KB | 12 | `pb_dl_trend` (bar) |
| 5 KB | 25 | `pb_dl_comp` (bar) |
| 5 KB | 14 | `pb_dl_gl` (bar) |
| 4 KB | 4 | `pb_dl_bands` (donut) |

**534 of 553 KB is three big tables. All four charts together cost 19 KB.**

Payload — and the browser work to render it — scales with *rows in wide
tables*, not with *number of panels*. Ten more charts would add ~50 KB.
Three more 1,000-row tables would add ~700 KB and would be felt.

## 4. Recommendation

Consolidation is feasible, and the honest answer to Yousuf is **yes**. But
"all the tables stacked on one page" is the wrong shape of yes, and Numair's
second objection — that it stops being a dashboard and becomes a PDF — is the
one that survives the measurements.

What to do:

1. **One dashboard, sections within it.** Keep the single-page requirement.
   Group panels under headings so the page has a reading order instead of
   being a wall of grids.
2. **Summary first, detail on demand.** The three heavy tables are detail
   views. Lead with the KPIs and charts, and let the big tables be reached by
   the drill-down that already exists on every row, rather than rendering
   3,000 rows nobody scrolls.
3. **Cap rows, not tables.** `maxRows` already exists per panel. 1,000-row
   tables are the cost driver; 200 rows plus drill-down costs a fifth of the
   payload and loses nothing a user actually reads.
4. **Use the streaming endpoint** (`/api/dashboard/run/stream`). Panels
   already arrive progressively with a real percentage, so even a two-wave
   board feels responsive rather than frozen.

That gives one view, no navigating between sheets, and no performance cliff.

## 5. What this does NOT solve

Yousuf's other requirement — "we need to lock these figures for proper
reporting" — is untouched by any of the above. Every panel recomputes live
from the warehouse, so figures move whenever the Drive feed reloads. Locked
period-end snapshots are a separate piece of work and should be scoped
separately; consolidating the layout will not make the numbers stable.
