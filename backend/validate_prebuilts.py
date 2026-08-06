"""Run every prebuilt-dashboard panel against BigQuery and report what happened.

Exercises the exact production path — _substitute_params -> _substitute_where ->
normalize_bq_project -> _autofix_dashboard_sql -> bq_run_query — so a pass here
means the panel works when a user opens it, not merely that the SQL parses.

Usage (from backend/):  python validate_prebuilts.py [dashboard_key ...]
"""
import io
import os
import sys
import time

os.environ.setdefault("VERTEX_PROJECT", "capability-agent-prod")
sys.stdout.reconfigure(encoding="utf-8")

import main  # noqa: E402

USER = {"sub": "1", "role": "admin", "email": "mahad.laeeque@tmcltd.com"}

# Two passes per panel: bare (what a user sees on open) and with a
# representative selection, because the filter path is where the {where}
# injection can break against a CTE that doesn't expose the column.
FILTER_SETS = {
    "attendance": [{}, {"month": None, "status": "Present"}],
    "delivery":   [{}, {"year": None, "employee_type": "permanent"}],
    "workforce":  [{}],
    "sales":      [{}],
}

MAX_SQL_ECHO = 1400


def resolve_dynamic(defs_key, filters):
    """Fill in filter values that depend on what's actually in the warehouse."""
    out = dict(filters)
    for field in ("month", "year"):
        if field in out and out[field] is None:
            reg = main._FILTER_REGISTRY.get(field)
            table, expr, _ = reg
            sql = main.normalize_bq_project(
                f"SELECT MAX({expr}) AS v FROM {main.sql_table(table)}")
            r = main.bq_run_query(sql, max_rows=1)
            out[field] = (r.get("rows") or [{}])[0].get("v")
    return {k: v for k, v in out.items() if v not in (None, "")}


def run_panel(kind, panel, filters, log):
    sql_tpl = panel.get("sql") or ""
    if not sql_tpl:
        return "SKIP", "no sql"
    s = main._substitute_params(sql_tpl, filters)
    s = main._substitute_where(s, filters)
    s = main.normalize_bq_project(s)
    s = main._autofix_dashboard_sql(s)
    t0 = time.time()
    r = main.bq_run_query(s, max_rows=int(panel.get("maxRows") or 200))
    ms = int((time.time() - t0) * 1000)
    if "error" in r:
        log.write(f"\n--- FAILING SQL [{panel.get('id')}] ---\n{s[:MAX_SQL_ECHO]}\n")
        return "ERROR", f"{ms}ms  {r['error'][:400]}"
    rows = r.get("rows") or []
    if not rows:
        log.write(f"\n--- EMPTY SQL [{panel.get('id')}] ---\n{s[:MAX_SQL_ECHO]}\n")
        return "EMPTY", f"{ms}ms  0 rows"
    if kind == "kpi":
        v = main._pick_kpi_value(rows, r.get("columns") or []) if hasattr(main, "_pick_kpi_value") \
            else list(rows[0].values())[0]
        if v in (None, ""):
            return "EMPTY", f"{ms}ms  null value"
        return "OK", f"{ms}ms  value={v}"
    sample = {k: rows[0][k] for k in list(rows[0])[:6]}
    return "OK", f"{ms}ms  {len(rows)} rows  first={sample}"


def main_():
    wanted = sys.argv[1:] or None
    defs = main._pb_dashboard_defs(USER)
    log = io.open("validate_prebuilts.log", "w", encoding="utf-8")
    totals = {"OK": 0, "EMPTY": 0, "ERROR": 0, "SKIP": 0}

    for d in defs:
        key = d["key"]
        if wanted and key not in wanted:
            continue
        cfg = d["config"]
        print(f"\n{'=' * 78}\n{cfg['title']}  (key={key})\n{'=' * 78}")
        for raw_filters in FILTER_SETS.get(key, [{}]):
            filters = resolve_dynamic(key, raw_filters)
            print(f"\n  filters = {filters or '(none)'}")
            panels = ([("kpi", k) for k in cfg.get("kpis", [])]
                      + [("chart", c) for c in cfg.get("charts", [])])
            if cfg.get("periodSql"):
                panels.append(("chart", {"id": "periodSql", "title": "resolved period",
                                         "sql": cfg["periodSql"]}))
            for kind, panel in panels:
                status, detail = run_panel(kind, panel, filters, log)
                totals[status] += 1
                mark = {"OK": "  ok  ", "EMPTY": " EMPTY", "ERROR": " ERROR", "SKIP": " skip "}[status]
                print(f"   [{mark}] {panel.get('title', panel.get('id'))[:44]:<46} {detail[:150]}")
            # drill queries carry a {label}; exercise one with a real value
            for c in cfg.get("charts", []):
                if not c.get("drillSql"):
                    continue
                probe = main._substitute_where(main._substitute_params(c["sql"], filters), filters)
                probe = main._autofix_dashboard_sql(main.normalize_bq_project(probe))
                pr = main.bq_run_query(probe, max_rows=1)
                rows = pr.get("rows") or []
                if not rows:
                    print(f"   [ skip ] drill {c['id']}: parent returned no rows to click")
                    continue
                label = rows[0].get(c.get("labelKey")) or list(rows[0].values())[0]
                dpanel = {"id": f"drill:{c['id']}", "title": f"drill {c['id']} <- {label}",
                          "sql": c["drillSql"].replace("{label}", str(label).replace("'", "\\'"))}
                status, detail = run_panel("chart", dpanel, filters, log)
                totals[status] += 1
                print(f"   [{ {'OK':'  ok  ','EMPTY':' EMPTY','ERROR':' ERROR','SKIP':' skip '}[status]}] "
                      f"{('drill ' + c['id'])[:44]:<46} {detail[:150]}")

    print(f"\n{'=' * 78}\nTOTALS  {totals}")
    print("Failing/empty SQL written to backend/validate_prebuilts.log")
    log.close()
    return 1 if totals["ERROR"] else 0


if __name__ == "__main__":
    sys.exit(main_())
