# Satori (P7) — Usage API Reference

Read-only, machine-to-machine endpoint that exposes **per-user activity stats**
for the TMC monitoring portal. It mirrors the contract of the existing
`tank-usage` endpoint so the portal can poll all internal apps with near-identical
client code.

---

## Endpoint

```
GET https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage
```

## Authentication

Send the API key in the `X-API-Key` request header:

```
X-API-Key: <your-key>
```

> The key is delivered separately via a secure channel (1Password / one-time-secret),
> **not** by email. Ping us on Teams to receive it.

## Query parameters (all optional)

| Param        | Type   | Default | Notes                                            |
|--------------|--------|---------|--------------------------------------------------|
| `limit`      | int    | `100`   | Max `500`. Page size.                            |
| `offset`     | int    | `0`     | Pagination offset.                               |
| `user_email` | string | —       | Filter to a single user (case-insensitive email).|

Results are sorted by **`lastActiveAt` descending** (most-recently-active users first).

---

## Response shape

```json
{
  "users": [
    {
      "userId": 12,
      "email": "mahad.laeeque@tmcltd.com",
      "fullName": "Mahad Laeeque",
      "role": "admin",
      "isActive": true,
      "company": "tmc",
      "loginCount": 47,
      "chatSessionCount": 31,
      "voiceSessionCount": 4,
      "reportCount": 6,
      "dashboardCount": 9,
      "totalVoiceDurationSeconds": 0,
      "lastLoginAt": "2026-06-08T09:14:02Z",
      "lastChatAt": "2026-06-08T09:41:55Z",
      "lastVoiceAt": "2026-06-05T15:22:10Z",
      "lastActiveAt": "2026-06-08T09:41:55Z",
      "createdAt": "2026-02-11T07:03:44Z"
    }
  ],
  "total": 128,
  "limit": 100,
  "offset": 0,
  "hasMore": true,
  "schemaVersion": 1
}
```

### Top-level fields

| Field           | Type    | Description                                      |
|-----------------|---------|--------------------------------------------------|
| `users`         | array   | Page of user activity objects (see below).       |
| `total`         | int     | Total users matching the query (ignores paging). |
| `limit`         | int     | Echo of the applied page size.                   |
| `offset`        | int     | Echo of the applied offset.                      |
| `hasMore`       | bool    | `true` if more pages remain after this one.      |
| `schemaVersion` | int     | Response schema version (currently `1`).         |

### Per-user fields

| Field                       | Type           | Description                                                                 |
|-----------------------------|----------------|-----------------------------------------------------------------------------|
| `userId`                    | int            | Internal Satori user id.                                                    |
| `email`                     | string         | User email (login identity).                                                |
| `fullName`                  | string         | Display name.                                                               |
| `role`                      | string         | `admin` or `user`.                                                          |
| `isActive`                  | bool           | Whether the account is active.                                              |
| `company`                   | string         | Company short-code (e.g. `tmc`).                                            |
| `loginCount`                | int            | Successful logins (all time).                                               |
| `chatSessionCount`          | int            | Number of "Ask Me Anything" chat conversations started.                    |
| `voiceSessionCount`         | int            | Distinct days the user used the voice agent.                               |
| `reportCount`               | int            | Reports the user has saved.                                                 |
| `dashboardCount`            | int            | Dashboards the user has saved.                                              |
| `totalVoiceDurationSeconds` | int            | Reserved; `0` in v1 (voice duration not yet tracked server-side).           |
| `lastLoginAt`               | ISO-8601 / null| Most recent successful login.                                               |
| `lastChatAt`                | ISO-8601 / null| Most recent chat activity.                                                  |
| `lastVoiceAt`               | ISO-8601 / null| Most recent voice activity.                                                 |
| `lastActiveAt`              | ISO-8601 / null| Max of all activity timestamps (use this for "last active").                |
| `createdAt`                 | ISO-8601 / null| Account creation time.                                                       |

All timestamps are UTC ISO-8601 with a trailing `Z`. Fields that have no
activity yet are `null`.

---

## Error responses

| HTTP | When                                   | Body                                            |
|------|----------------------------------------|-------------------------------------------------|
| 401  | `X-API-Key` header missing             | `{"detail": "Missing X-API-Key header"}`        |
| 403  | Key not found                          | `{"detail": "Invalid API key"}`                 |
| 403  | Key revoked                            | `{"detail": "API key has been revoked"}`        |

---

## Sample calls

**1. First page (default 100):**
```bash
curl -s "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage" \
  -H "X-API-Key: $SATORI_KEY"
```

**2. Page 2, 50 per page:**
```bash
curl -s "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage?limit=50&offset=50" \
  -H "X-API-Key: $SATORI_KEY"
```

**3. One user:**
```bash
curl -s "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage?user_email=mahad.laeeque@tmcltd.com" \
  -H "X-API-Key: $SATORI_KEY"
```

**4. Iterate all pages (bash):**
```bash
offset=0
while :; do
  resp=$(curl -s "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage?limit=500&offset=$offset" -H "X-API-Key: $SATORI_KEY")
  echo "$resp" | jq '.users[]'
  [ "$(echo "$resp" | jq -r '.hasMore')" = "true" ] || break
  offset=$((offset+500))
done
```

---

## Notes

- The endpoint is **live in production** and ready to integrate.
- Metrics are derived from Satori's existing tables, so historic activity is
  included automatically — no warm-up period.
- `totalVoiceDurationSeconds` is reserved for a future version; it returns `0`
  today. If the portal needs additional fields (e.g. per-feature counts, voice
  duration, active-days), let us know and we'll extend the v1 schema.
- If you see anything unexpected in the response shape or field naming, message
  us and we'll iterate quickly.
