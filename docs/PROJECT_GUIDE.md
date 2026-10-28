# QueueLess Project Guide

This is the operator guide for the current rebuild. It describes what works, where to access it, how demo credentials/payments behave, and how to verify MongoDB Atlas.

## Quick start

### Docker Compose (recommended)

1. Copy `.env.example` to `.env`.
2. Set `JWT_SECRET` to a fresh random secret of at least 32 characters.
3. Leave `MONGO_URI` blank for the local Docker MongoDB replica set, or set it to your Atlas URI.
4. Run `docker compose up --build` and open `http://localhost:3000`.
5. The API listens on `http://localhost:5000`; API status is at `http://localhost:5000/api/health`.

### Run without Docker

Install Node.js 20+, run MongoDB as a replica set, then run `npm install` and `npm run dev` in `backend/` and `frontend/` in separate terminals. A standalone MongoDB server can serve catalog and scanning but MongoDB transactions used by checkout require a replica set. The included Compose setup configures one for local use.

## Demo accounts

Demo accounts are seeded only when `NODE_ENV` is not `production` and `DEMO_DATA` is not `false`. Passwords are stored as bcrypt hashes. The login window displays these details in demo mode.

| Role | Email | Password | Access |
|---|---|---|---|
| Customer | `demo@example.com` | `password123` | Browse, scan, basket, pay, view own orders |
| Seller | `seller@example.com` | `seller123` | Customer actions plus create products, receive stock, view scan activity |
| Admin | `admin@example.com` | `admin123` | Seller actions plus view all orders and manage customer/seller/admin roles |

These credentials are for local demos only. Production does not seed demo accounts or expose demo payments. Use a unique admin bootstrap account in production through `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` on an empty database, then remove those bootstrap variables.

In development, an invalid/incomplete bootstrap-admin pair is skipped with a warning so it cannot block demo account seeding. In production, an invalid bootstrap pair on an empty database still fails startup. Demo users are created in the configured `MONGO_DB_NAME`; the Atlas URI without an explicit path now defaults to `queueless`, not MongoDB's implicit `test` database.

## Where features are

| UI area | Where | Who can use it |
|---|---|---|
| Product catalog | Home page, **Shop** / `#catalog` | Everyone |
| Barcode scan / manual barcode | Home page, **Start scanning** / `#scanner` | Everyone; signed-in scan identity is recorded |
| Basket and checkout | Home page, `#basket` | Customer, seller, admin |
| Recent orders | Below the catalog after sign-in | Customers see own orders; sellers/admins see store orders and can fulfill paid orders |
| Add a missing barcode/product | Scan a barcode that is not in the catalog while signed in as seller/admin; the product form opens at **Inventory** | Seller/admin |
| Receive stock | Inventory section, **Receive stock** form | Seller/admin |
| Scan history | Inventory section, **Recent activity** | Seller/admin |
| Account role access | **Manage store access** section | Admin only |
| Database/payment status | Admin header and `/api/health` | Admin only in the website; the diagnostic API is public |
| Product images | Product form in Inventory | Seller/admin; stored in Cloudinary after credentials are configured |

Customers see explicit **Out of stock** labels in the catalog and receive an out-of-stock message when scanning that product. The sample Organic Bananas product starts out of stock to demonstrate the state. Staff can receive more stock in Inventory.

## Payments

- **Demo payment** is enabled in non-production when Razorpay keys are absent. It records a demo payment result, does not collect card data, and does not move money. The user can complete a demo order with one click.
- **Razorpay Checkout** is enabled when `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set. Use Razorpay **test** credentials during development. The backend creates the provider order and verifies the payment signature before marking the order paid.
- Production with missing Razorpay keys reports payments as unavailable; demo payment returns 404. Do not use the demo path for a live store.
- Inventory is held for 20 minutes after order creation. Cancelling checkout releases it; an API job releases it automatically when the payment window expires.
- This code does not implement Razorpay webhook reconciliation or refunds. Add and verify those before live payment operations.

## Roles and limits

Registration always creates a customer. Only an admin can change account roles. The API reads the current account role from MongoDB for each authenticated request, so a role change takes effect for existing tokens too.

API authorization boundaries:

- **Customer:** read catalog and scan; place orders; see only own orders.
- **Seller:** customer actions plus create products, receive stock, inspect scan history/store orders, and fulfill paid orders.
- **Admin:** seller actions plus inspect all orders/users and change account roles.
- Public users can read the catalog and scan barcodes, but cannot place orders or change inventory.

Rate limits are applied at two levels: 240 API requests per 15 minutes per source IP, and 12 login/registration attempts per 15 minutes per IP. Per-role route limits are applied per minute per signed-in account (or source IP for guests): product reads are 90 guest / 120 customer / 180 seller / 240 admin; barcode scans are 30 / 120 / 180 / 240; sellers can make 30 inventory changes, 20 scan-history reads, and 30 order-fulfillment changes; admins can make 60 inventory changes, 60 scan-history reads, 30 product deletions, 60 order-fulfillment changes, and 30 account-role changes; order creation is limited to 30 customer / 60 seller / 120 admin requests. Responses include `429` and `Retry-After` when a limit is reached.

The limiter is in-memory and protects a single API process. Multiple production instances need a shared Redis/gateway limiter; see [SECURITY_CHECKLIST.md](../SECURITY_CHECKLIST.md).

## MongoDB Atlas status and setup

Atlas is considered configured when the backend `MONGO_URI` starts with `mongodb+srv://`, and connected only after Mongoose confirms a live connection. The health endpoint reports both separately:

```json
{
  "ok": true,
  "database": "connected",
  "target": "atlas",
  "databaseName": "queueless",
  "demoMode": true,
  "paymentMode": "demo",
  "checkedAt": "..."
}
```

The `target` value will say `atlas` even if the Atlas connection is down; `database` will say `disconnected` and `ok` will be false. The app header reflects the same state. In development the API stays up, shows offline status, and retries the connection every 15 seconds. Production exits on a failed initial DB connection rather than running without storage.

To connect Atlas:

1. Create a dedicated Atlas database user with access only to this app database.
2. Allow-list the backend's public outbound IP in Atlas Network Access.
3. Put the Atlas Node.js URI in the backend environment as `MONGO_URI`. URL-encode reserved characters in the username/password.
4. Confirm `target: "atlas"`, `database: "connected"`, and the expected database name at `/api/health`.
5. Never set the URI as a `NEXT_PUBLIC_*` variable or commit it. Rotate it if it was exposed.

The current workspace `.env` was checked during this update and had no `MONGO_URI`, so it was not connected to Atlas at that point. It will use local MongoDB by default until an Atlas URI is supplied.

## Product images (Cloudinary)

Product records are stored in MongoDB. Product image binaries are uploaded from the seller/admin form through the backend to Cloudinary; MongoDB stores the resulting secure image URL and Cloudinary public ID. The browser never receives the Cloudinary API secret. Uploads accept JPEG, PNG, or WebP up to 5 MB and are content-checked by the API. Camera previews remain local and are never uploaded.

Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` in the backend environment, then restart the API. `/api/health` reports `cloudinaryConfigured`; the admin page shows the readiness state. The current workspace has no Cloudinary credentials, so image uploads are not enabled yet.

## Data stored

- **Users:** name, email, bcrypt password hash, role.
- **Products:** name, description, barcode, category, price, stock, image URL.
- **Scans:** barcode, match status, matched product if any, optional account, timestamp. Scan records expire after 180 days; no camera frame is uploaded or stored.
- **Orders:** product/price snapshot, quantities, customer, payment mode/reference/status, expiry and timestamps. Payment reservations auto-expire after 20 minutes.

## API routes

| Method and route | Access | Purpose |
|---|---|---|
| `GET /api/health` | Public | Database target/connection and demo/payment mode |
| `POST /api/auth/register` | Public, rate-limited | Register customer |
| `POST /api/auth/login` | Public, rate-limited | Login |
| `GET /api/products` | Public | Catalog |
| `GET /api/products/barcode/:barcode` | Public, rate-limited | Lookup and record scan |
| `POST /api/products` | Seller/admin | Add product |
| `PATCH /api/products/:id/stock` | Seller/admin | Receive inventory |
| `DELETE /api/products/:id` | Admin | Delete product if no order references it |
| `GET /api/scans` | Seller/admin | Latest 200 scans |
| `POST /api/orders`, `GET /api/orders` | Signed in | Reserve stock/place order and view authorized orders |
| `PATCH /api/orders/:id/fulfill` | Seller/admin | Fulfill a paid order |
| `GET /api/payments/config` | Public | Reports demo/Razorpay availability |
| `POST /api/payments/demo` | Signed in, non-production only | Simulate successful demo payment |
| `POST /api/payments/razorpay/order` | Signed in | Create Razorpay Checkout order |
| `POST /api/payments/razorpay/verify` | Signed in | Verify provider signature and mark paid |
| `POST /api/payments/cancel` | Signed in | Cancel pending payment and release stock |
| `GET /api/users` | Admin | List store accounts |
| `PATCH /api/users/:id/role` | Admin | Change a user's role |

## Configuration reference

Copy `.env.example` to `.env` and keep it out of version control.

- `MONGO_URI`: blank for Docker's local replica set; Atlas URI to use Atlas.
- `MONGO_DB_NAME`: database name (defaults to `queueless`, including when the Atlas URI omits a path).
- `JWT_SECRET`: unique 32+ character secret.
- `CORS_ORIGINS`: comma-separated frontend origins.
- `DEMO_DATA`: `true` for local demo accounts/catalog; set `false` to disable development seed data.
- `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`: one-time admin creation only when the database has no users; password must be 14+ characters.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`: optional backend-only provider credentials.
- `RECEIPT_TTL_DAYS`: validity window for paid receipt QR codes (default 30 days).
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`: backend-only product image storage credentials.
- `NEXT_PUBLIC_API_URL`: frontend API origin plus `/api`.

## Payment, order, and receipt lifecycle

The backend reserves stock in a MongoDB transaction and calculates totals from current product prices, rounded to cents. `POST /api/orders` requires an `Idempotency-Key`; retries for the same customer return the existing order. In development, `/api/payments/demo` simulates payment without collecting funds. With Razorpay configured, the server verifies the payment signature before the order is marked paid. Only then does the order receive `receiptStatus: valid` and a time-limited QR token. The QR contains an order ID and HMAC token derived from the server JWT secret; it contains no customer data or access token. An authenticated seller/admin redeems it with `POST /api/receipts/:orderId/redeem`. A conditional MongoDB update transitions `valid` to `redeemed` once; repeat or concurrent redemption is rejected. Admins can revoke valid receipts with `POST /api/receipts/:orderId/revoke`. Redemptions, revocations, product edits, account role changes, and activation changes are logged in `AuditLog` and admins can read `/api/admin/audit-logs`. Paid sales totals are available at `/api/admin/reports/sales`.

The staff verification panel supports camera QR scanning through ZXing and manual payload entry. Print uses the browser print dialog and is not a server-rendered PDF invoice. This repo contains Razorpay, not Stripe. Stripe Checkout, Stripe signed webhooks, provider refunds, tax/discount configuration, and payment reconciliation remain unimplemented. Demo payments must never be used to represent real funds.

## Admin boundaries and remaining scope

Every admin/seller operation is enforced by API middleware, not only by hidden UI. Registration creates customers. Admin can list accounts, assign roles, activate/deactivate accounts, list orders, edit products, remove eligible products, inspect sales aggregates, revoke receipts, and inspect audit events. The last active admin cannot be demoted/deactivated through these routes. Sellers can create/edit products, receive stock, upload images, inspect orders and scan history, fulfill paid orders, and redeem receipts. Customers can browse, scan, place orders, and view their own orders/receipts.

This is not yet a complete live-retail admin suite: there is no provider refund workflow, category entity management, seller-to-product tenancy, user creation UI, full audit viewer UI, configurable taxes/discounts, or QR camera decoder. Protect the API with a shared rate-limit store and add webhook reconciliation before production payment operations.

## Checks

Run `docker compose up -d --build`, then `docker compose exec backend npm test`, `docker compose exec backend npm run check`, and `docker compose exec frontend npm run lint`. Run the frontend production build with `docker compose run --rm --no-deps -e NODE_ENV=production frontend npm run build`. The API tests use temporary product/order records for idempotency and concurrent receipt redemption and remove those records when complete.

The API startup applies an additive migration that sets `active: true` only on legacy users whose new `active` field is absent. Existing users, products, scans, and orders are retained. Mongoose creates the unique product barcode and customer/idempotency order indexes; back up MongoDB before deploying schema/index changes to a populated database. The new receipt fields are additive; older paid orders are not automatically given QR receipts.

See [README.md](../README.md) for quick start and [SECURITY_CHECKLIST.md](../SECURITY_CHECKLIST.md) for remaining production hardening.
