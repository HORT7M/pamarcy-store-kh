# Pamarcy Store – Pharmacy Management & E-Commerce System (Cambodia)

**Pamarcy Store** (`ផាម៉ាស៊ី ស្តូរ`) is a complete, production-ready Pharmacy Store Management System and E-Commerce web application built specifically for pharmacies operating in Cambodia.

It delivers two real-time connected platforms backed by a single normalized PostgreSQL database:
1. **Customer Website (Storefront)** – Khmer (default) & English e-commerce pharmacy with Cambodia-native checkout (25 provinces & districts, `+855` phone validation, USD & KHR pricing, prescription upload, order tracking, wishlist, address book, printable invoices).
2. **Admin Dashboard & POS (Backend)** – Role-based pharmacy console with interactive analytics, FEFO batch & expiration management, prescription review, order & partial fulfilment management, supplier & purchase order receiving, barcode-ready Point of Sale (POS), CSV/PDF reporting, and full audit trail.

All product, category, and banner images are **real photographs** sourced from Wikimedia Commons with full licence attributions in `/credits` (`public/images/CREDITS.json`) — zero AI-generated imagery is used.

---

## 1. Technology Stack

- **Framework**: Next.js 15 (App Router, Server & Client Components, REST API Route Handlers)
- **Language**: TypeScript (strict)
- **Database**: PostgreSQL + Prisma 6 ORM (`SELECT … FOR UPDATE` row locking for stock & payment safety)
- **Styling & UI**: Tailwind CSS v4 + shadcn/ui (Radix UI primitives) + Lucide React icons
- **Typography**: Local `@fontsource/noto-sans-khmer` + `@fontsource-variable/inter`
- **Charts & Exports**: Recharts 3 + CSV + PDF (`jspdf` & `jspdf-autotable`)
- **Authentication**: HttpOnly secure session cookies (`SHA-256` hashed tokens in DB, `bcryptjs` cost 12, RBAC permissions enforced server-side, origin CSRF guard, rate limiting)
- **Storage**: Cloudinary (authenticated delivery for prescriptions) with local filesystem fallback in development
- **Payments**:
  - **KHQR / Bakong** (`bakong-khqr` EMVCo generator + NBC Bakong Open API `/v1/check_transaction_by_md5`)
  - **USDT Only** (on-chain verification via TronGrid for TRC-20 and JSON-RPC `eth_getTransactionReceipt` for ERC-20, BEP-20, Polygon; checks tx hash, recipient wallet, token contract, chain ID, exact amount, block timestamp, confirmations, and `UsedTransactionHash` anti-replay)
  - **PayPal Checkout** (PayPal Orders v2 REST API server-side create/capture/refund + `/v1/notifications/verify-webhook-signature`)

---

## 2. Quick Start & Installation

### Prerequisites
- Node.js `>= 20` and `npm`
- PostgreSQL `>= 14` (or use the included zero-sudo local PostgreSQL runner `npm run db:start`)

### Step-by-Step Setup

```bash
cd pamarcy-store

# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# Edit .env to set DATABASE_URL, AUTH_SECRET, CRON_SECRET, and optional payment/storage keys

# 3. Start PostgreSQL (skip if using your own PostgreSQL / Docker / Neon / Supabase)
npm run db:start &

# 4. Run Prisma database migrations
npm run db:migrate

# 5. Seed roles, staff, customers, 45 real-photo medicines, suppliers, batches & POS history
npm run db:seed

# 6. Start the application
npm run dev
```

Open:
- **Customer Storefront**: `http://localhost:3000`
- **Admin Dashboard**: `http://localhost:3000/admin` (redirects to `/admin/login`)

---

## 3. Seeded Development Accounts

| Role | Email | Password Env Var (`.env`) | Key Permissions |
| --- | --- | --- | --- |
| **Super Admin** | `superadmin@pamarcy.com.kh` | `SEED_SUPERADMIN_PASSWORD` | Full access incl. payment gateways & staff management |
| **Admin** | `admin@pamarcy.com.kh` | `SEED_STAFF_PASSWORD` | Pharmacy operations, catalogue, inventory, orders, reports |
| **Pharmacist** | `pharmacist@pamarcy.com.kh` | `SEED_STAFF_PASSWORD` | Medicines, prescription review (`Rx`), orders, POS |
| **Cashier** | `cashier@pamarcy.com.kh` | `SEED_STAFF_PASSWORD` | POS counter sales (OTC), orders & payments view |
| **Inventory Staff** | `inventory@pamarcy.com.kh` | `SEED_STAFF_PASSWORD` | Stock in/out/adjust, expiry watch, suppliers, purchases |
| **Customer** | `sokha@example.com` | `SEED_CUSTOMER_PASSWORD` | Storefront shopping, addresses, wishlist, order tracking |

 Seeded promo codes: `WELCOME10` (10% off, max $5, min $10) and `KHMERNEWYEAR` ($3 off over $25).

---

## 4. Configuring Real Payment Providers

No payment method ever simulates or fakes payment success. Orders are marked `PAID` **only** after backend verification against the official provider API or blockchain.

### A. KHQR / Bakong (Cambodia)
1. Register a merchant developer token at [NBC Bakong Open API](https://api-bakong.nbc.gov.kh).
2. Set `BAKONG_API_TOKEN` (and optionally `BAKONG_ACCOUNT_ID`) in `.env`.
3. In **Admin → Settings → Payment Gateways**, set your Bakong Account ID (e.g. `pamarcy@aclb`), merchant name, city, and enabled currencies (`USD` / `KHR`).

### B. USDT Cryptocurrency (USDT Only)
1. Set `TRONGRID_API_KEY` in `.env` for TRC-20 (and/or `ETHEREUM_RPC_URL`, `BSC_RPC_URL`, `POLYGON_RPC_URL` for EVM chains).
2. In **Admin → Settings → Payment Gateways**, enable only the USDT networks you wish to accept, enter your receiving wallet address, verify the official Tether USDT contract address, and set required confirmations & expiration minutes.

### C. PayPal Checkout
1. Create a Sandbox (dev) or Live (prod) app in the [PayPal Developer Dashboard](https://developer.paypal.com).
2. Set `PAYPAL_ENV` (`sandbox` or `live`), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` (webhook URL: `https://<your-domain>/api/webhooks/paypal`).

---

## 5. Scripts, Cron & Database Backups

| Command | Description |
| --- | --- |
| `npm run dev` | Start Next.js development server |
| `npm run build` | Generate Prisma Client and build production bundle |
| `npm run start` | Start production server |
| `npm run typecheck` | Run TypeScript compiler checks (`tsc --noEmit`) |
| `npm test` | Run automated test suite (localization, RBAC, KHQR, USDT, FEFO, API security) |
| `npm run db:start` | Run embedded PostgreSQL server locally (`.pgdata`, port `5433`) |
| `npm run db:migrate` | Apply Prisma migrations in development |
| `npm run db:deploy` | Apply Prisma migrations in production |
| `npm run db:seed` | Seed roles, catalogue, batches, and historical POS sales |
| `npm run db:backup` | Create a compressed backup in `./backups` (`pg_dump` or portable JSON.gz) |
| `npm run cron` | Trigger `/api/cron/maintenance` (sweeps open payments, expires stale reservations, creates expiry notifications) |
| `npm run images:fetch` | Re-download real Wikimedia Commons photos & update `public/images/CREDITS.json` |

---

## 6. Deployment (Vercel / Node)

1. Provision a managed PostgreSQL database (Neon, Supabase, RDS, Railway) and Cloudinary account.
2. Set all required environment variables from `.env.example` in your hosting dashboard (`DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `APP_URL`, Cloudinary & payment credentials).
3. Set build command to `npm run db:deploy && npm run build`.
4. `vercel.json` automatically schedules `/api/cron/maintenance` every 5 minutes (authenticated via `CRON_SECRET`).
