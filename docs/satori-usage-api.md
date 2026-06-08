# Satori Usage API — Reference

**Audience:** the TMC monitoring portal and anyone else consuming per-user
activity stats from Satori (priority P7).

**Contract parity:** this endpoint mirrors the shape of Huzaifa's
`tank-usage` Cloud Function so the monitoring portal can poll Tank, Satori,
and any other internal app with identical client code.

---

## Endpoint

```
GET https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage
```

(Once the custom domain is configured, also reachable at
`https://satori.tmcltd.ai/api/satori-usage`.)

## Authentication

Pass a per-consumer API key in the `X-API-Key` request header.

```
X-API-Key: satori_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are issued by the Satori team via `backend/seed_api_key.py` and shared
through 1Password (never email).

| HTTP | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 401  | `X-API-Key` header missing                                 |
| 403  | Key is invalid or has been revoked                         |
| 200  | Authenticated; response is the JSON payload below          |
| 429  | Reserved for future rate limiting — currently not enforced |
| 5xx  | Server error — retry with exponential backoff              |

Every successful call is recorded in Satori's `data_access_log` with
`action='usage.api.read'` and the key name as `resource_id`.

## Query parameters (all optional)

| Param        | Type   | Default | Max | Description                                  |
| ------------ | ------ | ------- | --- | -------------------------------------------- |
| `limit`      | int    | 100     | 500 | Page size                                    |
| `offset`     | int    | 0       | —   | Skip this many rows                          |
| `user_email` | string | —       | —   | Filter to one user; case-insensitive match   |

The default list is sorted **most-recently-active first** (`lastActiveAt`
desc), matching Tank's behaviour.

## Response

```json
{
  "users": [
    {
      "userId": 7,
      "email": "et@tmcltd.ai",
      "fullName": "Tehreem",
      "role": "user",
      "isActive": true,
      "company": "TMC",
      "loginCount": 23,
      "chatSessionCount": 14,
      "voiceSessionCount": 5,
      "reportCount": 3,
      "dashboardCount": 2,
      "totalVoiceDurationSeconds": 0,
      "lastLoginAt":  "2026-06-08T05:30:00Z",
      "lastChatAt":   "2026-06-08T05:45:00Z",
      "lastVoiceAt":  "2026-06-07T14:00:00Z",
      "lastActiveAt": "2026-06-08T05:45:00Z",
      "createdAt":    "2026-05-12T08:30:00Z"
    }
  ],
  "total": 47,
  "limit": 100,
  "offset": 0,
  "hasMore": false,
  "schemaVersion": 1
}
```

### Field reference

| Field                       | Type    | Source / definition                                                                 |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `userId`                    | int     | Satori's internal `users.id`                                                        |
| `email`                     | string  | `users.email`                                                                       |
| `fullName`                  | string  | `users.full_name`                                                                   |
| `role`                      | string  | `users.role` (`user` / `admin` / etc.)                                              |
| `isActive`                  | bool    | `users.is_active` — inactive users are excluded unless filtered by `user_email`     |
| `company`                   | string  | `companies.short_code` (currently always `TMC`)                                     |
| `loginCount`                | int     | `COUNT(login_log WHERE success=1)`                                                  |
| `chatSessionCount`          | int     | `COUNT(chat_conversations)` — distinct saved chats                                  |
| `voiceSessionCount`         | int     | `COUNT(DISTINCT DATE(created_at)) FROM data_access_log WHERE action='ai.voice'`     |
| `reportCount`               | int     | `COUNT(saved_reports)` — reports the user has created                               |
| `dashboardCount`            | int     | `COUNT(saved_dashboards)` — dashboards the user has created                         |
| `totalVoiceDurationSeconds` | int     | Reserved for a future iteration; currently always `0` (see "v2" below)              |
| `lastLoginAt`               | ISO ts  | Most recent successful login                                                        |
| `lastChatAt`                | ISO ts  | `MAX(chat_conversations.updated_at)`                                                |
| `lastVoiceAt`               | ISO ts  | `MAX(data_access_log.created_at WHERE action='ai.voice')`                           |
| `lastActiveAt`              | ISO ts  | The newest of `lastLoginAt`, `lastChatAt`, `lastVoiceAt`, and any other audit event |
| `createdAt`                 | ISO ts  | When the user record was created                                                    |

All timestamps are UTC, ISO-8601 with trailing `Z`.

### Pagination

`hasMore = (offset + len(users)) < total`. To paginate, just bump `offset`
by `limit` until `hasMore` is `false`.

### Schema version

`schemaVersion` will increment whenever a breaking change ships. Today it
is `1`. Adding new fields is additive — schemaVersion does NOT change for
that — so consumers should tolerate unknown fields.

## Sample curl

```bash
# 1) First page (newest active users first)
curl -sS https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage \
     -H "X-API-Key: $SATORI_API_KEY" | jq

# 2) Filter to one user
curl -sS "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage?user_email=et@tmcltd.ai" \
     -H "X-API-Key: $SATORI_API_KEY" | jq

# 3) Page 3 of 50-row pages
curl -sS "https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage?limit=50&offset=100" \
     -H "X-API-Key: $SATORI_API_KEY" | jq

# 4) Watch for 401 / 403 explicitly
curl -isS https://satori-v2-qje7n5jw5a-uc.a.run.app/api/satori-usage \
     -H "X-API-Key: wrong-key" | head -1
# HTTP/2 403
```

## Issuing / managing keys

Run from inside `backend/` (locally, with the same DB env vars as prod):

```bash
# Issue
python seed_api_key.py issue --name monitoring-portal-prod --by et@tmcltd.ai
# -> prints the raw key ONCE. Copy it to 1Password.

# List
python seed_api_key.py list

# Revoke
python seed_api_key.py revoke --name monitoring-portal-prod
```

Only the SHA-256 hash is stored in the database. A DB leak therefore can't
reveal credentials.

## Backfill vs. forward tracking

Counts are computed from Satori's existing tables (`users`, `login_log`,
`chat_conversations`, `saved_reports`, `saved_dashboards`,
`data_access_log`), so historic activity is included automatically — there
is no "start counting from today" cutoff.

## What's not in v1

- **`totalVoiceDurationSeconds`** — Satori currently doesn't track Gemini
  Live session durations server-side; the WebSocket lives in the browser.
  v2 will add a small `/api/voice/session-end` endpoint that the frontend
  pings with the call duration when the modal closes, and this field will
  start reflecting real seconds for new sessions.
- **Rate limiting** — the endpoint is not rate-limited today. The
  monitoring portal should poll at a sane cadence (≤ 1/minute is plenty).
- **Per-resource breakdowns** — we ship aggregate counts only. If the
  portal needs e.g. "which dashboards has user X opened in the last 7d",
  that's a follow-up endpoint, not a column on this one.

## Contact

Owner: TMC AI Practice / Satori team (et@tmcltd.ai).
Questions, schema-change requests, or "the response is missing field X"
issues — message directly.
