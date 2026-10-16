# Area names on the Attendance Pulse dashboard

**What it does.** Punch coordinates in `Attendance_Data` (strings:
`checkin_latitude/longitude`, `checkout_latitude/longitude`) are turned into
area names — `Paragon City, Lahore (31.5214, 74.4381)` — in the Daily Report,
the per-person punch history, and the hover card on the punch map.

**How.** A lookup table `Satori_Project.Geo_Cells` holds one row per ~1 km
cell (lat/lon rounded to 2 decimals — the same rounding the map already uses):
`lat2, lon2, area, city, label, provider, resolved_at`. The dashboards
`LEFT JOIN` on the rounded coordinates; nothing is geocoded at request time.

**Who fills it.** `pipeline/geocode_cells.py`, called at the end of every
Drive → BigQuery sync (`drive_to_bq.py`, Cloud Run Job, every 30 min). Each
run resolves only cells not yet in the table, heaviest first, capped at 240
calls / 5 minutes so it never crowds the sync. Backlog on 16 Oct 2026: 4,478
cells (check-in + check-out). The first run covers 82 % of all punches, 1,000
cells cover 97 %; the whole backlog clears in about 19 runs (~10 hours). After
that only genuinely new places are resolved.

**Provider.** Default is OpenStreetMap Nominatim: no key, throttled to under
1 request/second with a contact address in the User-Agent (its usage policy),
results are ODbL and may be kept indefinitely with attribution
"© OpenStreetMap contributors". Switch to Google by setting
`GEOCODE_PROVIDER=google` and `MAPS_API_KEY` on the job (Geocoding API enabled
on `capability-agent-prod`); Google's terms limit caching to 30 days, so rows
older than that are re-resolved automatically on that provider.

**Before the table exists / while a cell is pending.** The backend checks for
`Geo_Cells` once every ten minutes (`_pb_geo_cells_available`). Missing table →
the panels print coordinates only, exactly as before. Cell not resolved yet →
`Area pending (31.4864, 74.3657)`. A cell the provider cannot name (open
country) → `Unmapped area (…)`.

**Verified.** Join shape tested against live data (16 Oct 2026): 1,598 rows in
= 1,598 rows out with a duplicated cell in the lookup (the `ANY_VALUE` dedupe
holds), and sample cells resolve to Rehman Villas / Paragon City (Lahore),
Gulshan-e-Iqbal Town (Karachi), Arya Mohallah (Rawalpindi).

**Env on the job.** `GEOCODE_PROVIDER` (nominatim|google), `MAPS_API_KEY`,
`GEOCODE_CONTACT`, `GEOCODE_MAX_CALLS` (240), `GEOCODE_MAX_SECONDS` (300),
`GEOCODE_DISABLED`.

**To go live.** Redeploy the pipeline job (`pipeline/deploy.sh`, or
`gcloud builds submit pipeline … && gcloud run jobs deploy …` as in the
script) and the Satori service. Names appear on the dashboards within ten
minutes of the job's first run, without a restart.
