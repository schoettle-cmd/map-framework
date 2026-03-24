const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
    console.log('⚠ Twilio module not found, using local OTPs');
  }
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
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
  // Test phones — always succeed
  if (TEST_PHONES[phone]) {
    otps.otps = otps.otps.filter(o => o.phone !== phone);
    otps.otps.push({ phone, code: TEST_PHONES[phone], expiresAt: new Date(Date.now() + 600000).toISOString() });
    saveData('otps', otps);
    return { ok: true, test: true };
  }

  // Try Twilio Verify
  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verifications.create({ to: phone, channel: 'sms' });
      return { ok: true };
    } catch (e) {
      console.error('Twilio error:', e.message);
    }
  }

  // Fallback: local OTP (printed to console for dev)
  const code = generateOtp();
  otps.otps = otps.otps.filter(o => o.phone !== phone);
  otps.otps.push({ phone, code, expiresAt: new Date(Date.now() + 600000).toISOString() });
  saveData('otps', otps);
  console.log(`\n  📱 OTP for ${phone}: ${code}\n`);
  return { ok: true, local: true, code };
}

async function verifyOtp(phone, code) {
  if (TEST_PHONES[phone]) return code === TEST_PHONES[phone];

  // Try Twilio Verify
  if (twilioClient && TWILIO_VERIFY_SID) {
    try {
      const check = await twilioClient.verify.v2.services(TWILIO_VERIFY_SID).verificationChecks.create({ to: phone, code });
      if (check.status === 'approved') return true;
    } catch (e) { /* fall through to local check */ }
  }

  // Local OTP check
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

// Pending phone verifications (verified but not yet named)
const pendingVerifications = {};

// ── Auth Routes ─────────────────────────────────────────────────────────────

// POST /api/auth/start — send OTP to phone
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

// POST /api/auth/verify — verify OTP, login or start registration
app.post('/api/auth/verify', async (req, res) => {
  if (!rateLimit('auth-verify', req.ip, 10, 900000))
    return res.status(429).json({ ok: false, error: 'Too many attempts.' });

  const phone = normalizePhone(req.body.phone);
  const code = (req.body.code || '').trim();
  if (!phone || !code) return res.status(400).json({ ok: false, error: 'Phone and code required.' });

  const valid = await verifyOtp(phone, code);
  if (!valid) return res.status(401).json({ ok: false, error: 'Invalid or expired code.' });

  // Existing user → login
  const existing = users.users.find(u => u.phone === phone);
  if (existing) {
    const token = createSession(existing);
    setSessionCookie(res, token);
    return res.json({ ok: true, user: { id: existing.id, name: existing.name, phone: existing.phone } });
  }

  // New user → need name
  pendingVerifications[phone] = { verifiedAt: Date.now() };
  res.json({ ok: true, needsName: true });
});

// POST /api/auth/complete — finish registration with name
app.post('/api/auth/complete', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = (req.body.name || '').trim();
  if (!phone || !name) return res.status(400).json({ ok: false, error: 'Phone and name required.' });

  const pending = pendingVerifications[phone];
  if (!pending || Date.now() - pending.verifiedAt > 600000)
    return res.status(401).json({ ok: false, error: 'Verification expired. Please start over.' });
  delete pendingVerifications[phone];

  const user = {
    id: 'user_' + crypto.randomBytes(8).toString('hex'),
    name,
    phone,
    phoneVerified: true,
    sessions: [],
    createdAt: new Date().toISOString()
  };
  users.users.push(user);

  const token = createSession(user);
  setSessionCookie(res, token);
  saveData('users', users);

  res.json({ ok: true, user: { id: user.id, name: user.name, phone: user.phone } });
});

// GET /api/auth/me
app.get('/api/auth/me', (req, res) => {
  const user = getSession(req);
  if (!user) return res.json({ ok: false });
  res.json({ ok: true, user: { id: user.id, name: user.name, phone: user.phone } });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('mf_session='));
  if (cookie) {
    const token = cookie.split('=')[1].trim();
    for (const user of users.users) {
      user.sessions = (user.sessions || []).filter(s => s.token !== token);
    }
    saveData('users', users);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Config Route ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json(config));

// ── Elements Routes ─────────────────────────────────────────────────────────

// GET /api/elements — list elements within map bounds
app.get('/api/elements', (req, res) => {
  const { sw_lat, sw_lng, ne_lat, ne_lng } = req.query;
  let filtered = elements.elements.filter(e => e.active !== false);

  if (sw_lat && sw_lng && ne_lat && ne_lng) {
    const swLat = parseFloat(sw_lat), swLng = parseFloat(sw_lng);
    const neLat = parseFloat(ne_lat), neLng = parseFloat(ne_lng);
    filtered = filtered.filter(e =>
      e.lat >= swLat && e.lat <= neLat && e.lng >= swLng && e.lng <= neLng
    );
  }

  res.json({ ok: true, elements: filtered, total: filtered.length });
});

// GET /api/elements/:id
app.get('/api/elements/:id', (req, res) => {
  const el = elements.elements.find(e => e.id === req.params.id);
  if (!el) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, element: el });
});

// POST /api/elements — create element (authenticated)
app.post('/api/elements', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { title, subtitle, description, imageUrl, lat, lng, icon, type, metadata } = req.body;
  if (!title || lat == null || lng == null)
    return res.status(400).json({ ok: false, error: 'title, lat, lng required.' });

  const el = {
    id: 'el_' + crypto.randomBytes(8).toString('hex'),
    type: type || 'default',
    title, subtitle: subtitle || '', description: description || '',
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

// POST /api/elements/seed-nearby — generate demo elements near a location
app.post('/api/elements/seed-nearby', (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ ok: false, error: 'lat and lng required.' });

  const nearby = elements.elements.filter(e => {
    const d = Math.sqrt(Math.pow(e.lat - lat, 2) + Math.pow(e.lng - lng, 2));
    return d < 0.03;
  });

  if (nearby.length >= 5) return res.json({ ok: true, seeded: 0 });

  const names = ['Alex M.', 'Jordan K.', 'Sam R.', 'Taylor B.', 'Casey L.', 'Morgan P.', 'Riley D.', 'Avery C.', 'Quinn S.', 'Drew N.', 'Blake H.', 'Charlie F.'];
  const bios = [
    'Coffee lover. Dog person. Always exploring.',
    'New to the area — show me around!',
    'Weekend hiker, weekday coder.',
    'Looking for good food recs.',
    'Music and art enthusiast.',
    'Photographer capturing city life.',
    'Fitness junkie, early riser.',
    'Bookworm seeking conversation.',
    'Foodie on a mission.',
    'Into live music and rooftop bars.',
    'Designer by day, gamer by night.',
    'Travel addict. 30 countries and counting.'
  ];

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
      icon: '👤',
      lat: lat + Math.sin(angle) * radius,
      lng: lng + Math.cos(angle) * radius,
      ownerId: 'system', metadata: {},
      online: Math.random() > 0.4, active: true,
      createdAt: new Date().toISOString()
    });
  }

  saveData('elements', elements);
  res.json({ ok: true, seeded: count });
});

// ── Messages Routes ─────────────────────────────────────────────────────────

// POST /api/messages — send message
app.post('/api/messages', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: 'Recipient and text required.' });

  const msg = {
    id: 'msg_' + crypto.randomBytes(8).toString('hex'),
    fromId: user.id, toId: to,
    text: text.slice(0, 2000),
    createdAt: new Date().toISOString()
  };
  messages.messages.push(msg);
  saveData('messages', messages);
  res.json({ ok: true, message: msg });
});

// GET /api/messages — list conversations
app.get('/api/messages', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const userMsgs = messages.messages.filter(m => m.fromId === user.id || m.toId === user.id);
  const peers = {};
  userMsgs.forEach(m => {
    const peerId = m.fromId === user.id ? m.toId : m.fromId;
    if (!peers[peerId] || new Date(m.createdAt) > new Date(peers[peerId].lastMessage.createdAt)) {
      peers[peerId] = { peerId, lastMessage: m };
    }
  });
  res.json({ ok: true, conversations: Object.values(peers).sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)) });
});

// GET /api/messages/:peerId
app.get('/api/messages/:peerId', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const peerId = req.params.peerId;
  const convo = messages.messages.filter(m =>
    (m.fromId === user.id && m.toId === peerId) || (m.fromId === peerId && m.toId === user.id)
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  res.json({ ok: true, messages: convo });
});

// ── Seed Default Elements ───────────────────────────────────────────────────
function seedDefaults() {
  if (elements.elements.length > 0) return;

  const lat = config.defaultLat || 40.7580;
  const lng = config.defaultLng || -73.9855;

  const names = [
    'Alex M.', 'Jordan K.', 'Sam R.', 'Taylor B.', 'Casey L.',
    'Morgan P.', 'Riley D.', 'Avery C.', 'Quinn S.', 'Drew N.',
    'Blake H.', 'Charlie F.', 'Dana W.', 'Emery T.', 'Finley G.',
    'Hayden J.', 'Jamie V.', 'Kai Z.', 'Logan A.', 'Micah E.'
  ];
  const bios = [
    'Coffee lover. Dog person. Always exploring.',
    'New to the area — show me around!',
    'Weekend hiker, weekday coder.',
    'Looking for good food recommendations.',
    'Music and art enthusiast.',
    'Just moved here from the west coast.',
    'Photographer capturing city life.',
    'Fitness junkie, early riser.',
    'Bookworm seeking conversation partners.',
    'Foodie on a mission to try every restaurant.',
    'Into live music and rooftop bars.',
    'Designer by day, gamer by night.',
    'Plant parent. Yoga practitioner.',
    'Love cooking and hosting dinner parties.',
    'Travel addict. 30 countries and counting.',
    'Film buff. Ask me for recommendations.',
    'Runner training for a marathon.',
    'Craft beer enthusiast.',
    'Night owl. Love late-night walks.',
    'Tech nerd. Board game collector.'
  ];

  for (let i = 0; i < 20; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 0.015 + 0.002;
    elements.elements.push({
      id: 'el_seed_' + String(i + 1).padStart(3, '0'),
      type: 'person', title: names[i],
      subtitle: `${(Math.random() * 2.5 + 0.1).toFixed(1)} mi away`,
      description: bios[i],
      imageUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(names[i])}&backgroundColor=1a1a2e`,
      icon: '👤',
      lat: lat + Math.sin(angle) * radius,
      lng: lng + Math.cos(angle) * radius,
      ownerId: 'system', metadata: {},
      online: Math.random() > 0.4, active: true,
      createdAt: new Date(Date.now() - Math.random() * 7 * 86400000).toISOString()
    });
  }

  saveData('elements', elements);
  console.log(`✓ Seeded ${elements.elements.length} demo elements`);
}

// ── Start ───────────────────────────────────────────────────────────────────
seedDefaults();

app.listen(PORT, () => {
  console.log(`\n  🗺️  Map Framework running at http://localhost:${PORT}`);
  console.log(`  Service: ${config.name}`);
  console.log(`  Elements: ${elements.elements.length}`);
  console.log(`  Users: ${users.users.length}\n`);
});
