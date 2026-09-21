# API Contract

Base path: `/api`. All endpoints except `/health` and `/auth/*` require an
authenticated session (httpOnly cookie).

## Response envelope

Success responses return the resource directly (object or `{ items, nextCursor }`
for paginated lists). Errors return `{ "error": "<message>" }` with a 4xx/5xx
status. Error messages are generic on 5xx (no internal detail leaked).

## `GET /api/health`
No auth required. `{ status: "ok" | "degraded", dbConnected: boolean, uptimeSeconds: number }`

## `POST /api/auth/login`
Body: `{ username, password }`. `200 { authenticated: true, username }` or
`401 { error }`. Rate-limited (20 req / 15 min).

## `POST /api/auth/logout`
`200 { ok: true }`.

## `GET /api/auth/session`
`200 { authenticated: true, username }` or `401 { authenticated: false }`.

## `GET /api/sources`
Returns all sources with a computed `item_count`.

## `GET /api/sources/:id`
Single source, `404` if not found.

## `GET /api/items`
Query params (all optional, all applied as SQL `WHERE` clauses — never
fetched-all-then-filtered client-side):

| Param | Type | Meaning |
|---|---|---|
| `source` | uuid | `sources.id` |
| `status` | string | `raw_items.status` |
| `from` / `to` | ISO date | `telegram_date` range |
| `cursor` | integer | `raw_items.id` cursor for pagination (descending) |
| `limit` | integer, 1–100, default 50 | page size |

Response: `{ items: [...], nextCursor: number | null }`. Each item includes
`source_id`, `channel_username`, `display_name`, `telegram_message_id`,
`telegram_date`, `collected_at`, `raw_text`, `has_media`, `status`.

## `GET /api/items/:id`
Full item detail including `raw_metadata`. `404` if not found.

## Status values

`raw_items.status`: `new`, `translating`, `translated`, `failed_translation`,
`tagging`, `ready`, `failed_tagging` — see `docs/DATABASE.md`.

## Endpoints added in later phases

`GET /api/activity`, `GET /api/subsystems` — documented here once their
backing tables (`subsystem_status`) exist (Phase 4).
