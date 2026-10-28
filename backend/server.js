require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = Number(process.env.PORT || 5000);
const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/queueless';
const mongoDbName = process.env.MONGO_DB_NAME || (() => { try { return new URL(mongoUri).pathname.replace(/^\/+/, '') || 'queueless'; } catch { return 'queueless'; } })();
mongoose.set('bufferCommands', false);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set a unique JWT_SECRET with at least 32 characters');
if (process.env.NODE_ENV === 'production' && !process.env.MONGO_URI) throw new Error('Set MONGO_URI in production');

const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['customer', 'seller', 'admin'], default: 'customer' },
  active: { type: Boolean, default: true },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true }));

const Product = mongoose.model('Product', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 1000 },
  barcode: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
  category: { type: String, default: 'Other', maxlength: 60 },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, default: 0, min: 0 },
  imageUrl: { type: String, default: '' },
  imagePublicId: { type: String, default: '' },
}, { timestamps: true }));
const StockMovement = mongoose.model('StockMovement', new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  quantityDelta: { type: Number, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 300 },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true }));

const Scan = mongoose.model('Scan', new mongoose.Schema({
  barcode: { type: String, required: true, maxlength: 64, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  found: { type: Boolean, required: true },
}, { timestamps: true }));
Scan.schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

const Order = mongoose.model('Order', new mongoose.Schema({
  idempotencyKey: { type: String, default: null, maxlength: 100 },
  items: [{ product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, name: String, quantity: Number, unitPrice: Number }],
  total: { type: Number, required: true },
  status: { type: String, enum: ['pending_payment', 'placed', 'fulfilled', 'cancelled', 'expired'], default: 'pending_payment' },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded', 'expired'], default: 'pending' },
  paymentMode: { type: String, enum: ['demo', 'razorpay', null], default: null },
  providerOrderId: { type: String, default: null },
  paymentReference: { type: String, default: null },
  receiptStatus: { type: String, enum: ['valid', 'redeemed', 'revoked', 'expired', 'refunded', null], default: null },
  receiptExpiresAt: { type: Date, default: null },
  redeemedAt: { type: Date, default: null },
  redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reservationExpiresAt: { type: Date, default: () => new Date(Date.now() + 20 * 60 * 1000) },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true }));
Order.schema.index({ customer: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

const AuditLog = mongoose.model('AuditLog', new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true, maxlength: 120 },
  targetType: { type: String, required: true, maxlength: 40 },
  targetId: { type: String, required: true, maxlength: 100 },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true }));
AuditLog.schema.index({ createdAt: -1 });

const receiptTokenFor = (orderId) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`receipt:${orderId}`).digest('base64url');
const orderWithReceipt = (order) => {
  const result = order.toObject ? order.toObject() : { ...order };
  if (result.paymentStatus === 'paid' && result.receiptStatus === 'valid' && result.receiptExpiresAt > new Date()) result.receiptToken = receiptTokenFor(result._id);
  return result;
};

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(x => x.trim());
app.use(helmet());
app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// Per-process fixed-window limiting; use a shared store such as Redis when running multiple API instances.
const rateBuckets = new Map();
const limiter = ({ limit, windowMs, scope }) => (req, res, next) => {
  const identity = req.user?.id || req.ip || 'unknown';
  const key = `${scope}:${identity}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.until) { bucket = { count: 0, until: now + windowMs }; rateBuckets.set(key, bucket); }
  bucket.count += 1;
  res.setHeader('RateLimit-Limit', limit);
  res.setHeader('RateLimit-Remaining', Math.max(0, limit - bucket.count));
  res.setHeader('RateLimit-Reset', Math.ceil(bucket.until / 1000));
  if (bucket.count > limit) { res.setHeader('Retry-After', Math.ceil((bucket.until - now) / 1000)); return res.status(429).json({ message: 'Too many requests. Please wait and try again.' }); }
  next();
};
app.use('/api', limiter({ limit: 240, windowMs: 15 * 60 * 1000, scope: 'api' }));
const authLimiter = limiter({ limit: 12, windowMs: 15 * 60 * 1000, scope: 'auth' });
const roleLimiter = (limits = {}) => (req, res, next) => {
  const role = req.user?.role || 'guest';
  return limiter({ limit: limits[role] || limits.default || 60, windowMs: 60 * 1000, scope: `role:${role}` })(req, res, next);
};
setInterval(() => { const now = Date.now(); for (const [key, value] of rateBuckets) if (now >= value.until) rateBuckets.delete(key); }, 60 * 1000).unref();

const auth = async (req, _res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const account = await User.findById(decoded.id).select('role active');
    if (account?.active) req.user = { id: account.id, role: account.role };
  } catch { /* Public endpoints remain public; protected routes check identity. */ }
  next();
};
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ message: 'Sign in required' });
const requireStaff = (req, res, next) => req.user && ['seller', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ message: 'Seller access required' });
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ message: 'Admin access required' });
const signInResponse = (user) => ({ token: jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRE || '7d' }), user: { id: user.id, name: user.name, email: user.email, role: user.role } });

async function seedDevelopmentData() {
  if (process.env.NODE_ENV === 'production' || process.env.DEMO_DATA === 'false') return;
  const demoUsers = [
    { name: 'Demo Customer', email: 'demo@example.com', password: 'password123', role: 'customer' },
    { name: 'Demo Seller', email: 'seller@example.com', password: 'seller123', role: 'seller' },
    { name: 'Demo Admin', email: 'admin@example.com', password: 'admin123', role: 'admin' },
  ];
  for (const account of demoUsers) {
    if (!await User.exists({ email: account.email })) await User.create({ ...account, password: await bcrypt.hash(account.password, 12) });
  }
  if (await Product.countDocuments() === 0) {
    await Product.insertMany([
      { name: 'Smartphone X', description: 'Everyday smartphone', barcode: '123456789012', category: 'Electronics', price: 999.99, stock: 12 },
      { name: 'Wireless Headphones', description: 'Over-ear wireless headphones', barcode: '123456789013', category: 'Electronics', price: 199.99, stock: 18 },
      { name: 'Organic Bananas', description: 'Fresh organic bananas', barcode: '123456789014', category: 'Food', price: 1.99, stock: 0 },
      { name: 'Cotton T-Shirt', description: 'Soft cotton everyday tee', barcode: '123456789015', category: 'Clothing', price: 19.99, stock: 25 },
    ]);
    console.log('Development demo products created.');
  }
  console.log('Development demo accounts are ready.');
}

const razorpayKeysPresent = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = razorpayKeysPresent ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
const cloudinaryConfigured = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(null, true);
    callback(new Error('Choose a JPEG, PNG, or WebP image (maximum 5 MB).'));
  },
});

app.get('/api/health', (_req, res) => {
  const connected = databaseInitialized && mongoose.connection.readyState === 1;
  const atlas = String(process.env.MONGO_URI || '').startsWith('mongodb+srv://');
  res.status(connected ? 200 : 503).json({ ok: connected, database: connected ? 'connected' : 'disconnected', target: atlas ? 'atlas' : 'local-or-self-hosted', databaseName: connected ? mongoose.connection.name : null, cloudinaryConfigured, demoMode: process.env.NODE_ENV !== 'production' && process.env.DEMO_DATA !== 'false', paymentMode: razorpay ? 'razorpay' : process.env.NODE_ENV === 'production' ? 'unavailable' : 'demo', checkedAt: new Date().toISOString() });
});
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10) return res.status(400).json({ message: 'Provide a name, valid email, and password of at least 10 characters' });
    const user = await User.create({ name, email, password: await bcrypt.hash(password, 12), role: 'customer' });
    res.status(201).json(signInResponse(user));
  } catch (err) { if (err.code === 11000) return res.status(409).json({ message: 'Email already registered' }); next(err); }
});
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const user = await User.findOne({ email: String(req.body.email || '').trim().toLowerCase(), active: true }).select('+password');
    if (!user || !await bcrypt.compare(String(req.body.password || ''), user.password)) return res.status(401).json({ message: 'Email or password is incorrect' });
    res.json(signInResponse(user));
  } catch (err) { next(err); }
});
app.get('/api/products', auth, roleLimiter({ guest: 90, customer: 120, seller: 180, admin: 240 }), async (_req, res, next) => {
  try { res.json(await Product.find().sort({ name: 1 }).limit(500)); } catch (err) { next(err); }
});
app.get('/api/products/barcode/:barcode', auth, roleLimiter({ guest: 30, customer: 120, seller: 180, admin: 240 }), async (req, res, next) => {
  try {
    const barcode = String(req.params.barcode || '').trim();
    if (!/^[\w-]{1,64}$/.test(barcode)) return res.status(400).json({ message: 'Invalid barcode' });
    const product = await Product.findOne({ barcode });
    await Scan.create({ barcode, product: product?._id || null, scannedBy: req.user?.id || null, found: Boolean(product) });
    if (!product) return res.status(404).json({ message: 'Product not found', barcode });
    res.json(product);
  } catch (err) { next(err); }
});
app.post('/api/products', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    const { name, description = '', barcode, category = 'Other' } = req.body;
    const price = Number(req.body.price), stock = Number(req.body.stock || 0);
    if (!name || !barcode || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) return res.status(400).json({ message: 'Name, barcode, valid price and whole-number stock are required' });
    res.status(201).json(await Product.create({ name, description, barcode, category, price, stock }));
  } catch (err) { if (err.code === 11000) return res.status(409).json({ message: 'Barcode already exists' }); next(err); }
});
app.post('/api/products/:id/image', auth, roleLimiter({ seller: 20, admin: 30 }), requireUser, requireStaff, (req, res, next) => {
  if (!cloudinaryConfigured) return res.status(503).json({ message: 'Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET to the backend environment.' });
  imageUpload.single('image')(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ message: uploadError.message || 'Image upload failed.' });
    try {
      if (!req.file) return res.status(400).json({ message: 'Choose an image to upload.' });
      const bytes = req.file.buffer;
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const png = bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!jpeg && !png && !webp) return res.status(400).json({ message: 'Image content must be JPEG, PNG, or WebP.' });
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      const previousPublicId = product.imagePublicId;
      const uploaded = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'queueless/products', resource_type: 'image' }, (error, result) => error ? reject(error) : resolve(result)).end(bytes);
      });
      product.imageUrl = uploaded.secure_url;
      product.imagePublicId = uploaded.public_id;
      await product.save();
      if (previousPublicId) cloudinary.uploader.destroy(previousPublicId).catch(error => console.warn(`Old product image cleanup failed: ${error.message}`));
      res.json(product);
    } catch (err) {
      console.error(`Cloudinary product upload failed: ${err.message}`);
      next(new Error('Cloudinary upload failed. Check the backend Cloudinary credentials and try again.'));
    }
  });
});
app.delete('/api/products/:id/image', auth, roleLimiter({ seller: 20, admin: 30 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const previousPublicId = product.imagePublicId;
    product.imageUrl = '';
    product.imagePublicId = '';
    await product.save();
    if (previousPublicId && cloudinaryConfigured) cloudinary.uploader.destroy(previousPublicId).catch(error => console.warn(`Product image cleanup failed: ${error.message}`));
    res.json(product);
  } catch (err) { next(err); }
});
app.patch('/api/products/:id/stock', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  let session;
  try {
    const quantity = Number(req.body.quantity);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 10000) return res.status(400).json({ message: 'Stock adjustment must be a whole number between -10,000 and 10,000 (excluding zero)' });
    if (reason.length < 3 || reason.length > 300) return res.status(400).json({ message: 'Enter a reason between 3 and 300 characters' });
    session = await mongoose.startSession();
    let product;
    await session.withTransaction(async () => {
      product = await Product.findOneAndUpdate({ _id: req.params.id, ...(quantity < 0 ? { stock: { $gte: Math.abs(quantity) } } : {}) }, { $inc: { stock: quantity } }, { new: true, runValidators: true, session });
      if (!product) {
        if (!mongoose.isValidObjectId(req.params.id) || !await Product.exists({ _id: req.params.id }).session(session)) throw Object.assign(new Error('Product not found'), { status: 404 });
        throw Object.assign(new Error('Stock cannot be reduced below zero'), { status: 409 });
      }
      await StockMovement.create([{ product: product._id, quantityDelta: quantity, reason, actor: req.user.id }], { session });
    });
    res.json(product);
  } catch (err) { next(err); }
  finally { if (session) await session.endSession(); }
});
app.get('/api/products/:id/stock-movements', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
    res.json(await StockMovement.find({ product: req.params.id }).populate('actor', 'name email').sort({ createdAt: -1 }).limit(100));
  } catch (err) { next(err); }
});
app.patch('/api/products/:id', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    const fields = ['name', 'description', 'barcode', 'category'];
    const updates = {};
    for (const field of fields) if (req.body[field] !== undefined) updates[field] = String(req.body[field]).trim();
    if (req.body.price !== undefined) {
      const price = Number(req.body.price);
      if (!Number.isFinite(price) || price < 0 || price > 100000000) return res.status(400).json({ message: 'Price must be a valid non-negative amount' });
      updates.price = Math.round(price * 100) / 100;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ message: 'Provide a product field to update' });
    const product = await Product.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'admin') await AuditLog.create({ actor: req.user.id, action: 'product.update', targetType: 'product', targetId: String(product._id), details: { fields: Object.keys(updates) } });
    res.json(product);
  } catch (err) { if (err.code === 11000) return res.status(409).json({ message: 'Barcode already exists' }); next(err); }
});
app.delete('/api/products/:id', auth, roleLimiter({ admin: 20 }), requireUser, requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid product ID' });
    if (await Order.exists({ 'items.product': req.params.id })) return res.status(409).json({ message: 'This product is part of an order and cannot be deleted' });
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    if (product.imagePublicId && cloudinaryConfigured) cloudinary.uploader.destroy(product.imagePublicId).catch(err => console.warn(`Deleted product image cleanup failed: ${err.message}`));
    res.json({ success: true });
  } catch (err) { next(err); }
});
app.get('/api/scans', auth, roleLimiter({ seller: 20, admin: 60 }), requireUser, requireStaff, async (_req, res, next) => {
  try { res.json(await Scan.find().populate('product', 'name barcode').populate('scannedBy', 'name email').sort({ createdAt: -1 }).limit(200)); } catch (err) { next(err); }
});
app.post('/api/orders', auth, roleLimiter({ customer: 30, seller: 60, admin: 120 }), requireUser, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 50) return res.status(400).json({ message: 'Order must contain 1 to 50 items' });
  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (!/^[\w-]{16,100}$/.test(idempotencyKey)) return res.status(400).json({ message: 'A valid Idempotency-Key is required' });
  const existingOrder = await Order.findOne({ customer: req.user.id, idempotencyKey });
  if (existingOrder) return res.status(200).json(existingOrder);
  let session;
  try {
    session = await mongoose.startSession();
    let order;
    await session.withTransaction(async () => {
      const normalized = [];
      let total = 0;
      for (const item of items) {
        const quantity = Number(item.quantity);
        if (!mongoose.isValidObjectId(item.productId)) throw Object.assign(new Error('Invalid product'), { status: 400 });
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw Object.assign(new Error('Invalid quantity'), { status: 400 });
        const product = await Product.findOneAndUpdate({ _id: item.productId, stock: { $gte: quantity } }, { $inc: { stock: -quantity } }, { new: true, session });
        if (!product) throw Object.assign(new Error('Product unavailable or insufficient stock'), { status: 409 });
        normalized.push({ product: product._id, name: product.name, quantity, unitPrice: product.price });
        total += Math.round(product.price * 100) * quantity;
      }
      [order] = await Order.create([{ items: normalized, total: total / 100, customer: req.user.id, idempotencyKey, reservationExpiresAt: new Date(Date.now() + 20 * 60 * 1000) }], { session });
    });
    res.status(201).json(order);
  } catch (err) { if (err.code === 11000) { const duplicate = await Order.findOne({ customer: req.user.id, idempotencyKey }); if (duplicate) return res.status(200).json(duplicate); } console.error(`Order transaction failed: ${err.message}`); res.status(err.status || 500).json({ message: err.status ? err.message : process.env.NODE_ENV === 'production' ? 'Could not place order' : err.message }); }
  finally { if (session) await session.endSession(); }
});
app.get('/api/orders', auth, roleLimiter({ customer: 60, seller: 90, admin: 120 }), requireUser, async (req, res, next) => {
  try { const query = req.user.role === 'customer' ? { customer: req.user.id } : {}; const orders = await Order.find(query).sort({ createdAt: -1 }).limit(100); res.json(orders.map(orderWithReceipt)); } catch (err) { next(err); }
});
app.post('/api/receipts/:orderId/redeem', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ message: 'Invalid receipt' });
    const expected = Buffer.from(receiptTokenFor(req.params.orderId));
    const supplied = Buffer.from(String(req.body.token || ''));
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(404).json({ message: 'Receipt not found' });
    const now = new Date();
    const redeemed = await Order.findOneAndUpdate({ _id: req.params.orderId, paymentStatus: 'paid', receiptStatus: 'valid', receiptExpiresAt: { $gt: now } }, { $set: { receiptStatus: 'redeemed', redeemedAt: now, redeemedBy: req.user.id } }, { new: true });
    if (redeemed) {
      await AuditLog.create({ actor: req.user.id, action: 'receipt.redeem', targetType: 'order', targetId: String(redeemed._id) });
      return res.json({ valid: true, receiptStatus: 'redeemed', order: { _id: redeemed._id, total: redeemed.total, items: redeemed.items, createdAt: redeemed.createdAt } });
    }
    const order = await Order.findById(req.params.orderId).select('paymentStatus receiptStatus receiptExpiresAt');
    if (!order || order.paymentStatus !== 'paid') return res.status(409).json({ message: 'Receipt is not paid' });
    if (order.receiptStatus === 'redeemed') return res.status(409).json({ message: 'Already Redeemed' });
    if (order.receiptStatus !== 'valid') return res.status(409).json({ message: `Receipt is ${order.receiptStatus || 'invalid'}` });
    await Order.updateOne({ _id: req.params.orderId, receiptStatus: 'valid', receiptExpiresAt: { $lte: now } }, { $set: { receiptStatus: 'expired' } });
    return res.status(410).json({ message: 'Receipt expired' });
  } catch (err) { next(err); }
});
app.post('/api/receipts/:orderId/inspect', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(400).json({ message: 'Invalid receipt' });
    const expected = Buffer.from(receiptTokenFor(req.params.orderId));
    const supplied = Buffer.from(String(req.body.token || ''));
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return res.status(404).json({ message: 'Receipt not found' });
    const now = new Date();
    const order = await Order.findById(req.params.orderId).select('items total paymentStatus receiptStatus receiptExpiresAt createdAt');
    if (!order || order.paymentStatus !== 'paid') return res.status(409).json({ message: 'Receipt is not paid' });
    if (order.receiptStatus === 'redeemed') return res.status(409).json({ message: 'Already Redeemed' });
    if (order.receiptStatus !== 'valid') return res.status(409).json({ message: `Receipt is ${order.receiptStatus || 'invalid'}` });
    if (!order.receiptExpiresAt || order.receiptExpiresAt <= now) {
      await Order.updateOne({ _id: order._id, receiptStatus: 'valid' }, { $set: { receiptStatus: 'expired' } });
      return res.status(410).json({ message: 'Receipt expired' });
    }
    res.json({ valid: true, receiptStatus: order.receiptStatus, order: { _id: order._id, total: order.total, items: order.items, createdAt: order.createdAt, receiptExpiresAt: order.receiptExpiresAt } });
  } catch (err) { next(err); }
});
app.post('/api/receipts/:orderId/revoke', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (req, res, next) => {
  try {
    const order = await Order.findOneAndUpdate({ _id: req.params.orderId, paymentStatus: 'paid', receiptStatus: 'valid' }, { $set: { receiptStatus: 'revoked' } }, { new: true });
    if (!order) return res.status(409).json({ message: 'Receipt cannot be revoked in its current state' });
    await AuditLog.create({ actor: req.user.id, action: 'receipt.revoke', targetType: 'order', targetId: String(order._id), details: { reason: String(req.body.reason || '').slice(0, 300) } });
    res.json({ success: true, receiptStatus: order.receiptStatus });
  } catch (err) { next(err); }
});
app.patch('/api/orders/:id/fulfill', auth, roleLimiter({ seller: 30, admin: 60 }), requireUser, requireStaff, async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.paymentStatus !== 'paid' || order.status !== 'placed') return res.status(409).json({ message: 'Only paid, placed orders can be fulfilled' });
    order.status = 'fulfilled'; await order.save(); res.json(order);
  } catch (err) { next(err); }
});
app.get('/api/payments/config', (_req, res) => {
  if (razorpay) return res.json({ mode: 'razorpay', keyId: process.env.RAZORPAY_KEY_ID, currency: 'INR' });
  res.json({ mode: process.env.NODE_ENV === 'production' ? 'unavailable' : 'demo', currency: 'INR' });
});
app.post('/api/payments/demo', auth, roleLimiter({ customer: 20, seller: 20, admin: 40 }), requireUser, async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ message: 'Demo payment is disabled in production' });
  try {
    const order = await Order.findOne({ _id: req.body.orderId, customer: req.user.id });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.paymentStatus === 'paid') return res.json({ success: true, order: orderWithReceipt(order) });
    if (order.status !== 'pending_payment' || order.reservationExpiresAt <= new Date()) return res.status(409).json({ message: 'Payment window expired. Please place the order again.' });
    const paid = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: 'pending', status: 'pending_payment', reservationExpiresAt: { $gt: new Date() } }, { $set: { paymentStatus: 'paid', paymentMode: 'demo', paymentReference: `DEMO-${crypto.randomUUID()}`, status: 'placed', receiptStatus: 'valid', receiptExpiresAt: new Date(Date.now() + Number(process.env.RECEIPT_TTL_DAYS || 30) * 86400000) } }, { new: true });
    if (!paid) return res.status(409).json({ message: 'Order payment is no longer pending' });
    res.json({ success: true, order: orderWithReceipt(paid) });
  } catch (err) { next(err); }
});
app.post('/api/payments/razorpay/order', auth, roleLimiter({ customer: 20, seller: 20, admin: 40 }), requireUser, async (req, res, next) => {
  if (!razorpay) return res.status(503).json({ message: 'Razorpay is not configured. Use demo payment in development.' });
  try {
    const order = await Order.findOne({ _id: req.body.orderId, customer: req.user.id });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.status !== 'pending_payment' || order.reservationExpiresAt <= new Date()) return res.status(409).json({ message: 'Payment window expired. Please place the order again.' });
    if (order.providerOrderId) return res.json({ providerOrderId: order.providerOrderId, amount: Math.round(order.total * 100), currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID });
    const paymentOrder = await razorpay.orders.create({ amount: Math.round(order.total * 100), currency: 'INR', receipt: String(order._id), expire_by: Math.floor(order.reservationExpiresAt.getTime() / 1000), notes: { appOrderId: String(order._id) } });
    order.providerOrderId = paymentOrder.id; order.paymentMode = 'razorpay'; await order.save();
    res.json({ providerOrderId: paymentOrder.id, amount: paymentOrder.amount, currency: paymentOrder.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) { next(err); }
});
app.post('/api/payments/razorpay/verify', auth, roleLimiter({ customer: 20, seller: 20, admin: 40 }), requireUser, async (req, res, next) => {
  if (!razorpayKeysPresent) return res.status(503).json({ message: 'Razorpay is not configured' });
  try {
    const { orderId, razorpay_order_id: providerOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    const order = await Order.findOne({ _id: orderId, customer: req.user.id, providerOrderId });
    if (!order) return res.status(404).json({ message: 'Payment order not found' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${providerOrderId}|${paymentId}`).digest('hex');
    const suppliedBuffer = Buffer.from(String(signature || ''));
    const expectedBuffer = Buffer.from(expected);
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) return res.status(400).json({ message: 'Payment signature is invalid' });
    if (order.paymentStatus === 'paid') return res.json({ success: true, order: orderWithReceipt(order) });
    if (order.status !== 'pending_payment' || order.reservationExpiresAt <= new Date()) return res.status(409).json({ message: 'Payment window expired' });
    const paid = await Order.findOneAndUpdate({ _id: order._id, paymentStatus: 'pending', status: 'pending_payment', reservationExpiresAt: { $gt: new Date() } }, { $set: { paymentStatus: 'paid', paymentMode: 'razorpay', paymentReference: paymentId, status: 'placed', receiptStatus: 'valid', receiptExpiresAt: new Date(Date.now() + Number(process.env.RECEIPT_TTL_DAYS || 30) * 86400000) } }, { new: true });
    if (!paid) return res.status(409).json({ message: 'Order payment is no longer pending' });
    res.json({ success: true, order: orderWithReceipt(paid) });
  } catch (err) { next(err); }
});
app.post('/api/payments/cancel', auth, roleLimiter({ customer: 20, seller: 20, admin: 40 }), requireUser, async (req, res, next) => {
  let session;
  try {
    session = await mongoose.startSession();
    let cancelled;
    await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: req.body.orderId, customer: req.user.id, paymentStatus: 'pending' }).session(session);
      if (!order) return;
      order.status = 'cancelled'; order.paymentStatus = 'failed'; await order.save({ session });
      for (const item of order.items) await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
      cancelled = order;
    });
    if (!cancelled) return res.status(404).json({ message: 'Pending order not found' });
    res.json({ success: true, order: cancelled });
  } catch (err) { next(err); }
  finally { if (session) await session.endSession(); }
});
async function releaseExpiredOrders() {
  const expired = await Order.find({ status: 'pending_payment', paymentStatus: 'pending', reservationExpiresAt: { $lte: new Date() } }).select('_id').limit(50);
  for (const candidate of expired) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const order = await Order.findOneAndUpdate({ _id: candidate._id, status: 'pending_payment', paymentStatus: 'pending' }, { $set: { status: 'expired', paymentStatus: 'expired' } }, { new: true, session });
        if (!order) return;
        for (const item of order.items) await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
      });
    } finally { await session.endSession(); }
  }
}
app.get('/api/users', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (_req, res, next) => {
  try { res.json(await User.find().select('name email role active deletedAt createdAt').sort({ createdAt: -1 }).limit(250)); } catch (err) { next(err); }
});
app.patch('/api/users/:id/role', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (req, res, next) => {
  try {
    if (!['customer', 'seller', 'admin'].includes(req.body.role)) return res.status(400).json({ message: 'Role must be customer, seller, or admin' });
    if (String(req.user.id) === String(req.params.id) && req.body.role !== 'admin') return res.status(400).json({ message: 'You cannot remove your own admin access' });
    const target = await User.findById(req.params.id).select('role');
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.role === 'admin' && req.body.role !== 'admin' && await User.countDocuments({ role: 'admin', active: true }) <= 1) return res.status(409).json({ message: 'The last active admin cannot be demoted' });
    const user = await User.findByIdAndUpdate(req.params.id, { role: req.body.role }, { new: true }).select('name email role');
    if (!user) return res.status(404).json({ message: 'User not found' });
    await AuditLog.create({ actor: req.user.id, action: 'user.role.change', targetType: 'user', targetId: String(user._id), details: { role: user.role } });
    res.json(user);
  } catch (err) { next(err); }
});
app.patch('/api/users/:id/active', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (req, res, next) => {
  try {
    if (typeof req.body.active !== 'boolean') return res.status(400).json({ message: 'active must be true or false' });
    if (String(req.user.id) === String(req.params.id) && !req.body.active) return res.status(400).json({ message: 'You cannot deactivate your own admin account' });
    const target = await User.findById(req.params.id).select('role active');
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.role === 'admin' && target.active && !req.body.active && await User.countDocuments({ role: 'admin', active: true }) <= 1) return res.status(409).json({ message: 'The last active admin cannot be deactivated' });
    target.active = req.body.active; await target.save();
    await AuditLog.create({ actor: req.user.id, action: req.body.active ? 'user.activate' : 'user.deactivate', targetType: 'user', targetId: String(target._id) });
    res.json({ _id: target._id, active: target.active });
  } catch (err) { next(err); }
});
app.delete('/api/users/:id', auth, roleLimiter({ admin: 20 }), requireUser, requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user ID' });
    if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ message: 'You cannot delete your own admin account' });
    const target = await User.findById(req.params.id).select('role active deletedAt');
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.role === 'admin' && target.active && !target.deletedAt && await User.countDocuments({ role: 'admin', active: true, deletedAt: null }) <= 1) return res.status(409).json({ message: 'The last active admin cannot be deleted' });
    target.active = false;
    target.deletedAt = new Date();
    target.deletedBy = req.user.id;
    await target.save();
    await AuditLog.create({ actor: req.user.id, action: 'user.delete', targetType: 'user', targetId: String(target._id), details: { role: target.role } });
    res.json({ success: true, _id: target._id, active: false, deletedAt: target.deletedAt });
  } catch (err) { next(err); }
});
app.get('/api/admin/audit-logs', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (_req, res, next) => {
  try { res.json(await AuditLog.find().populate('actor', 'name email').sort({ createdAt: -1 }).limit(250)); } catch (err) { next(err); }
});
app.get('/api/admin/reports/sales', auth, roleLimiter({ admin: 30 }), requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const [summary] = await Order.aggregate([{ $match: { paymentStatus: 'paid' } }, { $set: { units: { $sum: '$items.quantity' } } }, { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$total' }, units: { $sum: '$units' } } }]);
    res.json({ orders: summary?.orders || 0, revenue: summary?.revenue || 0, units: summary?.units || 0, currency: 'INR' });
  } catch (err) { next(err); }
});
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ message: err.status ? err.message : 'Internal server error' });
});

let reconnecting = false;
let cleanupStarted = false;
let databaseInitialized = false;
async function connectDatabase() {
  try {
    await mongoose.connect(mongoUri, { dbName: mongoDbName, serverSelectionTimeoutMS: 8000 });
    // Safe, additive backfill: existing accounts predate the active flag and remain enabled.
    await User.updateMany({ active: { $exists: false } }, { $set: { active: true } });
    const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
    if ((email || password) && await User.countDocuments() === 0) {
      const validBootstrap = /^\S+@\S+\.\S+$/.test(email) && password.length >= 14;
      if (!validBootstrap && process.env.NODE_ENV === 'production') throw new Error('Bootstrap admin requires a valid email and 14-character password');
      if (!validBootstrap) console.warn('Development bootstrap admin skipped: set a valid email and 14-character password.');
      else {
        await User.create({ name: 'Store Admin', email, password: await bcrypt.hash(password, 12), role: 'admin' });
        console.log('Initial store admin created from environment configuration.');
      }
    }
    await seedDevelopmentData();
    databaseInitialized = true;
    if (!cleanupStarted) {
      cleanupStarted = true;
      setInterval(() => { if (mongoose.connection.readyState === 1) releaseExpiredOrders().catch(err => console.error(`Reservation cleanup failed: ${err.message}`)); }, 60 * 1000).unref();
    }
    return true;
  } catch (err) {
    databaseInitialized = false;
    const target = String(process.env.MONGO_URI || '').startsWith('mongodb+srv://') ? 'Atlas' : 'configured database';
    console.error(`MongoDB connection failed (${target}): ${err.message}`);
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
    return false;
  }
}
async function startServer() {
  const connected = await connectDatabase();
  if (!connected && process.env.NODE_ENV === 'production') process.exit(1);
  const server = app.listen(PORT, () => console.log(`API ready on port ${PORT}; database ${connected ? 'connected' : 'offline'}`));
  if (!connected) setInterval(async () => {
    if (mongoose.connection.readyState === 1 || reconnecting) return;
    reconnecting = true;
    try { if (await connectDatabase()) console.log('Database reconnected.'); }
    finally { reconnecting = false; }
  }, 15000).unref();
  return server;
}
mongoose.connection.on('disconnected', () => console.warn('MongoDB connection lost; reconnect will be attempted.'));
startServer().catch(err => { console.error(`API startup failed: ${err.message}`); process.exit(1); });
