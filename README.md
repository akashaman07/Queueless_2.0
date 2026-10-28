# QueueLess

QueueLess is a lightweight scan-as-you-shop app. Customers scan products into a basket and place an order; store staff maintain products and inventory. The API stores users, products, scan history, and orders in MongoDB. Orders reserve inventory atomically.

## Stack

- Next.js 15, React 19, TypeScript
- Express 4, Mongoose 7
- MongoDB local or Atlas
- Camera barcode and receipt QR detection using ZXing on localhost/HTTPS, with manual barcode/receipt entry available everywhere

## Run locally

1. Install Node.js 20 or later and MongoDB, or create an Atlas cluster.
2. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters. Set `MONGO_URI` to your local database or Atlas URI.
3. In one terminal run `cd backend; npm install; npm run dev`.
4. In another run `cd frontend; npm install; npm run dev`.
5. Open `http://localhost:3000`.

You can also use Docker Compose. Configure `.env`, then run `docker compose up --build`. Compose uses its local MongoDB container by default. If `MONGO_URI` is set in `.env`, the backend connects to that URI instead; `MONGO_DB_NAME` selects the database and defaults to `queueless`, including for Atlas URIs without a database path.

## Atlas setup

1. Create a cluster and a database user with read/write privileges only on the app database.
2. Add the backend host's public outbound IP to Atlas Network Access. Avoid `0.0.0.0/0` in production.
3. Copy the Node.js connection string from Atlas and set it as `MONGO_URI`, for example:

   ```env
   MONGO_URI=mongodb+srv://<user>:<url-encoded-password>@<cluster-host>/queueless?retryWrites=true&w=majority
   ```

4. Keep credentials in backend environment variables. Do not add them to `NEXT_PUBLIC_*`, frontend code, or source control. Restart the API and check `GET /api/health` for `database: connected`.

## Roles and inventory

Registration creates customer accounts only. Demo customer, seller and admin credentials are available in development. To initialize a production admin, set `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 14 characters before the first API start. See the [project guide](docs/PROJECT_GUIDE.md) for roles, payments, demo access, API paths, and all setup steps.

### Development demo accounts

Only seeded when `NODE_ENV` is not `production` and `DEMO_DATA` is not `false`. Passwords are bcrypt-hashed in MongoDB. Login checks the supplied password against its hash; the 10-character rule applies to new account registration, not login.

| Role | Email | Development password |
|---|---|---|
| Customer | `demo@example.com` | `password123` |
| Seller | `seller@example.com` | `seller123` |
| Admin | `admin@example.com` | `admin123` |

These seeded accounts are intentionally local-demo credentials. Never enable demo seeding in production.

## API overview

- `GET /api/health`
- `POST /api/auth/register`, `POST /api/auth/login`
- `GET /api/products`, `POST /api/products`, `PATCH /api/products/:id/stock` (seller/admin)
- `GET /api/products/barcode/:barcode` (records each Mongo-backed scan)
- `DELETE /api/products/:id` (admin; only products not referenced by orders)
- `GET /api/scans` (seller/admin scan history)
- `POST /api/orders`, `GET /api/orders` (signed in)
- `PATCH /api/orders/:id/fulfill` (seller/admin)
- `POST /api/receipts/:orderId/redeem` (seller/admin, one-time atomic redemption)
- `POST /api/receipts/:orderId/revoke` (admin)
- `GET /api/admin/reports/sales`, `GET /api/admin/audit-logs` (admin)
- `GET /api/payments/config`, `POST /api/payments/demo` (development only)
- `POST /api/payments/razorpay/order`, `POST /api/payments/razorpay/verify` (Razorpay)
- `GET /api/users`, `PATCH /api/users/:id/role` (admin)

Scan records include the barcode, match status, matched product, optional account, and timestamp. They expire after 180 days. Camera frames are never stored. Checkout uses MongoDB transactions, so it requires a replica set; Atlas supports this. Local development should use a replica-set-enabled MongoDB if you want to test checkout.

## Payments and digital receipts

The repository integrates Razorpay, not Stripe. Without Razorpay credentials in development, checkout uses a simulated payment and collects no card details or money. Configure Razorpay test keys for provider checkout. The backend verifies Razorpay's payment signature before marking the order paid. Production disables demo payment.

After backend-confirmed payment, the order receives a 30-day valid receipt by default (`RECEIPT_TTL_DAYS`). The authenticated customer order history displays a printable receipt and QR code. An authorized seller/admin can scan it with the in-app camera; the backend atomically redeems it once. Subsequent scans are rejected. Audit events record redemptions, revocations, product edits, and account changes. This is a development implementation; it does not include Stripe, Razorpay webhooks, provider refunds, tax/discount configuration, or a full PDF invoice renderer. See [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) before live payments.
# Recent inventory and receipt workflow updates

- Staff can inspect receipt QR payloads without consuming them. The inspection endpoint verifies the signed token, paid state, and expiry; only the explicit **Confirm redemption** action redeems the receipt. Redemption remains atomic, one-time, and audited.
- Seller/admin stock adjustments accept positive or negative whole-number deltas and require a reason. Decreases cannot take inventory below zero. Each movement is saved with the actor and timestamp in `stockmovements`; staff can read per-product history through `GET /api/products/:id/stock-movements`.
- Product images remain separate from barcode values. Staff can preview the current Cloudinary image, replace it, or remove it while retaining the product and barcode.
- Admin account deletion is a soft delete: access is disabled and deletion is audited while orders and other historical records remain. The current admin cannot delete themself or the last active admin.
- The integration-test cleanup now uses `MONGO_DB_NAME` when the Atlas URI omits its database path, so smoke products and their demo orders are removed from the intended database.
- Seller/admin product creation, editing, stock updates, and image upload now live together at `/inventory`; the storefront links there instead of showing a second set of product/media forms. Editing the **Price** field sends a staff-authenticated `PATCH /api/products/:id` request, updates MongoDB, and refreshes the catalog/order pricing source. A photo selected in the same form uploads to Cloudinary after the product details save.

Apply these changes without dropping collections. Mongoose creates the new `stockmovements` collection/index automatically after the backend connects. No existing product, order, or user records were migrated or deleted. The only data removed during this update was the exact `Temporary smoke item` with a `SMOKE-` barcode and its associated demo order/redemption audit row, created by the integration test.

