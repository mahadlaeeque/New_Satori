# "Usman Tufail's allocation is not reflecting" — findings and fix

Raised by Yousuf Muhammad, 6 Oct 2026; escalated to the Satori team by Numair
Mazhar, 7 Oct. Two separate problems were reported in that thread.

---

## Problem 1 — the allocation really was missing from the view

### What was reported
E-553 Usman Tufail reads **0.0 for Jan–Sep** in *Monthly Utilisation by
Resource*, with values only from Oct onward. Totals 2.9.

### What the data says
| check | result |
|---|---|
| In `Employee_Data`? | Yes — E-553, Permanent, Capability (Functional) |
| Allocation rows, 2026 | **408 rows**, allocated **100% in every month Jan–Dec** |
| Timesheet rows, by `EMPLOYEE_CODE` | **0** |
| Timesheet rows, by `TICKET_USER_ID` | **0** |

So nothing is broken in the joins. He is fully booked all year and has **never
logged a timesheet hour**.

### Why that produced zeros
The `val` CTE computes utilisation as:

```sql
SAFE_DIVIDE(COALESCE(a.hours,0)/8 + COALESCE(am.frac,0) * c.plandays,
            NULLIF(c.wdays,0)) AS util
```

`c.plandays` counts only working days **on or after this Monday**, so for any
elapsed month it is `0`. Elapsed months are therefore driven purely by
`a.hours` — logged timesheet hours. For someone who never files a timesheet,
every past month evaluates to `0 + 0`, and the grid shows `0.0`.

This is the documented design — "logged hours up to last week, the allocation
plan from this week on" — and it is right for delivery staff. It fails for
anyone whose work does not pass through Project Flow, because **a row of zeros
is indistinguishable from idle capacity.**

### This is not one person — it is 17% of the company
180 of the 1,048 people with a 2026 allocation have **zero** logged hours, and
they cluster by function:

| department | silent / allocated |
|---|---|
| KPO | 40 / 40 |
| SOC | 16 / 16 |
| Account Management | 15 / 15 |
| Finance | 12 / 12 |
| Admin | 8 / 8 |
| Management | 7 / 7 |
| Marketing | 7 / 7 |
| Talent Consulting | 6 / 6 |
| HR Business Partnering & Rewards | 5 / 5 |
| BOD | 5 / 5 |
| International Business | 8 / 9 |
| Digital | 6 / 68 |
| Cloud | 4 / 15 |

Whole back-office functions report as 0% utilised for every elapsed month.
Delivery-side departments are largely unaffected, which is why this surfaced
only when someone looked up a Capability (Functional) resource.

### The fix
Utilisation itself is **unchanged**. Substituting allocation for actuals in
elapsed months would make 180 people appear fully utilised on the strength of
a forecast, and would corrupt the one number the rest of the dashboard exists
to report. Numair's point in the thread — "allocation is forecast" — is
correct and is preserved.

What changed is that the view no longer hides the allocation:

1. **`val` now carries `alloc_frac` and `logged_hours`** — the month's booking
   in its own right, for elapsed months too, not multiplied by `plandays`.
2. **The resource table gains two columns before the monthly grid**:
   *Allocated* (average booking across the year) and *Hours Logged*.
   E-553 now reads **Allocated 1.00, Hours Logged 0** — self-explanatory,
   instead of a silent row of zeros.
3. **New KPI "Allocated, No Hours Logged"** = 180, so the population is
   countable on the face of the dashboard rather than rediscovered one
   resource at a time.
4. **The panel subtitle now states the basis switch** — that elapsed months
   count logged hours and future months count the allocation book. That
   distinction was the root of the whole email thread and was nowhere on
   screen.

This keeps Yousuf's actual requirement — one view, no navigating to a second
sheet — while keeping the metric honest.

### Verified
* New KPI returns **180**, matching an independent count.
* Pivot runs clean; E-553 returns `Allocated 1.0 · Hours Logged 0 · Total 2.9`.
* Company TOTALS row unchanged at 9054.3, so no existing figure moved.

---

## Problem 2 — the raw model error shown to users

The *Ask Me Anything* screenshot in the thread shows:

```
Error (502): Gemini API error: 403 PERMISSION_DENIED. {'error': {'code': 403,
'message': 'Spend cap breached for project: projects/312515905498 for service:
generativelanguage.googleapis.com', 'status': 'PERMISSION_DENIED'}}
```

Two things wrong with that.

**It is a billing condition, not a bug.** The Gemini spend cap on the GCP
project has been breached, so the model API is refusing every request. **No
code change fixes this** — someone with billing access has to raise or remove
the spend cap on `generativelanguage.googleapis.com` for that project. Until
then the chat assistant stays down. Dashboards and reports are unaffected;
they read BigQuery and never touch the model API.

**It should never have reached a user's screen.** Three code paths returned the
upstream exception verbatim — `_chat_impl`, the `/api/chat/stream` generator,
and the AI ranking endpoint. That leaks the GCP project number and service
topology to anyone with a login, and it has now travelled into an email thread
and a PDF. It also tells the reader nothing they can act on.

All three now route through `_ai_user_error()`, which logs the full text
server-side and returns a plain message. For this condition the user sees:

> The AI assistant has reached its usage limit for this billing period.
> Dashboards and reports are unaffected and stay up to date — only the chat
> assistant is paused. Satori support has been notified.

Quota, rate-limit, auth, and timeout cases get their own wording; anything
unrecognised gets a neutral fallback.

---

## Also fixed in passing

The delivery `emp` CTE reshaped `"E-599 Nauman Zia Qazi"` into
`"E-599 - Nauman Zia Qazi"` unconditionally. A few master rows already carry
the dash, so those became **`E-1230 - - Muhammad Usman Sabir`** — which sorts
and reads as a different person from their own other rows. The reshape is now
guarded. (The Timesheet dashboard already had this guard; Delivery did not.)

---

## Still open — for the business, not the code

The thread's underlying disagreement is about **what the number should mean**,
and that is not a Satori decision:

* Should back-office functions appear in a *utilisation* dashboard at all, given
  they will never log Project Flow hours? If yes, utilisation needs a second,
  explicitly allocation-based basis and everyone needs to agree which one is
  quoted in reporting.
* Yousuf's "we need to lock these figures" is a real requirement that nothing
  currently implements — every panel recomputes live from the warehouse, so
  figures move as the feed updates. Period-end snapshots would be a separate
  piece of work.

Both are worth settling in the session Numair proposed, before any further
change to the metric.


---

## Update, 9 Oct 2026: actuals and allocations now in one view

Umair Bin Wasim (Director) set the requirement precisely:

> "Even for past months, allocations should not reflect actuals ... Actuals
> should instead be reflected in the project flow. This will provide clear
> visibility into planned versus actual resource utilization; otherwise, we
> will lose the ability to track the variance between the two."

Yousuf confirmed: "the main requirement remains to have both actuals and
allocations in a single dashboard."

The 8 Oct change did not meet that. It added *annual* Allocated and Hours
Logged columns, which explained why a row was zero but still left the monthly
grid showing a single blended number that silently switched basis at the
current week. That blend is exactly what Umair asked us to stop doing.

### What was built

A **View** selector on the Delivery dashboard, first in the filter row. It
changes which measure the monthly grid renders. One table, one dashboard,
four readings:

| View | Monthly cell shows |
|---|---|
| Utilisation (actual + forecast) | the original blended figure; the default |
| Actual (logged hours) | logged hours over capacity, every month |
| Allocation (booked) | the allocation book, every month |
| Variance (actual - allocation) | the gap, completed months only |

Mechanically: `val` now carries `actual_util` (logged hours over capacity for
*all* months, not just elapsed ones) alongside `alloc_frac`, and the grid
selects between them through a `{f:basis}` placeholder. Filters can now also
carry a static `options` list, which did not exist before, because there is
no table to read "Allocation (booked)" out of.

### Verified against production

E-553 Usman Tufail, 2026:

| View | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Utilisation | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.9 | 1.0 | 1.0 |
| Actual | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| Allocation | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| Variance | -1.0 | -1.0 | -1.0 | -1.0 | -1.0 | -1.0 | -1.0 | -1.0 | -1.0 | | | |

E-1421 Muhammad Usman, who does file timesheets, shows variance of +0.1 to
-0.1 across Jan to Sep: allocation and delivery broadly agreeing, which is
what the measure is for.

**Variance is blank for any month not fully elapsed.** Computed blind it read
-1.0 for every future month for every resource, which made the entire company
look like it was under-delivering. The current month is excluded for the same
reason: `act` counts hours only up to last Monday, so part of a month measured
against a whole month of allocation is an artefact, not a variance. The test
is year-aware, so December of a past year is not wrongly blanked.

### Answering the original question directly

Yousuf's "allocation is not reflecting" is now resolved in the sense he meant:
switch the View to **Allocation (booked)** and E-553 reads 1.0 in every month
of 2026. No second sheet, no other system.
