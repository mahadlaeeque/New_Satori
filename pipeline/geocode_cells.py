#!/usr/bin/env python3
"""
Reverse-geocode attendance punch cells into area names.

Attendance_Data carries only raw checkin/checkout latitude and longitude
(as strings). This step turns those into a lookup table, Geo_Cells, keyed
on the ~1 km cell (2-decimal lat/lon) that the Attendance Pulse map already
uses, so the dashboards can say "Paragon City, Lahore" next to
"31.52, 74.44" with a plain LEFT JOIN and no per-request geocoding.

Called at the end of each Drive -> BigQuery sync. Each run resolves only
cells that are not yet in Geo_Cells, heaviest cells (most punches) first,
and stops after MAX_CALLS or MAX_SECONDS, so the first few runs work
through the backlog (~3,000 cells as of Oct 2026) and later runs only pick
up genuinely new places. Nothing here is fatal to the sync.

Providers (env GEOCODE_PROVIDER):
  nominatim  (default) OpenStreetMap's public reverse geocoder. No key.
             Policy: max 1 request/second, a real User-Agent with a contact
             address, light use only — this throttles to ~0.9 req/s and caps
             each run. Results are ODbL and may be stored indefinitely with
             attribution ("© OpenStreetMap contributors").
  google     Maps Platform Geocoding API. Needs MAPS_API_KEY. Faster and
             richer, but Google's terms only allow caching results for 30
             days, so rows older than that are re-resolved.

Env: GEOCODE_PROVIDER, MAPS_API_KEY, GEOCODE_CONTACT (email shown in the
     Nominatim User-Agent), GEOCODE_MAX_CALLS, GEOCODE_MAX_SECONDS,
     GEOCODE_DISABLED (any non-empty value skips the step).
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from google.cloud import bigquery

GEO_TABLE = "Geo_Cells"

PROVIDER = (os.environ.get("GEOCODE_PROVIDER") or "nominatim").strip().lower()
MAPS_API_KEY = os.environ.get("MAPS_API_KEY", "").strip()
CONTACT = os.environ.get("GEOCODE_CONTACT", "satori@tmcltd.com").strip()
MAX_CALLS = int(os.environ.get("GEOCODE_MAX_CALLS") or 240)
MAX_SECONDS = int(os.environ.get("GEOCODE_MAX_SECONDS") or 300)
DISABLED = bool(os.environ.get("GEOCODE_DISABLED", "").strip())

# Nominatim asks for at most one request per second; stay under it.
_NOMINATIM_GAP = 1.1
_GOOGLE_GAP = 0.05

SCHEMA = [
    bigquery.SchemaField("lat2", "FLOAT64", mode="REQUIRED"),
    bigquery.SchemaField("lon2", "FLOAT64", mode="REQUIRED"),
    # The neighbourhood / suburb / village — the thing a person would call
    # "the area". NULL when the provider found nothing there (open country).
    bigquery.SchemaField("area", "STRING"),
    bigquery.SchemaField("city", "STRING"),
    # What the dashboards print: "area, city" with the empty parts dropped,
    # or "Unmapped area" when nothing came back.
    bigquery.SchemaField("label", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("provider", "STRING", mode="REQUIRED"),
    bigquery.SchemaField("resolved_at", "TIMESTAMP", mode="REQUIRED"),
]


def _log(msg):
    print(f"[geocode] {msg}", flush=True)


def _first(d: dict, *keys):
    for k in keys:
        v = d.get(k)
        if v and str(v).strip():
            return str(v).strip()
    return None


def _label(area, city):
    parts = [p for p in (area, city) if p]
    if not parts:
        return "Unmapped area"
    if len(parts) == 2 and parts[0].lower() == parts[1].lower():
        return parts[0]
    return ", ".join(parts)


def _http_json(url: str, headers: dict, timeout: int = 20):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _nominatim(lat: float, lon: float):
    """-> (area, city) or None on a transport error (so the cell is retried)."""
    url = ("https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode({
        "format": "jsonv2", "lat": f"{lat:.2f}", "lon": f"{lon:.2f}",
        # 14 = suburb level. 16+ returns the nearest street, which is noise
        # at a 1 km cell; the address block still carries the city.
        "zoom": 14, "accept-language": "en",
    }))
    headers = {"User-Agent": f"Satori-TMC-attendance-geocoder/1.0 ({CONTACT})",
               "Accept": "application/json"}
    try:
        j = _http_json(url, headers)
    except Exception as e:
        _log(f"nominatim error at {lat:.2f},{lon:.2f}: {e}")
        return None
    if not isinstance(j, dict) or "error" in j:
        return ("", "")          # resolved: nothing there
    a = j.get("address") or {}
    area = _first(a, "neighbourhood", "suburb", "quarter", "residential", "hamlet",
                  "village", "city_district", "borough", "town")
    city = _first(a, "city", "town", "municipality", "county", "state_district", "state")
    if city:
        # "Lahore District" is how OSM names the county; people say "Lahore".
        city = re.sub(r"\s+(District|Division|Tehsil)$", "", city, flags=re.I)
    if area and city and area.lower() == city.lower():
        area = None
    return (area or "", city or "")


def _google(lat: float, lon: float):
    url = ("https://maps.googleapis.com/maps/api/geocode/json?" + urllib.parse.urlencode({
        "latlng": f"{lat:.2f},{lon:.2f}", "key": MAPS_API_KEY, "language": "en",
        "result_type": "neighborhood|sublocality|locality",
    }))
    try:
        j = _http_json(url, {"Accept": "application/json"})
    except Exception as e:
        _log(f"google error at {lat:.2f},{lon:.2f}: {e}")
        return None
    status = j.get("status")
    if status == "ZERO_RESULTS":
        return ("", "")
    if status != "OK":
        # OVER_QUERY_LIMIT / REQUEST_DENIED: retry next run, do not poison the table.
        _log(f"google status {status} at {lat:.2f},{lon:.2f}: {j.get('error_message', '')}")
        return None
    area = city = None
    for res in j.get("results", []):
        for comp in res.get("address_components", []):
            types = set(comp.get("types", []))
            name = comp.get("long_name")
            if not area and types & {"neighborhood", "sublocality", "sublocality_level_1"}:
                area = name
            if not city and "locality" in types:
                city = name
        if area and city:
            break
    return (area or "", city or "")


def _ensure_table(bq, table_id: str):
    bq.query(
        f"CREATE TABLE IF NOT EXISTS `{table_id}` ("
        "lat2 FLOAT64 NOT NULL, lon2 FLOAT64 NOT NULL, area STRING, city STRING, "
        "label STRING NOT NULL, provider STRING NOT NULL, resolved_at TIMESTAMP NOT NULL)"
    ).result()


def _pending_cells(bq, project: str, dataset: str, limit: int):
    """Distinct ~1 km cells seen in Attendance_Data (check-in and check-out)
    that have no row in Geo_Cells yet — or, on the google provider, a row
    older than 30 days. Heaviest first so the office cells resolve in run 1."""
    att = f"`{project}.{dataset}.Attendance_Data`"
    geo = f"`{project}.{dataset}.{GEO_TABLE}`"
    stale = ("OR (g.provider = 'google' AND g.resolved_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY))"
             if PROVIDER == "google" else "")
    sql = f"""
    WITH pts AS (
      SELECT SAFE_CAST(checkin_latitude AS FLOAT64) AS lat, SAFE_CAST(checkin_longitude AS FLOAT64) AS lon FROM {att}
      UNION ALL
      SELECT SAFE_CAST(checkout_latitude AS FLOAT64), SAFE_CAST(checkout_longitude AS FLOAT64) FROM {att}
    ), cells AS (
      SELECT ROUND(lat, 2) AS lat2, ROUND(lon, 2) AS lon2, COUNT(*) AS n
      FROM pts
      WHERE lat IS NOT NULL AND lon IS NOT NULL
        AND lat BETWEEN -85 AND 85 AND lon BETWEEN -180 AND 180
        AND NOT (lat = 0 AND lon = 0)
      GROUP BY lat2, lon2
    )
    SELECT c.lat2, c.lon2, c.n
    FROM cells c
    LEFT JOIN {geo} g ON g.lat2 = c.lat2 AND g.lon2 = c.lon2
    WHERE g.lat2 IS NULL {stale}
    ORDER BY c.n DESC
    LIMIT {int(limit)}
    """
    return [(float(r["lat2"]), float(r["lon2"]), int(r["n"])) for r in bq.query(sql).result()]


def resolve_new_cells(bq, project: str, dataset: str,
                      max_calls: int = MAX_CALLS, max_seconds: int = MAX_SECONDS) -> dict:
    """Resolve up to max_calls pending cells and append them to Geo_Cells.
    Returns a small summary dict; never raises past a logged warning."""
    if DISABLED:
        _log("GEOCODE_DISABLED set — skipping")
        return {"skipped": True}
    if PROVIDER == "google" and not MAPS_API_KEY:
        _log("GEOCODE_PROVIDER=google but MAPS_API_KEY is empty — skipping")
        return {"skipped": True}
    resolver = _google if PROVIDER == "google" else _nominatim
    gap = _GOOGLE_GAP if PROVIDER == "google" else _NOMINATIM_GAP
    table_id = f"{project}.{dataset}.{GEO_TABLE}"

    _ensure_table(bq, table_id)
    pending = _pending_cells(bq, project, dataset, max_calls)
    if not pending:
        _log("no pending cells")
        return {"pending": 0, "resolved": 0}
    _log(f"{len(pending)} pending cells (provider={PROVIDER}, cap={max_calls} calls / {max_seconds}s)")

    rows, failed = [], 0
    t0 = time.time()
    for lat2, lon2, n in pending:
        if time.time() - t0 > max_seconds:
            _log("time budget spent; the rest waits for the next run")
            break
        got = resolver(lat2, lon2)
        if got is None:
            failed += 1
            if failed >= 5 and not rows:
                _log("five consecutive failures and nothing resolved — giving up this run")
                break
        else:
            area, city = got
            rows.append({
                "lat2": lat2, "lon2": lon2,
                "area": area or None, "city": city or None,
                "label": _label(area, city),
                "provider": PROVIDER,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
            })
        time.sleep(gap)

    if rows:
        # Delete first so a google re-resolve replaces rather than duplicates.
        if PROVIDER == "google":
            keys = ", ".join(f"'{r['lat2']:.2f}|{r['lon2']:.2f}'" for r in rows)
            bq.query(f"DELETE FROM `{table_id}` WHERE FORMAT('%.2f|%.2f', lat2, lon2) IN ({keys})").result()
        job = bq.load_table_from_json(
            rows, table_id,
            job_config=bigquery.LoadJobConfig(schema=SCHEMA, write_disposition="WRITE_APPEND"),
        )
        job.result()
        sample = "; ".join(f"{r['lat2']},{r['lon2']} -> {r['label']}" for r in rows[:3])
        _log(f"stored {len(rows)} cells in {time.time() - t0:.0f}s (failed {failed}); e.g. {sample}")
    else:
        _log(f"nothing stored (failed {failed})")
    return {"pending": len(pending), "resolved": len(rows), "failed": failed}


if __name__ == "__main__":
    # Manual run: python geocode_cells.py  (uses ADC like the sync job)
    _project = os.environ.get("VERTEX_PROJECT", "capability-agent-prod")
    _dataset = os.environ.get("VERTEX_DATASET", "Satori_Project")
    print(resolve_new_cells(bigquery.Client(project=_project), _project, _dataset))
