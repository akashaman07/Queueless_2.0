# Security and MongoDB Atlas checklist

## Fixed in this change

- [x] Public registration always creates a customer; clients cannot self-assign seller/admin roles.
- [x] Optional first-admin bootstrap requires a configured strong password and runs only for an empty user collection.
- [x] Barcode lookup trims and validates input before querying MongoDB.
- [x] Missing and out-of-stock products are recorded/displayed; seller/admin can add missing barcodes and receive stock.
- [x] Mongo-backed barcode lookups create scan history records with the barcode, match status, product, optional user, and timestamp.
- [x] Catalog scans, orders, inventory edits, scan history, and account-role changes have customer/seller/admin authorization boundaries.
- [x] API, authentication, and per-role request limits return `429` with retry information.
- [x] Checkout reserves stock transactionally, verifies Razorpay signatures, supports development-only simulated payment, and releases expired/cancelled reservations.
- [x] Login validates credentials against the existing bcrypt hash; password length policy is applied at registration, not login.
- [x] Order creation requires a customer-scoped idempotency key and computes totals from database prices using integer cents.
- [x] Paid orders receive time-limited HMAC QR receipts; staff redemption is atomic and one-time, and admins can revoke valid receipts.
- [x] Role, account activation, product edit, receipt redemption, and receipt revocation actions are recorded in MongoDB audit logs.
- [x] Existing user documents receive an additive `active: true` backfill; existing records are not deleted.
- [x] Product create no longer accepts a client supplied image URL; Cloudinary uploads validate size, MIME, and image signature, and replaced/deleted images are cleaned up best-effort.
- [x] Backend tests cover demo logins, login password rules, role boundaries, order idempotency, and concurrent one-time receipt redemption.
- [x] `/api/health` reports whether the configured target is Atlas and whether MongoDB is connected without disclosing the URI.
- [x] Scan records expire automatically after 180 days.
- [x] JSON and form request bodies are limited to 100 KB.
- [x] CORS can be restricted with `CORS_ORIGINS` (comma-separated exact origins).
- [x] Production refuses a missing or short JWT secret.
- [x] Production fails closed when MongoDB is unavailable instead of serving mock data.
- [x] `.env` stays ignored; Atlas credentials belong in environment variables, never frontend code or source control.

## MongoDB Atlas setup

1. Create an Atlas cluster and a dedicated database user with read/write access only to the application's database.
2. In Atlas Network Access, allow only the backend server's outbound IP addresses. Avoid `0.0.0.0/0` for production.
3. Copy the application's **Node.js** connection string and set it as backend `MONGO_URI`. URL-encode special characters in the database username/password.
4. Set a unique random `JWT_SECRET` of at least 32 characters, `NODE_ENV=production`, and `CORS_ORIGINS` to the deployed frontend origin(s).
5. Restart/redeploy the backend and verify `database: connected` and `target: atlas` from `/api/health`. Product data and scan records are stored in the configured Atlas database.
6. Use Atlas backups/point-in-time recovery appropriate to the deployment, and rotate the database password if it was ever committed or exposed.

Example backend environment values (replace placeholders; do not commit them):

```env
NODE_ENV=production
MONGO_URI=mongodb+srv://<db_user>:<encoded_password>@<cluster-host>/buying_queue_solver?retryWrites=true&w=majority
JWT_SECRET=<unique-random-secret-at-least-32-characters>
CORS_ORIGINS=https://your-frontend.example
```

## Remaining security work before production

- [ ] Add a shared-store rate limiter (Redis or gateway) for login, registration, barcode lookup, and payment endpoints. The current app does not have distributed rate limiting.
- [ ] Add email verification, password reset with single-use expiring tokens, and stronger password rules.
- [ ] Review every user/order/payment endpoint for ownership checks and field allow-lists; never trust client-supplied totals, role, owner, or payment status.
- [ ] Prevent mass assignment on product/user/order updates by explicitly selecting writable fields.
- [ ] Validate all IDs, query filters, pagination bounds, and request bodies consistently.
- [ ] Add CSRF defenses if auth moves to cookies; current frontend stores bearer tokens in localStorage, which raises impact from cross-site scripting.
- [x] Audit upload handling verifies actual image content, applies a size limit, and stores images with Cloudinary.
- [ ] Add signed Razorpay webhook reconciliation (or a Stripe integration if Stripe is the intended processor); no Stripe package or webhook endpoint exists in this repository.
- [ ] Implement provider refunds and atomically revoke receipts when a refund succeeds.
- [x] Add browser QR decoding for authenticated staff; manual receipt payload entry remains available as a fallback.
- [ ] Add a full admin audit viewer and receipt/PDF invoice renderer; currently the audit API is available to admins and receipts use browser print.
- [ ] Remove development/demo accounts and mock credentials from production builds; rotate any real credentials that have been shared.
- [ ] Configure TLS, secure headers, secret management, structured redacted logs, dependency updates, backups, and alerting in the hosting platform.
- [ ] Frontend production `npm audit --omit=dev` still reports one high PostCSS advisory and one moderate Next.js advisory; npm only offers Next 16 for these, and the Next 16 build failed during prerender in this app. Reassess the upgrade with a dedicated migration before deployment.
- [x] Add automated API authorization, idempotency, authentication, and concurrent redemption integration tests.
- [ ] Add production integration tests for real payment-provider webhooks/refunds, receipt expiry/revocation, and real camera behavior.

## Notes

Scan history is written when a barcode lookup reaches MongoDB. If MongoDB is disconnected, the API reports an error and the development server retries the connection; it does not pretend the scan was saved. Scan records store no camera image or device fingerprint. Consider a shorter retention period or user notice if scan history is not operationally necessary.
