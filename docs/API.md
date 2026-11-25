# Pamarcy Store – REST API Documentation

All endpoints live under `/api/*` and exchange `application/json` (except `/api/uploads` which uses `multipart/form-data` and CSV report exports which return `text/csv`).

## Security & Conventions
- **Authentication**: `HttpOnly`, `SameSite=Lax` (configurable `strict`), `Secure` (in production and over HTTPS), `Path=/`, `Max-Age` + `Expires` cookie `pamarcy_session` backed by HMAC-SHA256 hashed `Session` rows in PostgreSQL. Enforces both absolute TTL (12h staff / 30d customer) and idle timeout (2h staff / 7d customer), periodic & credential-change token rotation, session fixation protection, per-user concurrent session caps, and immediate server-side + cookie invalidation on logout (`POST /api/auth/logout`, supports `{ "all": true }`).
- **CSRF Protection**: All mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`) verify `Sec-Fetch-Site` and `Origin` / `Referer` against the host (except signature-verified webhooks).
- **Rate Limiting & Brute-Force Protection**: Sliding-window multi-tier rate limiter emits `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers (`429 RATE_LIMITED`). Login, registration, password reset, password change, session inspection, and cron authentication endpoints additionally apply safe progressive soft-throttling and temporary escalating cooldowns across IP, canonical identifier (email/`+855` phone), and resolved user ID.
- **Bot Protection & Adaptive CAPTCHA**: Public forms and auth endpoints enforce autofill-safe honeypot traps, server-signed single-use challenge tokens (`GET /api/bot-protection/challenge`), optional Cloudflare Turnstile / hCaptcha server-side `siteverify` verification, and a self-hosted PoW + vector-path SVG math / accessible word-math CAPTCHA engine (supporting both ASCII and Khmer numerals). Clean first-time logins and normal signed-in flows incur zero visible CAPTCHA friction; interactive CAPTCHA activates adaptively on suspicious signals, repeated failures, mass signups, unpaid guest order bursts, or promo-code guessing (`403 CAPTCHA_REQUIRED` / `CAPTCHA_INVALID` / `BOT_BLOCKED`).
- **Error Envelope**:
  ```json
  { "error": { "code": "VALIDATION | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | ...", "message": "Human-readable message", "details": {} } }
  ```

---

## 1. Authentication (`/api/auth/*`)
| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/api/bot-protection/challenge` | Public | Issue signed single-use bot-protection challenge or external Turnstile/hCaptcha site key (`?action=...&mode=auto\|interactive\|accessible`) |
| `POST` | `/api/auth/register` | Public | Register customer (`{ name, email, phone, password }`) |
| `POST` | `/api/auth/login` | Public | Sign in by email or `+855` phone (`{ identifier, password, scope: "customer" \| "admin" }`) |
| `POST` | `/api/auth/logout` | Session | Destroy current session & clear cookie |
| `GET` | `/api/auth/me` | Public | Return current `SessionUser` or `{ user: null }` (rate-limited; cools down repeated invalid session cookies) |
| `POST` | `/api/auth/password-reset/request` | Public | Request password reset link (`{ identifier }`); generic response, 60s resend cooldown + IP/identifier windows |
| `POST` | `/api/auth/password-reset/confirm` | Public | Complete password reset (`{ token, newPassword }`); revokes all sessions, cools down invalid token guesses |

---

## 2. Public Catalogue & Checkout (`/api/*`)
| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET` | `/api/categories` | Public | Active categories with medicine counts |
| `GET` | `/api/products` | Public | Search & filter medicines (`q`, `category`, `brand`, `minPrice`, `maxPrice`, `sort`, `inStock`, `rx`, `page`, `pageSize`) |
| `GET` | `/api/products/:slug` | Public | Product details & live non-expired sellable stock |
| `POST` | `/api/products/:slug/reviews` | Customer | Create/update product rating (`1–5`) & comment |
| `POST` | `/api/cart/quote` | Public | Server-side cart pricing, discount validation, stock check & Cambodia delivery fee |
| `POST` | `/api/orders` | Public / Customer | Create online order, atomically reserve stock via FEFO, return `{ id, number, token }` |
| `GET` | `/api/orders` | Customer | Paginated list of current customer's orders |
| `GET` | `/api/orders/:id` | Owner / Staff / Token | Order details, status timeline & payment views |
| `POST` | `/api/orders/:id/cancel` | Owner Customer | Cancel own unpaid pending order & release reserved stock |
| `GET` | `/api/payment-methods` | Public | Online payment methods & readiness (`KHQR`, `USDT`, `PAYPAL`) |
| `POST` | `/api/orders/:id/pay` | Owner / Token | Initiate payment (`{ method, currency?, network? }`) |
| `GET` | `/api/payments/:id` | Owner / Token | Current payment view & QR data URL |
| `POST` | `/api/payments/:id/check` | Owner / Token | Poll official provider API (Bakong / TronGrid / EVM RPC / PayPal) |
| `POST` | `/api/payments/:id/usdt-hash` | Owner / Token | Submit `{ txHash }` for on-chain USDT verification |
| `POST` | `/api/payments/:id/paypal-capture` | Owner / Token | Server-side PayPal v2 order capture & verification |
| `POST` | `/api/uploads` | Auth / Guest Rx | Validated upload (extension, MIME, deep magic-byte/structure & size <= 5 MB; UUIDv4 storage outside `/public`) |
| `GET` | `/api/files/uploads/:folder/:name` | Public | Serve validated catalogue image (`products`, `categories`, `banners`) with sandbox & `nosniff` headers |
| `GET` | `/api/files/prescriptions/:name` | Owner / Rx Staff / Guest Token | Serve private prescription upload with `prescriptions.review` RBAC, sandbox & `no-store` headers |

---

## 3. Webhooks & Scheduled Maintenance
| Method | Endpoint | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/webhooks/paypal` | PayPal signature | Verifies `verify-webhook-signature` and processes `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*` |
| `GET\|POST` | `/api/cron/maintenance` | `x-cron-secret` / Bearer | Sweeps open payments, expires stale unpaid order reservations, emits expiry alerts, prunes sessions |

---

## 4. Customer Account (`/api/account/*`)
| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `GET\|PATCH` | `/api/account/profile` | Auth | Read / update profile (`name`, `phone`, `locale`) |
| `POST` | `/api/account/password` | Auth | Verify current password, update hash, rotate sessions |
| `GET\|POST` | `/api/account/addresses` | Customer | List / create saved Cambodia addresses |
| `PUT\|DELETE` | `/api/account/addresses/:id` | Customer | Update / delete own address |
| `GET\|POST` | `/api/account/wishlist` | Customer | List wishlist / toggle medicine in wishlist |
| `GET\|POST` | `/api/account/notifications` | Auth | List latest 30 notifications + unread count / mark read |

---

## 5. Admin Dashboard & POS (`/api/admin/*`)
Every endpoint below enforces staff authentication AND the listed RBAC permission on the server.

| Method | Endpoint | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/api/admin/dashboard` | `dashboard.view` | KPIs, daily/monthly/yearly series, best-sellers, payment & stock breakdown |
| `GET` | `/api/admin/medicines` | `medicines.read` | Search/filter medicines with sellable stock |
| `POST` | `/api/admin/medicines` | `medicines.write` | Create medicine (+ optional opening batch) |
| `GET\|PUT` | `/api/admin/medicines/:id` | `medicines.read` / `.write` | Detail (with batches & movements) / update medicine |
| `DELETE` | `/api/admin/medicines/:id` | `medicines.delete` | Soft-delete medicine & free SKU/barcode |
| `GET\|POST` | `/api/admin/categories` | `medicines.read` / `categories.write` | List / create categories |
| `PUT\|DELETE` | `/api/admin/categories/:id` | `categories.write` | Update / delete unused category |
| `GET\|POST` | `/api/admin/brands` | `medicines.read` / `categories.write` | List / create brands |
| `PUT\|DELETE` | `/api/admin/brands/:id` | `categories.write` | Update / delete unused brand |
| `GET` | `/api/admin/inventory` | `inventory.read` | Stock & valuation summary per medicine |
| `GET` | `/api/admin/inventory/batches` | `inventory.read` | Batches for `?medicineId=` |
| `POST` | `/api/admin/inventory/stock-in` | `inventory.write` | Add/top-up batch (`MedicineBatch` + `StockMovement`) |
| `POST` | `/api/admin/inventory/batches/:id` | `inventory.write` | Stock out, cycle-count adjustment, or expired write-off |
| `GET` | `/api/admin/inventory/movements` | `inventory.read` | Paginated stock movement ledger |
| `GET` | `/api/admin/inventory/expiry` | `inventory.read` | Batches grouped by Expired / ≤7d / ≤30d / ≤90d |
| `GET\|POST` | `/api/admin/suppliers` | `suppliers.read` / `.write` | List (with total purchased) / create supplier |
| `GET\|PUT\|DELETE` | `/api/admin/suppliers/:id` | `suppliers.read` / `.write` | Supplier history / update / soft-delete |
| `GET\|POST` | `/api/admin/purchases` | `purchases.read` / `.write` | List / create purchase order (`PO-YYYYMMDD-NNNN`) |
| `GET\|DELETE` | `/api/admin/purchases/:id` | `purchases.read` / `.write` | PO detail / cancel unreceived PO |
| `POST` | `/api/admin/purchases/:id/receive` | `purchases.write` | Receive full or partial stock into FEFO batches |
| `GET` | `/api/admin/orders` | `orders.read` | Filterable orders list + status counts |
| `GET` | `/api/admin/orders/:id` | `orders.read` | Full order, FEFO allocations, payment transactions & timeline |
| `POST` | `/api/admin/orders/:id/status` | `orders.write` / `.cancel` | Advance order status or cancel |
| `POST` | `/api/admin/orders/:id/fulfil` | `orders.write` | Partial or full FEFO stock fulfilment |
| `POST` | `/api/admin/orders/:id/prescription` | `prescriptions.review` | Approve or reject uploaded prescription |
| `POST` | `/api/admin/orders/:id/refund` | `orders.refund` | Refund via PayPal API or record manual refund ref |
| `GET` | `/api/admin/pos/lookup` | `pos.use` | Fast barcode / SKU / name lookup |
| `GET` | `/api/admin/pos/methods` | `pos.use` | Available POS payment methods |
| `POST` | `/api/admin/pos/sale` | `pos.use` | Create POS order + initiate Cash/KHQR/USDT/PayPal |
| `POST` | `/api/admin/pos/cancel` | `pos.use` | Cancel unpaid pending POS sale & release stock |
| `GET` | `/api/admin/payments` | `payments.read` | Unified payments ledger & status summary |
| `POST` | `/api/admin/payments/:id/cash` | `pos.use` | Record cash tendered, settle payment & deduct stock |
| `POST` | `/api/admin/payments/:id/check` | Staff | Force provider verification check |
| `GET\|POST` | `/api/admin/customers` / `PATCH :id` | `customers.read` / `.write` | Customer directory, detail, edit & suspend/activate |
| `GET\|POST\|PUT\|DELETE` | `/api/admin/discounts`, `/api/admin/banners` | `discounts.write` | Promo codes & homepage banners CRUD |
| `GET` | `/api/admin/reports/:type` | `reports.view` | `sales`, `medicine-sales`, `purchases`, `inventory`, `expiry`, `customers`, `profit-loss`, `payments` (`?format=json\|csv`) |
| `GET\|PUT` | `/api/admin/settings/store` | `settings.manage` | Store info, USD/KHR rate, delivery fees |
| `GET\|PUT` | `/api/admin/settings/payments` | `settings.payments` | KHQR, USDT-only networks/wallets/contracts, PayPal, Cash |
| `GET\|POST\|PUT` | `/api/admin/staff` (`/:id`) | `users.manage` | Staff accounts & role assignment |
| `GET` | `/api/admin/audit` | `audit.view` | Paginated audit trail |

## Response Data Policy
- **Allow-lists, not whole rows**: handlers return explicit `select`/mapped shapes (see `src/lib/public-select.ts`); new DB columns never leak by default.
- **Never returned to any client**: password hashes, session tokens/IPs/user-agents, `costPrice`/`unitCost` on customer-facing routes, `cashierId`/`reviewedById`/internal `notes`, customer DOB/gender, payment `qrString`/`payerInfo`/`providerRef`/raw provider payloads.
- **Errors**: 5xx responses are generic (`INTERNAL` / `UNAVAILABLE`); details go to server logs only. Unique-violation errors name only a friendly column (e.g. `email`), never index names. Customer/guest payment views expose a sanitised `failureReason`; staff views keep the raw text.
- **Session**: `GET /api/auth/me` returns `{ id, name, email, role, isStaff, permissions }` (no phone / internal customer id).
- **Diagnostics** (missing env vars, provider setup hints) are visible only to staff with `settings.payments`.
