# API Endpoints

All state-changing endpoints require an `Idempotency-Key` header.
Rate-limit tiers: **strict** (5 req/min), **auth** (10 req/min), **standard** (60 req/min), **relaxed** (120 req/min).

## Auth Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| POST | `/auth/register` | public | ✔ | strict | `{email, password, name, role}` | `{user_id, message}` |
| POST | `/auth/login` | public | ✘ | strict | `{email, password}` | `{access_token, refresh_token}` |
| POST | `/auth/refresh` | authenticated | ✘ | auth | `{refresh_token}` | `{access_token, refresh_token}` |
| POST | `/auth/logout` | authenticated | ✘ | auth | `{refresh_token}` | `{message}` |
| POST | `/auth/mfa/setup` | doctor, admin | ✔ | strict | `{}` | `{secret, qr_url, recovery_codes}` |
| POST | `/auth/mfa/verify` | doctor, admin | ✘ | strict | `{totp_code}` | `{access_token, refresh_token}` |
| POST | `/auth/mfa/recovery` | doctor, admin | ✔ | strict | `{recovery_code}` | `{access_token, refresh_token}` |

## Users Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/users/me` | authenticated | ✘ | standard | — | `{user_id, email, name, role, profile}` |
| PATCH | `/users/me` | authenticated | ✔ | standard | `{name?, phone?}` | `{user}` |
| GET | `/users/:id` | admin | ✘ | standard | — | `{user}` |
| GET | `/users` | admin | ✘ | standard | `?page_cursor&limit` | `{users[], next_cursor}` |

## Doctors Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/doctors` | authenticated | ✘ | relaxed | `?specialization&city&page_cursor&limit` | `{doctors[], next_cursor}` |
| GET | `/doctors/:id` | authenticated | ✘ | relaxed | — | `{doctor_profile}` |
| PATCH | `/doctors/me` | doctor | ✔ | standard | `{bio?, specializations?, fee?}` | `{doctor_profile}` |

## Availability Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| POST | `/availability/slots` | doctor | ✔ | standard | `{start_time, end_time, recurrence?}` | `{slot_ids[]}` |
| GET | `/availability/slots` | authenticated | ✘ | relaxed | `?doctor_id&date_from&date_to&status` | `{slots[], next_cursor}` |
| PATCH | `/availability/slots/:id` | doctor | ✔ | standard | `{status: 'BLOCKED'\|'AVAILABLE'}` | `{slot}` |
| DELETE | `/availability/slots/:id` | doctor | ✔ | standard | — | `204 No Content` |

## Consultations Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| POST | `/consultations` | patient | ✔ | standard | `{slot_id, reason}` | `{consultation_id, status, payment_url}` |
| GET | `/consultations` | authenticated | ✘ | standard | `?status&page_cursor&limit` | `{consultations[], next_cursor}` |
| GET | `/consultations/:id` | authenticated (owner/doctor/admin) | ✘ | standard | — | `{consultation}` |
| PATCH | `/consultations/:id/start` | doctor | ✔ | standard | `{}` | `{consultation}` |
| PATCH | `/consultations/:id/complete` | doctor | ✔ | standard | `{notes?}` | `{consultation}` |
| PATCH | `/consultations/:id/cancel` | patient, admin | ✔ | standard | `{reason}` | `{consultation, refund_status}` |

## Prescriptions Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| POST | `/consultations/:id/prescriptions` | doctor | ✔ | standard | `{medications[], diagnosis, notes}` | `{prescription_id}` |
| GET | `/consultations/:id/prescriptions` | doctor, patient (owner) | ✘ | standard | — | `{prescriptions[]}` (decrypted) |
| GET | `/prescriptions/:id` | doctor, patient (owner) | ✘ | standard | — | `{prescription}` (decrypted) |

## Payments Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| POST | `/webhooks/payment` | payment-provider (HMAC) | ✘ (event_id in body is idempotency key) | relaxed | `{event_id, status, payment_id, signature}` | `200 OK` |
| GET | `/payments/:id` | authenticated (owner/admin) | ✘ | standard | — | `{payment}` |

## Search Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/search/doctors` | authenticated | ✘ | relaxed | `?q&specialization&city&available_from&available_to&page_cursor&limit` | `{results[], next_cursor}` (cached) |

## Admin Analytics Module

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/admin/analytics/consultations` | admin | ✘ | standard | `?date_from&date_to&group_by` | `{total, completed, cancelled, revenue, time_series[]}` |
| GET | `/admin/analytics/doctors` | admin | ✘ | standard | `?date_from&date_to&top_n` | `{top_doctors[], avg_rating, utilization}` |
| GET | `/admin/analytics/system` | admin | ✘ | standard | — | `{active_users, queue_depth, error_rate}` |

## Health / Ops

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/health/live` | public | ✘ | — | — | `{status: 'ok'}` |
| GET | `/health/ready` | public | ✘ | — | — | `{db: 'ok', redis: 'ok', queue: 'ok'}` |

## Audit (Internal)

| Method | Path | Roles | Idemp-Key | Rate Limit | Request Summary | Response Summary |
|--------|------|-------|-----------|------------|-----------------|------------------|
| GET | `/admin/audit-logs` | admin | ✘ | standard | `?actor_id&action&resource&date_from&date_to&page_cursor&limit` | `{logs[], next_cursor}` |
