const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const app = express();

// ── Load .env ───────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const PORT = process.env.PORT || 4180;
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));

// ── Twilio (optional) ───────────────────────────────────────────────────────
let twilioClient = null;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;

if (TWILIO_SID && TWILIO_TOKEN) {
  try {
    twilioClient = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
    console.log('✓ Twilio initialized');
  } catch (e) {
    console.log('⚠ Twilio not available, using local OTPs');
  }
}

// ── File Uploads ────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype));
  }
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

// Clean URL routes (before static)
app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'public/map.html')));
app.get('/profile/:id?', (req, res) => res.sendFile(path.join(__dirname, 'public/profile.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public/terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/privacy.html')));

app.use(express.static(path.join(__dirname, 'public')));

// ── Data Persistence ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData(name, fallback) {
  const p = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(p)) { saveData(name, fallback); return JSON.parse(JSON.stringify(fallback)); }
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { saveData(name, fallback); return JSON.parse(JSON.stringify(fallback)); }
}

function saveData(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

let users = loadData('users', { users: [] });
let otps = loadData('otps', { otps: [] });
let elements = loadData('elements', { elements: [] });
let messages = loadData('messages', { messages: [] });
let products = loadData('products', { products: [] });
let orders = loadData('orders', { orders: [] });

// ── Phone Normalization ─────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.replace(/[\s\-\(\)\.]/g, '');
  if (/^\d{10}$/.test(p)) p = '+1' + p;
  else if (/^1\d{10}$/.test(p)) p = '+' + p;
  else if (!p.startsWith('+')) p = '+' + p;
  return /^\+\d{10,15}$/.test(p) ? p : null;
}

// ── OTP System ──────────────────────────────────────────────────────────────
const TEST_PHONES = { '+15555555555': '555555', '+11111111111': '111111' };

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtp(phone) {
  if (TEST_PHONES[phone]) {
    otps.otps = otps.otps.filter(o => o.phone !== phone);
    otps.otps.push({ phone, code: TEST_PHONES[phone], expiresAt: new Date(Date.now() + 600000).toISOString() });
    saveData('otps', otps);
    return { ok: true, test: true };
  }

  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
      return { ok: true };
    } catch (e) {
      console.error('Twilio error:', e.message);
    }
  }

  const code = generateOtp();
  otps.otps = otps.otps.filter(o => o.phone !== phone);
  otps.otps.push({ phone, code, expiresAt: new Date(Date.now() + 600000).toISOString() });
  saveData('otps', otps);
  console.log(`\n  📱 OTP for ${phone}: ${code}\n`);
  return { ok: true, local: true, code };
}

async function verifyOtp(phone, code) {
  if (TEST_PHONES[phone]) return code === TEST_PHONES[phone];

  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verificationChecks.create({ to: phone, code });
      if (check.status === 'approved') return true;
    } catch (e) { /* fall through */ }
  }

  const otp = otps.otps.find(o => o.phone === phone && o.code === code && new Date(o.expiresAt) > new Date());
  if (otp) {
    otps.otps = otps.otps.filter(o => o.phone !== phone);
    saveData('otps', otps);
    return true;
  }
  return false;
}

// ── Sessions ────────────────────────────────────────────────────────────────
const SESSION_DAYS = 30;

function createSession(user) {
  const token = 'sess_' + crypto.randomBytes(24).toString('hex');
  const session = { token, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() };
  if (!user.sessions) user.sessions = [];
  user.sessions = user.sessions.filter(s => new Date(s.expiresAt) > new Date());
  user.sessions.push(session);
  saveData('users', users);
  return token;
}

function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('mf_session='));
  if (!cookie) return null;
  const token = cookie.split('=')[1].trim();
  for (const user of users.users) {
    const session = (user.sessions || []).find(s => s.token === token && new Date(s.expiresAt) > new Date());
    if (session) return user;
  }
  return null;
}

function setSessionCookie(res, token) {
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toUTCString();
  res.setHeader('Set-Cookie', `mf_session=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mf_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
}

// ── Rate Limiting ───────────────────────────────────────────────────────────
const rateBuckets = {};

function rateLimit(key, ip, max, windowMs) {
  const k = `${key}:${ip}`;
  const now = Date.now();
  if (!rateBuckets[k]) rateBuckets[k] = [];
  rateBuckets[k] = rateBuckets[k].filter(t => now - t < windowMs);
  if (rateBuckets[k].length >= max) return false;
  rateBuckets[k].push(now);
  return true;
}

function makeUser(fields) {
  return {
    id: 'user_' + crypto.randomBytes(8).toString('hex'),
    name: fields.name || '',
    email: fields.email || null,
    phone: fields.phone || null,
    googleId: fields.googleId || null,
    phoneVerified: fields.phoneVerified || false,
    profile: { displayName: '', bio: '', photos: [], location: null },
    sessions: [],
    createdAt: new Date().toISOString(),
    ...fields
  };
}

// Pending phone verifications
const pendingVerifications = {};

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/auth/start — send OTP
app.post('/api/auth/start', async (req, res) => {
  if (!rateLimit('auth-start', req.ip, 5, 900000))
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });

  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Invalid phone number.' });

  const existing = users.users.find(u => u.phone === phone);
  const result = await sendOtp(phone);

  if (result.ok) {
    res.json({ ok: true, exists: !!existing, ...(result.local ? { devCode: result.code } : {}) });
  } else {
    res.status(500).json({ ok: false, error: 'Failed to send code.' });
  }
});

// POST /api/auth/verify — verify OTP
app.post('/api/auth/verify', async (req, res) => {
  if (!rateLimit('auth-verify', req.ip, 10, 900000))
    return res.status(429).json({ ok: false, error: 'Too many attempts.' });

  const phone = normalizePhone(req.body.phone);
  const code = (req.body.code || '').trim();
  if (!phone || !code) return res.status(400).json({ ok: false, error: 'Phone and code required.' });

  const valid = await verifyOtp(phone, code);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid or expired code.' });

  const existing = users.users.find(u => u.phone === phone);
  if (existing) {
    const token = createSession(existing);
    setSessionCookie(res, token);
    return res.json({ ok: true, user: { id: existing.id, name: existing.name, phone: existing.phone } });
  }

  pendingVerifications[phone] = { verifiedAt: Date.now() };
  res.json({ ok: true, needsName: true });
});

// POST /api/auth/complete — finish registration
app.post('/api/auth/complete', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = (req.body.name || '').trim();
  if (!phone || !name) return res.status(400).json({ ok: false, error: 'Phone and name required.' });

  const pending = pendingVerifications[phone];
  if (!pending || Date.now() - pending.verifiedAt > 600000)
    return res.status(401).json({ ok: false, error: 'Verification expired. Please start over.' });
  delete pendingVerifications[phone];

  const user = makeUser({ name, phone, phoneVerified: true });
  users.users.push(user);

  const token = createSession(user);
  setSessionCookie(res, token);
  saveData('users', users);

  res.json({ ok: true, user: { id: user.id, name: user.name, phone: user.phone } });
});

// POST /api/auth/google — verify Google credential JWT
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ ok: false, error: 'Missing credential.' });

  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    const info = await r.json();

    if (info.error_description || (config.googleClientId && info.aud !== config.googleClientId)) {
      return res.status(401).json({ ok: false, error: 'Invalid Google credential.' });
    }

    let user = users.users.find(u => u.googleId === info.sub || (u.email && u.email === info.email));
    if (!user) {
      user = makeUser({
        name: info.name || info.email.split('@')[0],
        email: info.email,
        googleId: info.sub
      });
      users.users.push(user);
      saveData('users', users);
    } else {
      if (!user.googleId) { user.googleId = info.sub; saveData('users', users); }
      if (!user.email && info.email) { user.email = info.email; saveData('users', users); }
    }

    const token = createSession(user);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    console.error('Google auth error:', e);
    res.status(500).json({ ok: false, error: 'Google verification failed.' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const user = getSession(req);
  if (!user) return res.json({ ok: false });
  res.json({
    ok: true,
    user: {
      id: user.id, name: user.name, email: user.email, phone: user.phone,
      profile: user.profile || { displayName: '', bio: '', photos: [], location: null }
    }
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('mf_session='));
  if (cookie) {
    const token = cookie.split('=')[1].trim();
    for (const u of users.users) {
      u.sessions = (u.sessions || []).filter(s => s.token !== token);
    }
    saveData('users', users);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => res.json(config));

// ═════════════════════════════════════════════════════════════════════════════
//  PROFILES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/profiles/:userId
app.get('/api/profiles/:userId', (req, res) => {
  const user = users.users.find(u => u.id === req.params.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });

  const userProducts = products.products.filter(p => p.sellerId === user.id && p.available !== false);

  res.json({
    ok: true,
    profile: {
      id: user.id,
      name: user.name,
      displayName: (user.profile && user.profile.displayName) || user.name,
      bio: (user.profile && user.profile.bio) || '',
      photos: (user.profile && user.profile.photos) || [],
      location: (user.profile && user.profile.location) || null,
      products: userProducts,
      createdAt: user.createdAt
    }
  });
});

// PUT /api/profiles — update own profile
app.put('/api/profiles', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  if (!user.profile) user.profile = { displayName: '', bio: '', photos: [], location: null };

  const { displayName, bio, location } = req.body;
  if (displayName !== undefined) user.profile.displayName = String(displayName).slice(0, 100);
  if (bio !== undefined) user.profile.bio = String(bio).slice(0, 1000);
  if (location !== undefined) user.profile.location = location;

  // Auto-create/update map element when location is set
  if (user.profile.location && user.profile.location.lat && user.profile.location.lng) {
    let el = elements.elements.find(e => e.ownerId === user.id && e.type === 'seller');
    if (!el) {
      el = { id: 'el_' + crypto.randomBytes(8).toString('hex'), type: 'seller', ownerId: user.id, active: true, createdAt: new Date().toISOString() };
      elements.elements.push(el);
    }
    el.title = user.profile.displayName || user.name;
    el.subtitle = '';
    el.description = user.profile.bio;
    el.imageUrl = (user.profile.photos && user.profile.photos[0]) || '';
    el.icon = '🏪';
    el.lat = user.profile.location.lat;
    el.lng = user.profile.location.lng;
    el.online = true;
    el.metadata = { userId: user.id };
    saveData('elements', elements);
  }

  saveData('users', users);
  res.json({ ok: true, profile: user.profile });
});

// POST /api/profiles/photos — upload profile photo
app.post('/api/profiles/photos', upload.single('photo'), (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

  if (!user.profile) user.profile = { displayName: '', bio: '', photos: [], location: null };
  if (user.profile.photos.length >= 6) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: 'Maximum 6 photos allowed.' });
  }

  const url = `/uploads/${req.file.filename}`;
  user.profile.photos.push(url);

  // Update map element image if this is the first photo
  if (user.profile.photos.length === 1) {
    const el = elements.elements.find(e => e.ownerId === user.id && e.type === 'seller');
    if (el) { el.imageUrl = url; saveData('elements', elements); }
  }

  saveData('users', users);
  res.json({ ok: true, url, photos: user.profile.photos });
});

// DELETE /api/profiles/photos/:index
app.delete('/api/profiles/photos/:index', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const idx = parseInt(req.params.index);
  if (!user.profile || !user.profile.photos || idx < 0 || idx >= user.profile.photos.length) {
    return res.status(400).json({ ok: false, error: 'Invalid photo index.' });
  }

  const filePath = path.join(__dirname, 'public', user.profile.photos[idx]);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  user.profile.photos.splice(idx, 1);
  saveData('users', users);
  res.json({ ok: true, photos: user.profile.photos });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PRODUCTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/products?sellerId=
app.get('/api/products', (req, res) => {
  let filtered = products.products.filter(p => p.available !== false);
  if (req.query.sellerId) filtered = filtered.filter(p => p.sellerId === req.query.sellerId);
  res.json({ ok: true, products: filtered });
});

// POST /api/products
app.post('/api/products', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { name, description, price } = req.body;
  if (!name || price == null) return res.status(400).json({ ok: false, error: 'Name and price required.' });

  const product = {
    id: 'prod_' + crypto.randomBytes(8).toString('hex'),
    sellerId: user.id,
    sellerName: (user.profile && user.profile.displayName) || user.name,
    name: String(name).slice(0, 200),
    description: String(description || '').slice(0, 2000),
    price: Math.round(Math.abs(parseFloat(price)) * 100), // cents
    photos: [],
    available: true,
    createdAt: new Date().toISOString()
  };

  products.products.push(product);
  saveData('products', products);
  res.json({ ok: true, product });
});

// POST /api/products/:id/photos — upload product photo
app.post('/api/products/:id/photos', upload.single('photo'), (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const product = products.products.find(p => p.id === req.params.id && p.sellerId === user.id);
  if (!product) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ ok: false, error: 'Not found.' }); }
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file.' });
  if (product.photos.length >= 4) { fs.unlinkSync(req.file.path); return res.status(400).json({ ok: false, error: 'Max 4 photos per product.' }); }

  const url = `/uploads/${req.file.filename}`;
  product.photos.push(url);
  saveData('products', products);
  res.json({ ok: true, url, photos: product.photos });
});

// PUT /api/products/:id
app.put('/api/products/:id', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const product = products.products.find(p => p.id === req.params.id && p.sellerId === user.id);
  if (!product) return res.status(404).json({ ok: false, error: 'Not found.' });

  const { name, description, price, available } = req.body;
  if (name !== undefined) product.name = String(name).slice(0, 200);
  if (description !== undefined) product.description = String(description).slice(0, 2000);
  if (price !== undefined) product.price = Math.round(Math.abs(parseFloat(price)) * 100);
  if (available !== undefined) product.available = !!available;

  saveData('products', products);
  res.json({ ok: true, product });
});

// DELETE /api/products/:id
app.delete('/api/products/:id', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const idx = products.products.findIndex(p => p.id === req.params.id && p.sellerId === user.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found.' });

  products.products.splice(idx, 1);
  saveData('products', products);
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { productId, note } = req.body;
  const product = products.products.find(p => p.id === productId && p.available !== false);
  if (!product) return res.status(404).json({ ok: false, error: 'Product not available.' });
  if (product.sellerId === user.id) return res.status(400).json({ ok: false, error: "Can't order your own product." });

  const order = {
    id: 'ord_' + crypto.randomBytes(8).toString('hex'),
    buyerId: user.id, buyerName: user.name,
    sellerId: product.sellerId, sellerName: product.sellerName,
    productId: product.id, productName: product.name,
    amount: product.price,
    note: String(note || '').slice(0, 500),
    status: 'pending',
    stripeSessionId: null,
    createdAt: new Date().toISOString()
  };

  // Stripe Checkout if configured
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: product.name, description: product.description || undefined },
            unit_amount: product.price
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: `${req.protocol}://${req.get('host')}/profile/${product.sellerId}?order=success&id=${order.id}`,
        cancel_url: `${req.protocol}://${req.get('host')}/profile/${product.sellerId}?order=cancelled`,
        metadata: { orderId: order.id }
      });
      order.stripeSessionId = session.id;
      order.status = 'awaiting_payment';
      orders.orders.push(order);
      saveData('orders', orders);
      return res.json({ ok: true, order, checkoutUrl: session.url });
    } catch (e) {
      console.error('Stripe error:', e.message);
    }
  }

  // No Stripe — order created as pending
  orders.orders.push(order);
  saveData('orders', orders);
  res.json({ ok: true, order, checkoutUrl: null });
});

// GET /api/orders
app.get('/api/orders', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const userOrders = orders.orders
    .filter(o => o.buyerId === user.id || o.sellerId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, orders: userOrders });
});

// PUT /api/orders/:id/status — seller updates order status
app.put('/api/orders/:id/status', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const order = orders.orders.find(o => o.id === req.params.id && o.sellerId === user.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Not found.' });

  const { status } = req.body;
  const validTransitions = {
    pending: ['confirmed', 'cancelled'],
    awaiting_payment: ['cancelled'],
    paid: ['confirmed', 'cancelled'],
    confirmed: ['completed', 'cancelled']
  };

  if (!validTransitions[order.status] || !validTransitions[order.status].includes(status)) {
    return res.status(400).json({ ok: false, error: `Cannot change from ${order.status} to ${status}.` });
  }

  order.status = status;
  saveData('orders', orders);
  res.json({ ok: true, order });
});

// Stripe webhook
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = JSON.parse(req.body);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const order = orders.orders.find(o => o.stripeSessionId === session.id);
      if (order) {
        order.status = 'paid';
        saveData('orders', orders);
        console.log(`✓ Order ${order.id} paid via Stripe`);
      }
    }
  } catch (e) {
    console.error('Webhook error:', e);
  }
  res.json({ received: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ELEMENTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/elements
app.get('/api/elements', (req, res) => {
  const { sw_lat, sw_lng, ne_lat, ne_lng } = req.query;
  let filtered = elements.elements.filter(e => e.active !== false);

  if (sw_lat && sw_lng && ne_lat && ne_lng) {
    const swLat = parseFloat(sw_lat), swLng = parseFloat(sw_lng);
    const neLat = parseFloat(ne_lat), neLng = parseFloat(ne_lng);
    filtered = filtered.filter(e => e.lat >= swLat && e.lat <= neLat && e.lng >= swLng && e.lng <= neLng);
  }

  // Attach product count for seller elements
  filtered = filtered.map(e => {
    if (e.metadata && e.metadata.userId) {
      const count = products.products.filter(p => p.sellerId === e.metadata.userId && p.available !== false).length;
      return { ...e, productCount: count };
    }
    return e;
  });

  res.json({ ok: true, elements: filtered, total: filtered.length });
});

// GET /api/elements/:id
app.get('/api/elements/:id', (req, res) => {
  const el = elements.elements.find(e => e.id === req.params.id);
  if (!el) return res.status(404).json({ ok: false, error: 'Not found.' });

  let result = { ...el };
  if (el.metadata && el.metadata.userId) {
    result.products = products.products.filter(p => p.sellerId === el.metadata.userId && p.available !== false);
  }

  res.json({ ok: true, element: result });
});

// POST /api/elements
app.post('/api/elements', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { title, subtitle, description, imageUrl, lat, lng, icon, type, metadata } = req.body;
  if (!title || lat == null || lng == null)
    return res.status(400).json({ ok: false, error: 'title, lat, lng required.' });

  const el = {
    id: 'el_' + crypto.randomBytes(8).toString('hex'),
    type: type || 'default', title, subtitle: subtitle || '', description: description || '',
    imageUrl: imageUrl || '', icon: icon || '📍',
    lat: parseFloat(lat), lng: parseFloat(lng),
    ownerId: user.id, metadata: metadata || {},
    online: true, active: true,
    createdAt: new Date().toISOString()
  };

  elements.elements.push(el);
  saveData('elements', elements);
  res.json({ ok: true, element: el });
});

// DELETE /api/elements/:id
app.delete('/api/elements/:id', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  const idx = elements.elements.findIndex(e => e.id === req.params.id && e.ownerId === user.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Not found or not yours.' });
  elements.elements.splice(idx, 1);
  saveData('elements', elements);
  res.json({ ok: true });
});

// POST /api/elements/seed-nearby
app.post('/api/elements/seed-nearby', (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ ok: false, error: 'lat and lng required.' });

  const nearby = elements.elements.filter(e => Math.sqrt(Math.pow(e.lat - lat, 2) + Math.pow(e.lng - lng, 2)) < 0.03);
  if (nearby.length >= 5) return res.json({ ok: true, seeded: 0 });

  const names = ['Alex M.', 'Jordan K.', 'Sam R.', 'Taylor B.', 'Casey L.', 'Morgan P.', 'Riley D.', 'Avery C.', 'Quinn S.', 'Drew N.', 'Blake H.', 'Charlie F.'];
  const bios = ['Coffee lover. Always exploring.', 'New here — show me around!', 'Weekend hiker, weekday coder.', 'Looking for recommendations.', 'Music and art enthusiast.', 'Photographer capturing life.', 'Fitness junkie, early riser.', 'Bookworm.', 'Foodie on a mission.', 'Into live music.', 'Designer by day, gamer by night.', 'Travel addict.'];
  const count = Math.min(12, 12 - nearby.length);

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 0.012 + 0.002;
    const name = names[i];
    elements.elements.push({
      id: 'el_near_' + crypto.randomBytes(4).toString('hex'),
      type: 'person', title: name,
      subtitle: `${(Math.random() * 2.5 + 0.1).toFixed(1)} mi away`,
      description: bios[i],
      imageUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}&backgroundColor=1a1a2e`,
      icon: '👤', lat: lat + Math.sin(angle) * radius, lng: lng + Math.cos(angle) * radius,
      ownerId: 'system', metadata: {},
      online: Math.random() > 0.4, active: true,
      createdAt: new Date().toISOString()
    });
  }

  saveData('elements', elements);
  res.json({ ok: true, seeded: count });
});

// ═════════════════════════════════════════════════════════════════════════════
//  MESSAGES
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/messages', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'Recipient and text required.' });
  const msg = { id: 'msg_' + crypto.randomBytes(8).toString('hex'), fromId: user.id, toId: to, text: text.slice(0, 2000), createdAt: new Date().toISOString() };
  messages.messages.push(msg);
  saveData('messages', messages);
  res.json({ ok: true, message: msg });
});

app.get('/api/messages', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  const userMsgs = messages.messages.filter(m => m.fromId === user.id || m.toId === user.id);
  const peers = {};
  userMsgs.forEach(m => {
    const peerId = m.fromId === user.id ? m.toId : m.fromId;
    if (!peers[peerId] || new Date(m.createdAt) > new Date(peers[peerId].lastMessage.createdAt))
      peers[peerId] = { peerId, lastMessage: m };
  });
  res.json({ ok: true, conversations: Object.values(peers).sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)) });
});

app.get('/api/messages/:peerId', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  const convo = messages.messages
    .filter(m => (m.fromId === user.id && m.toId === req.params.peerId) || (m.fromId === req.params.peerId && m.toId === user.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ ok: true, messages: convo });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SEED
// ═════════════════════════════════════════════════════════════════════════════
function seedDefaults() {
  if (elements.elements.length > 0) return;
  const lat = config.defaultLat || 40.758, lng = config.defaultLng || -73.9855;
  const names = ['Alex M.','Jordan K.','Sam R.','Taylor B.','Casey L.','Morgan P.','Riley D.','Avery C.','Quinn S.','Drew N.','Blake H.','Charlie F.','Dana W.','Emery T.','Finley G.','Hayden J.','Jamie V.','Kai Z.','Logan A.','Micah E.'];
  const bios = ['Coffee lover. Dog person. Always exploring.','New to the area — show me around!','Weekend hiker, weekday coder.','Looking for good food recommendations.','Music and art enthusiast.','Just moved here from the west coast.','Photographer capturing city life.','Fitness junkie, early riser.','Bookworm seeking conversation partners.','Foodie on a mission to try every restaurant.','Into live music and rooftop bars.','Designer by day, gamer by night.','Plant parent. Yoga practitioner.','Love cooking and hosting dinner parties.','Travel addict. 30 countries and counting.','Film buff. Ask me for recommendations.','Runner training for a marathon.','Craft beer enthusiast.','Night owl. Love late-night walks.','Tech nerd. Board game collector.'];
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.015 + 0.002;
    elements.elements.push({
      id: 'el_seed_' + String(i+1).padStart(3,'0'), type: 'person', title: names[i],
      subtitle: `${(Math.random()*2.5+0.1).toFixed(1)} mi away`, description: bios[i],
      imageUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(names[i])}&backgroundColor=1a1a2e`,
      icon: '👤', lat: lat + Math.sin(a)*r, lng: lng + Math.cos(a)*r,
      ownerId: 'system', metadata: {}, online: Math.random()>0.4, active: true,
      createdAt: new Date(Date.now()-Math.random()*7*86400000).toISOString()
    });
  }
  saveData('elements', elements);
  console.log(`✓ Seeded ${elements.elements.length} demo elements`);
}

seedDefaults();

app.listen(PORT, () => {
  console.log(`\n  🗺️  Map Framework running at http://localhost:${PORT}`);
  console.log(`  Service: ${config.name}`);
  console.log(`  Elements: ${elements.elements.length} | Products: ${products.products.length} | Users: ${users.users.length}\n`);
});
