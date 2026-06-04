# Satori — Session Handoff & Context Document
_Last updated: 2026-06-02. Paste this into a new conversation as context._

## 1. What Satori is
AI-powered **workforce + sales intelligence** platform for TMC (TallyMarks Consulting). Successor to "Satori v1". Folder name `satori_SFML` is legacy branding (POLYPACK → FFC → SFML → TMC rebrands).

**Stack**
- **Backend:** FastAPI (Python). Single big `backend/main.py` (~7,700 lines) + modules: `auth.py` (JWT + typed tokens), `totp.py` (2FA), `database.py` (schema + migrations), `bigquery_client.py` (BQ + QUERY_MAP), `live_schema.py` (hourly schema probe injected into prompts), `report_generator.py` (Excel/PDF), `audit.py`, `redact.py` (PII), `emailer.py` (SMTP — added this session).
- **Frontend:** React 19 + Vite, **one giant file** `frontend/src/Growgnition.jsx` (~10k lines) + `AvailabilityEngine.jsx`. Entry: `main.jsx → Growgnition.jsx`. (`App.jsx`, `LogoPreview.jsx`, `SatoriFinanceDashboard.jsx` are unused legacy.)
- **AI:** Google Gemini 2.5 Flash (chat, dashboard/report generation, drill-down, insights).
- **Data warehouse:** BigQuery, project `capability-agent-prod`, dataset `Satori_Project`.
- **App DB:** Cloud SQL Postgres (users, dashboards, reports, audit, scope). Local dev falls back to SQLite (`growgnition.db`).

**Repo:** `C:\Users\Hp\Desktop\New Satori\satori_SFML-main` · GitHub `github.com/mahadlaeeque/New_Satori` (branch `main`).

## 2. Deployment & infrastructure (IMPORTANT)
- **Canonical app (the ONLY one now):** Cloud Run service `satori-v2` in project **`capability-agent-prod`**, region `us-central1`.
  **URL:** `https://satori-v2-qje7n5jw5a-uc.a.run.app`
- The old `ai-vertex-mahad/satori-v2` (URL `…iwr6mui7wa…`, separate stale DB) was **deleted**; its Cloud SQL `satori-v2-db` was **stopped** (data preserved, restart with `--activation-policy=ALWAYS`). Don't recreate it.
- **No Cloud Build trigger exists.** Deploys are **manual**:
  ```
  gcloud builds submit --config=cloudbuild.yaml --substitutions=_TAG=<short-sha> --project=capability-agent-prod .
  ```
  The build: syntax-check → Docker build (Vite frontend + Python) → push to Artifact Registry `satori` → `gcloud run deploy satori-v2` (preserves existing env/secrets).
- **Git workflow used:** feature branch → push → fast-forward into `main` → push `main` → manual deploy. (Pushing GitHub `main` does NOT auto-deploy.)
- **Env/secrets persist across deploys** (deploy step doesn't pass `--set-env-vars`). Key env on the service: `VERTEX_PROJECT=capability-agent-prod`, `VERTEX_DATASET=Satori_Project`, `CLOUD_SQL_CONNECTION_NAME=capability-agent-prod:us-central1:satori-v2-db`, `DB_NAME=satori`, `DB_USER=satori-user`, `APP_BASE_URL=https://satori-v2-qje7n5jw5a-uc.a.run.app`, `SMTP_USER`/`SMTP_FROM`=mahad.laeeque@tmcltd.com, `SMTP_FROM_NAME=Satori`. Secrets: `DB_PASSWORD`, `JWT_SECRET`, `GEMINI_API_KEY`, `satori-smtp-password`, `BYPASS_OTP`.
- **Auth gotcha:** both `gcloud` CLI tokens and **ADC** (`gcloud auth application-default login`, used by the local BigQuery client) expire ~hourly. In long sessions they need re-auth. The deployed service uses the runtime SA `satori-runtime@capability-agent-prod` (always valid), so **testing via the live API is the reliable path** when local ADC is dead.

## 3. Accounts, auth, 2FA
- **Superadmin privileges** = `role='admin'` AND email in the `_SUPERADMIN_EMAILS` allowlist in `main.py` (gates System Settings + scope config; admins are already all-features + unrestricted data).
  **Allowlisted:** `superadmin@tmc.com` (bootstrap), `numair.mazhar@tmcltd.com`, `mahad.laeeque@tmcltd.com`.
- **Default password for everyone: `welcome`.** New users set up their own 2FA (TOTP) on first login.
- **2FA bypass code: `121212`** (System Settings → Bypass OTP). Works at the 6-digit prompt for any account.
- **2FA persistence fix:** `_migrate_finalize_tmc_superadmin` used to wipe the superadmin's TOTP on every cold start (the "QR resets every deploy" bug). Now it's non-destructive once `superadmin@tmc.com` exists, so enrollment survives deploys.
- To **reset a user's QR/2FA**: `DELETE /api/admin/users/{id}/2fa` (admin) → that account re-enrolls on next login.
- To **create a superadmin**: add email to `_SUPERADMIN_EMAILS` + create the user row with `role=admin`.

## 4. Data warehouse quirks (capability-agent-prod.Satori_Project)
The code historically assumed a CamelCase schema; the live tables are a **mix** — these are the verified real names:
- **`Employee_Data`** columns: `Employee_Code`, `Resource_Name` (NOTE: carries a code prefix, e.g. `"E-1571 Mahad Laeeque"`), `EmployeePosition`, `EmployeeEmail`, **`EmployeeHierarchyNode`** (= department), `EmployeeLocation`, `Employee_Status`, `Employee_Type`. (So `EmployeePosition/Email/HierarchyNode/Location` are CamelCase; `Employee_Code/Status/Type` are underscored.)
- **`Attendance_Data`**: `attendance_date` (DATE), **`personal_no`** (STRING 'E-902' — the join key), `employee_id` (INT64, NOT a join key), `employee_name`, `checkin_time`, `checkout_time`, **`attendance_status_text`** (values: Present, Absent, On Leave, Holiday, Weekend, Missing Punch, Remote Work; **NO 'Late'**). **There are NO `is_present`/`is_absent`/… flag columns** — derive counts via `COUNTIF(LOWER(attendance_status_text)='present')` etc. Date range ~2025-12-01 → 2026-04-24.
- **`Allocation_Data`** (capital D!): `employee_id` ('E-2141' code), `allocation_percent` (STRING → SAFE_CAST), `emp_competency`, **`Flag` = 'Allocated'/'Bench'** (NOT 'Actual'/'Forecast'), `Date`.
- **`Timesheet_Data`**: `TICKET_USER_ID`, `TICKET_PROJECT_LABEL`, `TICKET_HOURS` (STRING), `DATE_KEY`, etc.
- **Sales tables** (shared, not department-scoped): `Sales_Accounts`, `Sales_AM_Scorecard`, `Sales_Pipeline_Health`, `Sales_Plan_vs_Pipeline`, `Sales_Hunting_Gap`, `Sales_KPI_Scorecard`, `Sales_Dormant_Accounts`, `Sales_Workload_Feasibility`. Also `Practice_Heads_List`, `Project_Master`.

**JOIN KEYS (digit-normalised — names DO NOT match):** `norm(x)=LTRIM(REGEXP_REPLACE(CAST(x AS STRING),r'[^0-9]',''),'0')`
- Attendance→Employee: `norm(personal_no)=norm(Employee_Code)` (~1179/1197 overlap; name join only ~5 → broken).
- Allocation→Employee: `norm(employee_id)=norm(Employee_Code)`. Timesheet→Employee: `norm(TICKET_USER_ID)=norm(Employee_Code)`.

**Self-healing safety net:** `_autofix_dashboard_sql` runs on **every** dashboard/report/drilldown query before BigQuery and deterministically corrects common model hallucinations: `Employee_Hierarchy[_Node]→EmployeeHierarchyNode`, `Employee_Position/Email/Location→CamelCase`, `Allocation_data→Allocation_Data`, `Employee_Type` case, attendance `'late'`, `Flag 'Actual'/'Forecast'→'Allocated'/'Bench'`. Add new patterns here if new hallucinations appear. The chat `run_sql` path relies instead on the corrected `live_schema` block + `SYSTEM_PROMPT`.

> Note: the chat `SYSTEM_PROMPT`, voice prompts, and dashboard/report **example** text in `main.py` still contain some stale `is_present` references (~30) — they're overridden at runtime by the corrected `live_schema` snapshot + the autofix, so they don't break things, but a future cleanup could remove them. The dead `/api/ar|ap|stock|invoices/data` endpoints (unused legacy dashboards) also still use `is_present`.

## 5. Department data scoping
- Storage: `user_data_scope` (values) + `user_data_scope_policy` (enforced flag), dimension `"department"`. Values are the practice `Department` (e.g. "SAP GRC"); Rai Sohaib Amjad has two ("SAP Finance","SAP Controlling").
- The `Department` value matches `Employee_Data.EmployeeHierarchyNode` **case-insensitively** (e.g. "SAP ABAP & FIORI" vs "SAP ABAP & Fiori") — all scope SQL must `LOWER()` both sides.
- **Enforcement** (`_compute_scope_policy` + `_dept_scope_addon_str` + `_enforce_dept_scope_on_sql`): admins/superadmin = unrestricted; scoped non-admins are restricted on chat/voice/dashboards/reports/Availability Engine; **sales data stays shared**. `_enforce_dept_scope_on_sql` now **validates** (doesn't inject into the outer WHERE — that broke CTE queries with "Unrecognized name EmployeeHierarchyNode"); it confirms the model's SQL is filtered to an allowed dept and otherwise returns a `SCOPE_REFUSED` sentinel. `find_relevant_data` pre-injection is skipped for scoped users (else cross-dept aggregates leak).
- For named-person questions, a scoped user gets "X isn't in your department, can't share their details" (not "no records").
- Admin UI: **User Management → Department column** + per-user **Data scope** modal (department multi-select) + **Sync Departments** button (re-reads Practice_Heads_List → resets each head's dept scope) + per-user **Manage features** + a real **hard-delete** (removes user + dependents). System Settings has the company-level department dimension toggle (superadmin only).

## 6. Everything done this session (chronological)
1. **Department scoping (re-enabled + wired):** it was globally disabled; re-enabled enforcement for chat/voice/dashboards/reports; case-insensitive matching; UI Department column; rewrote the dead "plant" scope modal → department; fixed practice-head import to seed from the `Department` column.
2. **Push/deploy:** established workflow; deployed to capability-agent-prod (after a wrong-project detour to ai-vertex-mahad that was cancelled).
3. **`Allocation_data → Allocation_Data`** rename across backend (Availability KPIs were 404ing).
4. **Stale `is_present`/`Flag` cleanup** in QUERY_MAP (orientation queries) + chat SYSTEM_PROMPT/addon → derive from `attendance_status_text`, real Flag values.
5. **Attendance agent fix:** corrected `live_schema` join guidance (was recommending the broken name join) → chat attendance queries work.
6. **Scoped attendance/timesheet/allocation fix:** `_enforce_dept_scope_on_sql` switched from inject-into-CTE (broke) to validate; case-insensitive `LOWER(EmployeeHierarchyNode) IN (...)` + correct join keys in the addon.
7. **Out-of-scope person messaging** for scoped users.
8. **2 superadmin users** created (`numair.mazhar@`, `mahad.laeeque@`, password `welcome`) + allowlist.
9. **Self-service password reset:** `POST /api/forgot-password` (emails a 30-min link; generic response; link also logged server-side) + `POST /api/reset-password`; "Forgot password?" on login + `ResetPasswordPage` at `#reset?token=…`. Email via **Gmail SMTP** (`backend/emailer.py`, secret `satori-smtp-password`, sender mahad.laeeque@tmcltd.com). **Verified emails send.**
10. **2FA-persistence fix** (`_migrate_finalize_tmc_superadmin` no longer wipes on deploy).
11. **Hard-delete** users; deleted seeded "Anas"/"Bilal".
12. **Decommissioned** old ai-vertex-mahad deployment (deleted service, stopped DB).
13. **Dark-mode polish:** re-tint pale status/info card backgrounds; fix Sample Prompt cards/pills that reset to white.
14. **AI Insights:** `POST /api/ai/insights` (Gemini) + `<AiInsights>` panel under built reports (ReportPreview) and dashboards (DashboardRenderer) — number-grounded bullets.
15. **Dashboard column autofix:** deterministic Employee_*/Allocation_Data name correction in `_autofix_dashboard_sql` (fixed "Name Employee_Hierarchy not found").
16. **Drill-down fix:** rewrote `_DRILLDOWN_PROMPT` (correct schema, `attendance_status_text`, `personal_no` join), disabled Gemini "thinking" + raised tokens (was truncating SQL → "end of script"), made drills department-scoped. Verified clicking a bar returns the underlying employees; date/AM drills work.

## 7. Current live state (verified)
- Latest `main` commit: **`e3795d7`**; serving Cloud Run revision **`satori-v2-00099-44g`**. Health: `{"ok":true,…,"project":"capability-agent-prod"}`.
- Dashboards/reports build and render; the saved "March 2026 Attendance Overview" runs error-free; drill-down works across attendance/sales/date charts; AI insights render; password-reset emails send; department scoping enforced for non-admins.

## 8. Standing preferences / how to work
- **I (the assistant) handle both push and deployment** to capability-agent-prod without re-asking. Commit only intended files (the working tree has unrelated pre-existing WIP — never `git add -A`). End commits with the Co-Authored-By line.
- **Local build:** run `npm run build` via PowerShell (the Bash tool can't resolve the `vite` shim). `node_modules` has occasionally been corrupted (`@reduxjs/toolkit` from recharts) → `npm install` to repair.
- **Local backend:** `python -m py_compile` for syntax; importing `main` needs `pyotp`+`qrcode`; SQLite is used unless `CLOUD_SQL_CONNECTION_NAME` is set. Set `database.DB_PATH` before importing `main` to isolate a test DB.
- **Testing:** prefer the **live deployed API** (login `superadmin@tmc.com`/`welcome` → `/api/2fa/verify` with code `121212` → token) when local ADC is expired.

## 9. Known open / optional items
- Stale `is_present` references remain in chat/voice/dashboard **example prompt text** + dead `/api/*/data` endpoints (mitigated, not breaking).
- A brand-new hallucinated table/column would fall to the LLM repair loop; add it to `_autofix_dashboard_sql` if it recurs.
- `report_generator.py` still contains an old `sap_hana_mirror` SAP schema in some prompts (inert; report path uses live table discovery).
- Two definitions of "bench" (Availability KPI = 90-day max_pct=0 ≈ 31; chat/all-time ≈ 5) — could be unified.
- "Voice" is one feature flag with chat ("Ask Me Anything"); the voice backend is a stub.
