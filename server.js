const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { scrapeAll } = require('./scrapers');

// Prevent crashes from unhandled rejections
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); });

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
app.use(express.json({ limit: '1mb' }));

// Log all requests for debugging
app.use((req, res, next) => {
  if (req.path.includes('chat')) {
    console.log(`[req] ${req.method} ${req.path} | body: ${JSON.stringify(req.body).slice(0, 100)}`);
  }
  next();
});

// Clean URL routes (before static)
const noCache = (req, res, next) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); next(); };
app.get('/studio', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public/studio.html')));
app.get('/map', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public/map.html')));
app.get('/profile', (req, res) => res.redirect('/map.html'));
app.get('/profile/:id', (req, res) => {
  const id = req.params.id;
  let el = elements.elements.find(e => e.ownerId === id && e.active !== false);
  if (!el) el = elements.elements.find(e => e.id === id && e.active !== false);
  if (!el) return res.status(404).send('<h1>Not Found</h1>');

  const userId = (el.metadata && el.metadata.userId) || el.ownerId;
  const elProducts = products.products.filter(p => p.sellerId === userId && p.available !== false);
  const sellerRatings = ratings.ratings.filter(r => r.sellerId === userId);
  const avgRating = sellerRatings.length > 0
    ? Math.round((sellerRatings.reduce((s, r) => s + r.rating, 0) / sellerRatings.length) * 10) / 10
    : 0;

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tags = el.tags ? (Array.isArray(el.tags) ? el.tags : String(el.tags).split(',').map(t => t.trim()).filter(Boolean)) : [];

  const menuHtml = elProducts.map(p => `
    <div class="meal-card">
      ${p.photos && p.photos.length ? `<img src="${esc(p.photos[0])}" class="meal-img" alt="${esc(p.name)}">` : ''}
      <div class="meal-body">
        <div class="meal-header">
          <h3 class="meal-name">${esc(p.name)}</h3>
          ${p.price > 0 ? `<span class="meal-price">$${(p.price / 100).toFixed(2)}</span>` : ''}
        </div>
        ${p.description ? `<p class="meal-desc">${esc(p.description)}</p>` : ''}
        ${p.allergens && p.allergens.length ? `<div class="meal-allergens">${p.allergens.map(a => `<span class="allergen-tag">${esc(a)}</span>`).join('')}</div>` : ''}
      </div>
    </div>
  `).join('');

  const contactLinks = [];
  if (el.email) contactLinks.push(`<a href="mailto:${esc(el.email)}" class="contact-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>Email</a>`);
  if (el.phone) contactLinks.push(`<a href="tel:${esc(el.phone)}" class="contact-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>Call</a>`);
  if (el.instagram) contactLinks.push(`<a href="https://instagram.com/${esc(el.instagram.replace(/^@/, ''))}" target="_blank" rel="noopener" class="contact-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/></svg>Instagram</a>`);
  if (el.externalOrderUrl) contactLinks.push(`<a href="${esc(el.externalOrderUrl)}" target="_blank" rel="noopener" class="contact-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/></svg>Website</a>`);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(el.title)} | Kinseb</title>
<meta name="description" content="${esc(el.description || el.subtitle || '')}">
<meta property="og:title" content="${esc(el.title)} — Kinseb">
<meta property="og:description" content="${esc(el.description || el.subtitle || '')}">
${el.imageUrl ? `<meta property="og:image" content="${esc(el.imageUrl)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --cream: #F5F1E8;
  --ink: #1A1A1A;
  --olive: #2F3A2F;
  --terracotta: #C46A3C;
  --terracotta-light: #D4845A;
  --warm-gray: #8A8577;
  --light-border: rgba(47,58,47,0.12);
  --card-bg: #FDFBF7;
  --serif: 'Playfair Display', Georgia, serif;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--sans);
  background: var(--cream);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100vh;
}

/* Nav */
.nav {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50;
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 28px;
  background: rgba(245,241,232,0.92);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--light-border);
}
.nav-logo {
  font-family: var(--serif);
  font-size: 22px; font-weight: 700;
  color: var(--ink); text-decoration: none;
  letter-spacing: -0.02em;
}
.nav-links { display: flex; align-items: center; gap: 24px; }
.nav-link {
  font-size: 14px; font-weight: 500;
  color: var(--warm-gray); text-decoration: none;
  transition: color 0.2s;
}
.nav-link:hover { color: var(--ink); }
.nav-cta {
  padding: 9px 22px; border-radius: 100px;
  background: var(--terracotta); border: none;
  color: #fff; font-size: 13px; font-weight: 600;
  text-decoration: none; transition: background 0.2s;
}
.nav-cta:hover { background: var(--terracotta-light); }

/* Hero Portrait */
.profile-hero {
  position: relative;
  width: 100%;
  height: 65vh;
  min-height: 400px;
  max-height: 700px;
  overflow: hidden;
  margin-top: 60px;
}
.profile-hero img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.profile-hero-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  font-size: 120px; color: rgba(47,58,47,0.08);
  background: #e8e4db;
}
.hero-gradient {
  position: absolute; bottom: 0; left: 0; right: 0;
  height: 50%;
  background: linear-gradient(to top, rgba(26,26,26,0.6) 0%, transparent 100%);
  pointer-events: none;
}
.hero-overlay-content {
  position: absolute; bottom: 40px; left: 0; right: 0;
  padding: 0 32px;
  max-width: 800px;
  margin: 0 auto;
}
.hero-cuisine {
  font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.12em;
  color: var(--terracotta-light);
  margin-bottom: 10px;
}
.hero-name {
  font-family: var(--serif);
  font-size: clamp(36px, 6vw, 56px);
  font-weight: 600;
  color: #fff;
  line-height: 1.1;
  letter-spacing: -0.02em;
  margin-bottom: 8px;
}
.hero-location {
  font-size: 15px;
  color: rgba(255,255,255,0.7);
  font-weight: 400;
}
.hero-rating {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: 10px;
  font-size: 14px; color: #fff; font-weight: 500;
}
.hero-rating .stars { color: var(--terracotta-light); }

/* Content */
.profile-content {
  max-width: 800px;
  margin: 0 auto;
  padding: 48px 32px 80px;
}
.profile-grid {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 60px;
  align-items: start;
}

/* Main Column */
.profile-main {}
.section-label {
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--terracotta);
  margin-bottom: 14px;
}
.profile-story {
  font-size: 17px;
  line-height: 1.8;
  color: #4a4a42;
  margin-bottom: 40px;
}
.profile-tags {
  display: flex; flex-wrap: wrap; gap: 8px;
  margin-bottom: 40px;
}
.profile-tag {
  padding: 6px 16px; border-radius: 100px;
  font-size: 12px; font-weight: 600;
  background: rgba(47,58,47,0.06);
  color: var(--olive);
  border: 1px solid rgba(47,58,47,0.1);
}

/* Menu */
.menu-section { margin-bottom: 40px; }
.meal-card {
  display: flex; gap: 16px;
  padding: 20px;
  background: var(--card-bg);
  border: 1px solid var(--light-border);
  border-radius: 18px;
  margin-bottom: 12px;
  transition: transform 0.2s, box-shadow 0.2s;
}
.meal-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(47,58,47,0.08);
}
.meal-img {
  width: 100px; height: 100px;
  border-radius: 12px;
  object-fit: cover;
  flex-shrink: 0;
}
.meal-body { flex: 1; min-width: 0; }
.meal-header {
  display: flex; justify-content: space-between;
  align-items: flex-start; gap: 12px;
  margin-bottom: 6px;
}
.meal-name {
  font-family: var(--serif);
  font-size: 18px; font-weight: 600;
  letter-spacing: -0.01em;
}
.meal-price {
  font-size: 16px; font-weight: 700;
  color: var(--terracotta);
  white-space: nowrap;
}
.meal-desc {
  font-size: 14px; line-height: 1.6;
  color: var(--warm-gray);
}
.meal-allergens {
  display: flex; flex-wrap: wrap; gap: 4px;
  margin-top: 8px;
}
.allergen-tag {
  padding: 3px 10px; border-radius: 100px;
  font-size: 11px; font-weight: 600;
  background: rgba(196,106,60,0.08);
  color: var(--terracotta);
}

/* Sidebar */
.profile-sidebar {
  position: sticky; top: 84px;
}
.sidebar-card {
  background: var(--card-bg);
  border: 1px solid var(--light-border);
  border-radius: 24px;
  padding: 32px 28px;
}
.order-btn {
  display: block; width: 100%;
  padding: 16px; border-radius: 100px;
  font-size: 15px; font-weight: 600;
  cursor: pointer; border: none;
  font-family: var(--sans);
  text-align: center; text-decoration: none;
  background: var(--terracotta);
  color: #fff;
  transition: all 0.2s;
  margin-bottom: 16px;
}
.order-btn:hover { background: var(--terracotta-light); transform: translateY(-1px); }
.message-btn {
  display: block; width: 100%;
  padding: 14px; border-radius: 100px;
  font-size: 14px; font-weight: 600;
  cursor: pointer;
  font-family: var(--sans);
  text-align: center; text-decoration: none;
  background: transparent;
  color: var(--ink);
  border: 1.5px solid var(--light-border);
  transition: all 0.2s;
  margin-bottom: 24px;
}
.message-btn:hover { border-color: var(--ink); }
.sidebar-divider {
  height: 1px;
  background: var(--light-border);
  margin: 20px 0;
}
.sidebar-section-title {
  font-size: 11px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--warm-gray);
  margin-bottom: 12px;
}
.contact-links {
  display: flex; flex-direction: column; gap: 8px;
}
.contact-link {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(47,58,47,0.03);
  color: var(--ink);
  font-size: 13px; font-weight: 600;
  text-decoration: none;
  transition: all 0.15s;
}
.contact-link:hover { background: rgba(47,58,47,0.08); }
.contact-link svg { color: var(--warm-gray); flex-shrink: 0; }
.availability-info {
  font-size: 13px; line-height: 1.7;
  color: var(--warm-gray);
}
.availability-info strong {
  color: var(--ink);
  font-weight: 600;
}

/* Footer */
.profile-footer {
  padding: 40px 28px;
  text-align: center;
  border-top: 1px solid var(--light-border);
}
.profile-footer-brand {
  font-family: var(--serif);
  font-size: 18px; font-weight: 700;
  color: var(--ink);
  margin-bottom: 8px;
}
.profile-footer-tagline {
  font-size: 13px; font-style: italic;
  color: var(--warm-gray);
}

/* Responsive */
@media (max-width: 1024px) {
  .profile-grid {
    grid-template-columns: 1fr;
    gap: 32px;
  }
  .profile-sidebar { position: static; }
}
@media (max-width: 768px) {
  .nav { padding: 14px 20px; }
  .nav-links { display: none; }
  .profile-hero {
    height: 50vh; min-height: 300px;
    margin-top: 54px;
  }
  .hero-overlay-content { padding: 0 20px; bottom: 28px; }
  .hero-name { font-size: clamp(28px, 8vw, 42px); }
  .profile-content { padding: 32px 20px 60px; }
  .meal-card { flex-direction: column; }
  .meal-img { width: 100%; height: 180px; }
}
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">Kinseb</a>
  <div class="nav-links">
    <a href="/map" class="nav-link">Explore</a>
    <a href="/join" class="nav-link">Become a chef</a>
    <a href="/map" class="nav-cta">Discover chefs</a>
  </div>
</nav>

<section class="profile-hero">
  ${el.imageUrl
    ? `<img src="${esc(el.imageUrl)}" alt="${esc(el.title)}">`
    : `<div class="profile-hero-placeholder">${el.icon || '&#127860;'}</div>`}
  <div class="hero-gradient"></div>
  <div class="hero-overlay-content">
    ${el.cuisineType ? `<div class="hero-cuisine">${esc(el.cuisineType)}</div>` : ''}
    <h1 class="hero-name">${esc(el.title)}</h1>
    ${el.address ? `<div class="hero-location">${esc(el.address)}</div>` : (el.subtitle ? `<div class="hero-location">${esc(el.subtitle)}</div>` : '')}
    ${avgRating > 0 ? `<div class="hero-rating"><span class="stars">${'&#9733;'.repeat(Math.round(avgRating))}</span> ${avgRating} (${sellerRatings.length} review${sellerRatings.length !== 1 ? 's' : ''})</div>` : ''}
  </div>
</section>

<div class="profile-content">
  <div class="profile-grid">
    <div class="profile-main">
      ${el.description ? `
        <div class="section-label">Their Story</div>
        <p class="profile-story">${esc(el.description)}</p>
      ` : ''}
      ${tags.length ? `<div class="profile-tags">${tags.map(t => `<span class="profile-tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${elProducts.length > 0 ? `
        <div class="menu-section">
          <div class="section-label">Menu</div>
          ${menuHtml}
        </div>
      ` : ''}
    </div>
    <aside class="profile-sidebar">
      <div class="sidebar-card">
        ${el.externalOrderUrl ? `<a href="${esc(el.externalOrderUrl)}" target="_blank" rel="noopener" class="order-btn">Order Now</a>` : `<a href="/map" class="order-btn">View on Map</a>`}
        <a href="/map" class="message-btn">Message Chef</a>
        <div class="sidebar-divider"></div>
        <div class="sidebar-section-title">Availability</div>
        <div class="availability-info">
          <strong>Pickup</strong> available<br>
          Message chef for delivery options and scheduling.
        </div>
        ${contactLinks.length > 0 ? `
          <div class="sidebar-divider"></div>
          <div class="sidebar-section-title">Connect</div>
          <div class="contact-links">${contactLinks.join('')}</div>
        ` : ''}
      </div>
    </aside>
  </div>
</div>

<footer class="profile-footer">
  <div class="profile-footer-brand">Kinseb</div>
  <div class="profile-footer-tagline">Eat beautifully.</div>
</footer>
</body>
</html>`;

  res.send(html);
});
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public/terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public/privacy.html')));
app.get('/seller', (req, res) => res.sendFile(path.join(__dirname, 'public/seller.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public/join.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

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
let ratings = loadData('ratings', { ratings: [] });
let payouts = loadData('payouts', { payouts: [] });
let prospects = loadData('prospects', { prospects: [] });
let campaigns = loadData('campaigns', { campaigns: [] });
let platformSettings = loadData('platform_settings', {
  platformName: 'Kinseb',
  tagline: 'Eat beautifully.',
  accentColor: '#C46A3C',
  commissionRate: 20,
  minPayoutAmount: 2500,
  payoutSchedule: 'weekly',
  taxRate: 9.5,
  requirePermit: true,
  emailEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: 'noreply@kinseb.com',
  adminPassword: 'kinseb-admin-2026',
  maxProductPhotos: 4,
  maxProfilePhotos: 6,
  locationFuzzyRadius: 0.005,
  freeViews: 5,
  enableRatings: true,
  enableMessaging: true,
  igShareEnabled: true,
  igShareDiscount: 10,
  igShareDefaultRate: 20,
  igShareVerifyRequired: true,
  igShareMessage: "Just ordered {{productName}} from {{sellerName}} on @Kinseb! 🍽 Eat beautifully. #Kinseb #HomeChef #EatLocal",
  igShareImageUrl: ""
});

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
    status: 'active',
    commissionOverride: null,
    emailOptIn: true,
    neighborhood: '',
    profile: { displayName: '', bio: '', photos: [], location: null },
    sessions: [],
    createdAt: new Date().toISOString(),
    ...fields
  };
}

// Pending phone verifications
const pendingVerifications = {};

// ── Admin Authentication ────────────────────────────────────────────────────
const adminTokens = new Set();

function getAdminSession(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('kinseb_admin='));
  if (!cookie) return false;
  const token = cookie.split('=')[1].trim();
  return adminTokens.has(token);
}

// ── Email System ────────────────────────────────────────────────────────────
function getEmailTransporter() {
  if (!platformSettings.emailEnabled || !platformSettings.smtpHost) return null;
  return nodemailer.createTransport({
    host: platformSettings.smtpHost,
    port: platformSettings.smtpPort || 587,
    secure: platformSettings.smtpPort === 465,
    auth: { user: platformSettings.smtpUser, pass: platformSettings.smtpPass }
  });
}

async function sendEmail(to, subject, html) {
  const transporter = getEmailTransporter();
  if (!transporter) {
    console.log(`📧 Email (not sent - disabled): ${subject} → ${to}`);
    return;
  }
  try {
    await transporter.sendMail({ from: platformSettings.smtpFrom, to, subject, html });
    console.log(`✓ Email sent: ${subject} → ${to}`);
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

function emailWrap(title, body) {
  const accent = platformSettings.accentColor || '#ea580c';
  const name = platformSettings.platformName || 'Kinseb';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
<div style="background:${accent};padding:20px 24px;color:#fff;font-size:20px;font-weight:700;">${name}</div>
<div style="padding:24px;">
<h2 style="margin:0 0 16px;color:#1c1917;font-size:18px;">${title}</h2>
${body}
</div>
<div style="padding:16px 24px;background:#fafaf9;color:#a8a29e;font-size:12px;text-align:center;">
${name} &mdash; ${platformSettings.tagline || ''}
</div>
</div></body></html>`;
}

function sendOrderNotificationToSeller(order) {
  const seller = users.users.find(u => u.id === order.sellerId);
  if (!seller || !seller.email) return;
  const html = emailWrap('New Order Received', `
    <p style="color:#44403c;line-height:1.6;">You have a new order from <strong>${order.buyerName}</strong>!</p>
    <div style="background:#fafaf9;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;"><strong>Product:</strong> ${order.productName}</p>
      <p style="margin:0 0 8px;"><strong>Amount:</strong> $${(order.amount / 100).toFixed(2)}</p>
      <p style="margin:0;"><strong>Order ID:</strong> ${order.id}</p>
      ${order.note ? `<p style="margin:8px 0 0;"><strong>Note:</strong> ${order.note}</p>` : ''}
    </div>
    <p style="color:#44403c;">Log in to your seller dashboard to confirm or manage this order.</p>
  `);
  sendEmail(seller.email, `New Order: ${order.productName}`, html);
}

function sendOrderConfirmationToBuyer(order) {
  const buyer = users.users.find(u => u.id === order.buyerId);
  if (!buyer || !buyer.email) return;
  const html = emailWrap('Order Confirmed', `
    <p style="color:#44403c;line-height:1.6;">Great news! Your order has been confirmed by <strong>${order.sellerName}</strong>.</p>
    <div style="background:#fafaf9;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;"><strong>Product:</strong> ${order.productName}</p>
      <p style="margin:0 0 8px;"><strong>Amount:</strong> $${(order.amount / 100).toFixed(2)}</p>
      <p style="margin:0;"><strong>Order ID:</strong> ${order.id}</p>
    </div>
    <p style="color:#44403c;">The seller will reach out regarding pickup or delivery details.</p>
  `);
  sendEmail(buyer.email, `Order Confirmed: ${order.productName}`, html);
}

function sendOrderCompletionToBuyer(order) {
  const buyer = users.users.find(u => u.id === order.buyerId);
  if (!buyer || !buyer.email) return;
  const html = emailWrap('Order Complete', `
    <p style="color:#44403c;line-height:1.6;">Your order from <strong>${order.sellerName}</strong> has been marked as complete!</p>
    <div style="background:#fafaf9;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;"><strong>Product:</strong> ${order.productName}</p>
      <p style="margin:0;"><strong>Order ID:</strong> ${order.id}</p>
    </div>
    <p style="color:#44403c;">Enjoyed your purchase? Leave a rating to help other buyers and support your seller!</p>
  `);
  sendEmail(buyer.email, `Order Complete: ${order.productName}`, html);
}

function sendOrderCancellationToBuyer(order) {
  const buyer = users.users.find(u => u.id === order.buyerId);
  if (!buyer || !buyer.email) return;
  const html = emailWrap('Order Cancelled', `
    <p style="color:#44403c;line-height:1.6;">Unfortunately, your order from <strong>${order.sellerName}</strong> has been cancelled.</p>
    <div style="background:#fafaf9;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;"><strong>Product:</strong> ${order.productName}</p>
      <p style="margin:0 0 8px;"><strong>Amount:</strong> $${(order.amount / 100).toFixed(2)}</p>
      <p style="margin:0;"><strong>Order ID:</strong> ${order.id}</p>
    </div>
    <p style="color:#44403c;">If you were charged, a refund will be processed. Feel free to browse other sellers on the marketplace.</p>
  `);
  sendEmail(buyer.email, `Order Cancelled: ${order.productName}`, html);
}

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
    return res.json({ ok: true, user: { id: existing.id, name: existing.name, phone: existing.phone, role: existing.role || 'buyer' } });
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

  const role = (req.body.role || 'buyer').toLowerCase() === 'seller' ? 'seller' : 'buyer';
  const user = makeUser({ name, phone, phoneVerified: true, role });
  users.users.push(user);

  const token = createSession(user);
  setSessionCookie(res, token);
  saveData('users', users);

  res.json({ ok: true, user: { id: user.id, name: user.name, phone: user.phone, role: user.role } });
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
      role: user.role || 'buyer',
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
app.get('/api/config', (req, res) => res.json({
  ...config,
  igShareEnabled: platformSettings.igShareEnabled,
  igShareDiscount: platformSettings.igShareDiscount
}));

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
      permitType: (user.profile && user.profile.permitType) || null,
      permitNumber: (user.profile && user.profile.permitNumber) || null,
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
  const maxPhotos = platformSettings.maxProfilePhotos || 6;
  if (user.profile.photos.length >= maxPhotos) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: `Maximum ${maxPhotos} photos allowed.` });
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
  let filtered = products.products.filter(p => {
    if (p.available === false) return false;
    // Filter out products from suspended sellers
    const seller = users.users.find(u => u.id === p.sellerId);
    if (seller && seller.status === 'suspended') return false;
    return true;
  });
  if (req.query.sellerId) filtered = filtered.filter(p => p.sellerId === req.query.sellerId);
  res.json({ ok: true, products: filtered });
});

// POST /api/products
app.post('/api/products', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { name, description, price, category, allergens } = req.body;
  if (!name || price == null) return res.status(400).json({ ok: false, error: 'Name and price required.' });

  const product = {
    id: 'prod_' + crypto.randomBytes(8).toString('hex'),
    sellerId: user.id,
    sellerName: (user.profile && user.profile.displayName) || user.name,
    name: String(name).slice(0, 200),
    description: String(description || '').slice(0, 2000),
    price: Math.round(Math.abs(parseFloat(price)) * 100), // cents
    category: category || 'other',
    allergens: Array.isArray(allergens) ? allergens : [],
    madeInHomeKitchen: true,
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
  const maxPhotos = platformSettings.maxProductPhotos || 4;
  if (product.photos.length >= maxPhotos) { fs.unlinkSync(req.file.path); return res.status(400).json({ ok: false, error: `Max ${maxPhotos} photos per product.` }); }

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

  // Check if seller is suspended
  const seller = users.users.find(u => u.id === product.sellerId);
  if (seller && seller.status === 'suspended') return res.status(400).json({ ok: false, error: 'This seller is currently unavailable.' });

  const order = {
    id: 'ord_' + crypto.randomBytes(8).toString('hex'),
    buyerId: user.id, buyerName: user.name,
    sellerId: product.sellerId, sellerName: product.sellerName,
    productId: product.id, productName: product.name,
    amount: product.price,
    note: String(note || '').slice(0, 500),
    status: 'pending',
    stripeSessionId: null,
    paidOut: false,
    igShareStatus: null,
    igShareDiscount: 0,
    igShareUsername: null,
    igShareAt: null,
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
      sendOrderNotificationToSeller(order);
      return res.json({ ok: true, order, checkoutUrl: session.url });
    } catch (e) {
      console.error('Stripe error:', e.message);
    }
  }

  // No Stripe — order created as pending
  orders.orders.push(order);
  saveData('orders', orders);
  sendOrderNotificationToSeller(order);
  res.json({ ok: true, order, checkoutUrl: null });
});

// GET /api/orders
app.get('/api/orders', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const userOrders = orders.orders
    .filter(o => o.buyerId === user.id || o.sellerId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(o => ({
      ...o,
      effectiveAmount: o.igShareStatus === 'verified' ? o.amount - (o.igShareDiscount || 0) : o.amount
    }));

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

  // Send email notifications based on status change
  if (status === 'confirmed') {
    sendOrderConfirmationToBuyer(order);
  } else if (status === 'completed') {
    sendOrderCompletionToBuyer(order);
  } else if (status === 'cancelled') {
    sendOrderCancellationToBuyer(order);
  }

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
//  INSTAGRAM SHARE DISCOUNT
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/orders/:id/ig-share-start — buyer declares intent to share
app.post('/api/orders/:id/ig-share-start', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  if (!platformSettings.igShareEnabled) return res.status(400).json({ ok: false, error: 'Instagram share discount is not available.' });

  const order = orders.orders.find(o => o.id === req.params.id && o.buyerId === user.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

  order.igShareStatus = 'pending';
  saveData('orders', orders);

  // Build share message from template
  let shareMessage = platformSettings.igShareMessage || '';
  shareMessage = shareMessage.replace(/\{\{productName\}\}/g, order.productName);
  shareMessage = shareMessage.replace(/\{\{sellerName\}\}/g, order.sellerName);

  res.json({
    ok: true,
    shareMessage,
    igShareImageUrl: platformSettings.igShareImageUrl || null,
    productName: order.productName,
    sellerName: order.sellerName,
    discountPct: platformSettings.igShareDiscount
  });
});

// POST /api/orders/:id/ig-share-confirm — buyer confirms they shared
app.post('/api/orders/:id/ig-share-confirm', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const order = orders.orders.find(o => o.id === req.params.id && o.buyerId === user.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

  const { igUsername } = req.body;
  if (!igUsername) return res.status(400).json({ ok: false, error: 'Instagram username required.' });

  order.igShareUsername = String(igUsername).slice(0, 100);
  order.igShareAt = new Date().toISOString();

  if (!platformSettings.igShareVerifyRequired) {
    // Auto-verify: apply discount immediately
    order.igShareDiscount = Math.round(order.amount * platformSettings.igShareDiscount / 100);
    order.igShareStatus = 'verified';
    saveData('orders', orders);
    return res.json({ ok: true, discountApplied: true, discount: order.igShareDiscount, status: 'verified' });
  }

  // Require manual verification
  order.igShareStatus = 'shared';
  saveData('orders', orders);
  res.json({ ok: true, discountApplied: false, discount: 0, status: 'shared' });
});

// PUT /api/admin/orders/:id/ig-verify — admin verifies Instagram post
app.put('/api/admin/orders/:id/ig-verify', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const order = orders.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

  const { verified } = req.body;
  if (verified) {
    order.igShareDiscount = Math.round(order.amount * platformSettings.igShareDiscount / 100);
    order.igShareStatus = 'verified';
  } else {
    order.igShareStatus = null;
    order.igShareDiscount = 0;
    order.igShareUsername = null;
    order.igShareAt = null;
  }

  saveData('orders', orders);
  res.json({ ok: true, order });
});

// GET /api/orders/:id/ig-share-status — get IG share status for an order
app.get('/api/orders/:id/ig-share-status', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const order = orders.orders.find(o => o.id === req.params.id && (o.buyerId === user.id || o.sellerId === user.id));
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

  const effectiveAmount = order.igShareStatus === 'verified' ? order.amount - order.igShareDiscount : order.amount;

  res.json({
    ok: true,
    igShareStatus: order.igShareStatus,
    igShareDiscount: order.igShareDiscount,
    igShareUsername: order.igShareUsername,
    effectiveAmount
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ELEMENTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/elements
app.get('/api/elements', (req, res) => {
  const { sw_lat, sw_lng, ne_lat, ne_lng } = req.query;
  let filtered = elements.elements.filter(e => {
    if (e.active === false) return false;
    // Only return seller elements
    if (e.type !== 'seller') return false;
    // Filter out suspended sellers
    if (e.metadata && e.metadata.userId) {
      const seller = users.users.find(u => u.id === e.metadata.userId);
      if (seller && seller.status === 'suspended') return false;
    }
    return true;
  });

  if (sw_lat && sw_lng && ne_lat && ne_lng) {
    const swLat = parseFloat(sw_lat), swLng = parseFloat(sw_lng);
    const neLat = parseFloat(ne_lat), neLng = parseFloat(ne_lng);
    filtered = filtered.filter(e => e.lat >= swLat && e.lat <= neLat && e.lng >= swLng && e.lng <= neLng);
  }

  // Attach product count — exact locations (businesses, not people)
  filtered = filtered.map(e => {
    const copy = { ...e };
    if (e.metadata && e.metadata.userId) {
      const count = products.products.filter(p => p.sellerId === e.metadata.userId && p.available !== false).length;
      copy.productCount = count;
    }
    return copy;
  });

  res.json({ ok: true, elements: filtered, total: filtered.length });
});

// GET /api/elements/search — search elements by text query
app.get('/api/elements/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ ok: true, elements: [], total: 0 });

  const active = elements.elements.filter(e => e.active !== false && e.type === 'seller');
  const scored = [];

  // Extract unique cities for city-level search results
  const cityMap = {};

  for (const e of active) {
    // Filter out suspended sellers
    if (e.metadata && e.metadata.userId) {
      const seller = users.users.find(u => u.id === e.metadata.userId);
      if (seller && seller.status === 'suspended') continue;
    }

    // Track cities
    const city = (e.subtitle || '').trim();
    if (city) {
      if (!cityMap[city]) cityMap[city] = { name: city, count: 0, lat: e.lat, lng: e.lng };
      cityMap[city].count++;
    }

    let score = 0;
    const title = (e.title || '').toLowerCase();
    const subtitle = (e.subtitle || '').toLowerCase();
    const description = (e.description || '').toLowerCase();
    const address = (e.address || '').toLowerCase();
    const cuisine = (e.cuisineType || '').toLowerCase();
    const tagsStr = Array.isArray(e.tags) ? e.tags.join(' ').toLowerCase() : (e.tags || '').toLowerCase();

    // Exact title match gets highest score
    if (title === q) score += 100;
    else if (title.startsWith(q)) score += 60;
    else if (title.includes(q)) score += 40;

    if (subtitle.includes(q)) score += 20;
    if (description.includes(q)) score += 15;
    if (address.includes(q)) score += 25;
    if (cuisine.includes(q)) score += 30;
    if (tagsStr.includes(q)) score += 25;

    // Also search products for this seller
    if (e.metadata && e.metadata.userId) {
      const sellerProducts = products.products.filter(p => p.sellerId === e.metadata.userId && p.available !== false);
      for (const p of sellerProducts) {
        if ((p.name || '').toLowerCase().includes(q)) { score += 20; break; }
        if ((p.description || '').toLowerCase().includes(q)) { score += 10; break; }
      }
    }

    if (score > 0) {
      const copy = { ...e };
      if (e.metadata && e.metadata.userId) {
        copy.productCount = products.products.filter(p => p.sellerId === e.metadata.userId && p.available !== false).length;
      }
      scored.push({ el: copy, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, 20).map(s => s.el);

  // Find matching cities
  const matchedCities = Object.values(cityMap)
    .filter(c => c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === q ? 1 : 0;
      const bExact = b.name.toLowerCase() === q ? 1 : 0;
      return bExact - aExact || b.count - a.count;
    })
    .slice(0, 5);

  res.json({ ok: true, elements: results, cities: matchedCities, total: results.length });
});

// GET /api/elements/:id
app.get('/api/elements/:id', (req, res) => {
  const el = elements.elements.find(e => e.id === req.params.id);
  if (!el) return res.status(404).json({ ok: false, error: 'Not found.' });

  let result = { ...el };

  if (el.metadata && el.metadata.userId) {
    result.products = products.products.filter(p => p.sellerId === el.metadata.userId && p.available !== false);
  }

  // Include external order URL if present
  if (el.externalOrderUrl) {
    result.externalOrderUrl = el.externalOrderUrl;
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
  if (!platformSettings.enableMessaging) return res.status(403).json({ ok: false, error: 'Messaging is disabled.' });
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
//  RATINGS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/ratings — buyer rates a completed order
app.post('/api/ratings', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  if (!platformSettings.enableRatings) return res.status(403).json({ ok: false, error: 'Ratings are disabled.' });

  const { orderId, rating, comment } = req.body;
  if (!orderId || !rating) return res.status(400).json({ ok: false, error: 'orderId and rating required.' });

  const ratingVal = parseInt(rating);
  if (ratingVal < 1 || ratingVal > 5) return res.status(400).json({ ok: false, error: 'Rating must be 1-5.' });

  const order = orders.orders.find(o => o.id === orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });
  if (order.buyerId !== user.id) return res.status(403).json({ ok: false, error: 'Only the buyer can rate this order.' });
  if (order.status !== 'completed') return res.status(400).json({ ok: false, error: 'Can only rate completed orders.' });

  // Check for existing rating on this order
  const existing = ratings.ratings.find(r => r.orderId === orderId);
  if (existing) return res.status(400).json({ ok: false, error: 'You already rated this order.' });

  const ratingObj = {
    id: 'rat_' + crypto.randomBytes(8).toString('hex'),
    orderId: order.id,
    buyerId: user.id,
    buyerName: user.name,
    sellerId: order.sellerId,
    rating: ratingVal,
    comment: String(comment || '').slice(0, 1000),
    createdAt: new Date().toISOString()
  };

  ratings.ratings.push(ratingObj);
  saveData('ratings', ratings);
  res.json({ ok: true, rating: ratingObj });
});

// GET /api/ratings?sellerId= — get ratings for a seller
app.get('/api/ratings', (req, res) => {
  const { sellerId } = req.query;
  if (!sellerId) return res.status(400).json({ ok: false, error: 'sellerId required.' });

  const sellerRatings = ratings.ratings
    .filter(r => r.sellerId === sellerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, ratings: sellerRatings });
});

// GET /api/ratings/summary?sellerId= — rating summary for a seller
app.get('/api/ratings/summary', (req, res) => {
  const { sellerId } = req.query;
  if (!sellerId) return res.status(400).json({ ok: false, error: 'sellerId required.' });

  const sellerRatings = ratings.ratings.filter(r => r.sellerId === sellerId);
  const count = sellerRatings.length;

  if (count === 0) {
    return res.json({ ok: true, average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  }

  const sum = sellerRatings.reduce((acc, r) => acc + r.rating, 0);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  sellerRatings.forEach(r => { distribution[r.rating]++; });

  res.json({
    ok: true,
    average: Math.round((sum / count) * 10) / 10,
    count,
    distribution
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SELLER DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/seller/dashboard
app.get('/api/seller/dashboard', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const sellerOrders = orders.orders.filter(o => o.sellerId === user.id);
  const completedOrders = sellerOrders.filter(o => o.status === 'completed');
  const pendingOrders = sellerOrders.filter(o => ['pending', 'paid', 'confirmed'].includes(o.status));
  const totalRevenue = completedOrders.reduce((sum, o) => sum + o.amount, 0);

  const sellerRatings = ratings.ratings.filter(r => r.sellerId === user.id);
  const avgRating = sellerRatings.length > 0
    ? Math.round((sellerRatings.reduce((sum, r) => sum + r.rating, 0) / sellerRatings.length) * 10) / 10
    : 0;

  const sellerProducts = products.products.filter(p => p.sellerId === user.id);

  const effectiveCommission = user.commissionOverride !== null && user.commissionOverride !== undefined ? user.commissionOverride : platformSettings.commissionRate;

  res.json({
    ok: true,
    totalRevenue,
    totalOrders: sellerOrders.length,
    pendingOrders: pendingOrders.length,
    completedOrders: completedOrders.length,
    averageRating: avgRating,
    totalRatings: sellerRatings.length,
    products: sellerProducts,
    commissionRate: effectiveCommission
  });
});

// GET /api/seller/payouts
app.get('/api/seller/payouts', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const sellerPayouts = payouts.payouts
    .filter(p => p.sellerId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, payouts: sellerPayouts });
});

// PUT /api/seller/tax-info
app.put('/api/seller/tax-info', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });

  const { businessName, ein, ssnLast4, address, city, state, zip } = req.body;
  user.taxInfo = {
    businessName: String(businessName || '').slice(0, 200),
    ein: String(ein || '').slice(0, 20),
    ssnLast4: String(ssnLast4 || '').slice(0, 4),
    address: String(address || '').slice(0, 300),
    city: String(city || '').slice(0, 100),
    state: String(state || '').slice(0, 2),
    zip: String(zip || '').slice(0, 10)
  };

  saveData('users', users);
  res.json({ ok: true, taxInfo: user.taxInfo });
});

// GET /api/seller/tax-info
app.get('/api/seller/tax-info', (req, res) => {
  const user = getSession(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
  res.json({ ok: true, taxInfo: user.taxInfo || null });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN AUTH
// ═════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== platformSettings.adminPassword) {
    return res.status(401).json({ ok: false, error: 'Invalid password.' });
  }
  const token = 'adm_' + crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  const expires = new Date(Date.now() + 7 * 86400000).toUTCString();
  res.setHeader('Set-Cookie', `kinseb_admin=${token}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith('kinseb_admin='));
  if (cookie) adminTokens.delete(cookie.split('=')[1].trim());
  res.setHeader('Set-Cookie', 'kinseb_admin=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN API
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/dashboard
app.get('/api/admin/dashboard', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  // Total sellers = users with at least 1 product
  const sellerIds = new Set(products.products.map(p => p.sellerId));
  const totalSellers = sellerIds.size;

  // Total buyers = users who placed at least 1 order
  const buyerIds = new Set(orders.orders.map(o => o.buyerId));
  const totalBuyers = buyerIds.size;

  const totalOrders = orders.orders.length;
  const totalRevenue = orders.orders
    .filter(o => ['completed', 'paid', 'confirmed'].includes(o.status))
    .reduce((sum, o) => sum + o.amount, 0);

  const recentOrders = orders.orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  // Pending payout amounts per seller (completed orders not yet paid out)
  const pendingPayouts = {};
  orders.orders
    .filter(o => o.status === 'completed' && !o.paidOut)
    .forEach(o => {
      if (!pendingPayouts[o.sellerId]) {
        pendingPayouts[o.sellerId] = { sellerId: o.sellerId, sellerName: o.sellerName, amount: 0, orderCount: 0 };
      }
      pendingPayouts[o.sellerId].amount += o.amount;
      pendingPayouts[o.sellerId].orderCount++;
    });

  res.json({
    ok: true,
    totalSellers,
    totalBuyers,
    totalOrders,
    totalRevenue,
    recentOrders,
    pendingPayouts: Object.values(pendingPayouts)
  });
});

// GET /api/admin/sellers
app.get('/api/admin/sellers', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const sellerIds = new Set(products.products.map(p => p.sellerId));
  const sellerList = users.users
    .filter(u => sellerIds.has(u.id))
    .map(u => {
      const userProducts = products.products.filter(p => p.sellerId === u.id);
      const userOrders = orders.orders.filter(o => o.sellerId === u.id);
      const completedOrders = userOrders.filter(o => o.status === 'completed');
      const revenue = completedOrders.reduce((sum, o) => sum + o.amount, 0);
      const userRatings = ratings.ratings.filter(r => r.sellerId === u.id);
      const avgRating = userRatings.length > 0
        ? Math.round((userRatings.reduce((s, r) => s + r.rating, 0) / userRatings.length) * 10) / 10
        : 0;

      return {
        id: u.id,
        name: u.name,
        displayName: (u.profile && u.profile.displayName) || u.name,
        email: u.email,
        phone: u.phone,
        status: u.status || 'active',
        commissionOverride: u.commissionOverride != null ? u.commissionOverride : null,
        productsCount: userProducts.length,
        ordersCount: userOrders.length,
        revenue,
        rating: avgRating,
        ratingsCount: userRatings.length,
        permitType: (u.profile && u.profile.permitType) || null,
        permitNumber: (u.profile && u.profile.permitNumber) || null,
        createdAt: u.createdAt
      };
    });

  res.json({ ok: true, sellers: sellerList });
});

// GET /api/admin/buyers
app.get('/api/admin/buyers', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const buyerMap = {};
  orders.orders.forEach(o => {
    if (!buyerMap[o.buyerId]) {
      buyerMap[o.buyerId] = { buyerId: o.buyerId, buyerName: o.buyerName, orderCount: 0, totalSpent: 0 };
    }
    buyerMap[o.buyerId].orderCount++;
    if (['completed', 'paid', 'confirmed'].includes(o.status)) {
      buyerMap[o.buyerId].totalSpent += o.amount;
    }
  });

  const buyerList = Object.values(buyerMap).map(b => {
    const user = users.users.find(u => u.id === b.buyerId);
    return {
      ...b,
      email: user ? user.email : null,
      phone: user ? user.phone : null,
      createdAt: user ? user.createdAt : null
    };
  });

  res.json({ ok: true, buyers: buyerList });
});

// GET /api/admin/orders
app.get('/api/admin/orders', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  let filtered = [...orders.orders];
  if (req.query.status) {
    filtered = filtered.filter(o => o.status === req.query.status);
  }
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, orders: filtered });
});

// PUT /api/admin/sellers/:id/status
app.put('/api/admin/sellers/:id/status', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const user = users.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });

  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ ok: false, error: 'Status must be "active" or "suspended".' });
  }

  user.status = status;
  saveData('users', users);
  res.json({ ok: true, id: user.id, status: user.status });
});

// PUT /api/admin/sellers/:id/commission — set per-seller commission override
app.put('/api/admin/sellers/:id/commission', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const user = users.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });

  const { rate } = req.body;
  if (rate === null || rate === undefined) {
    user.commissionOverride = null;
  } else {
    const parsed = parseFloat(rate);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      return res.status(400).json({ ok: false, error: 'Rate must be between 0 and 100.' });
    }
    user.commissionOverride = parsed;
  }

  saveData('users', users);
  res.json({ ok: true, id: user.id, commissionOverride: user.commissionOverride });
});

// GET /api/admin/settings
app.get('/api/admin/settings', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });
  res.json({ ok: true, settings: platformSettings });
});

// PUT /api/admin/settings
app.put('/api/admin/settings', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const updates = req.body;
  // Partial merge — only update keys that are provided
  for (const key of Object.keys(updates)) {
    if (key in platformSettings) {
      platformSettings[key] = updates[key];
    }
  }
  saveData('platform_settings', platformSettings);
  res.json({ ok: true, settings: platformSettings });
});

// GET /api/admin/payouts
app.get('/api/admin/payouts', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const allPayouts = [...payouts.payouts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, payouts: allPayouts });
});

// POST /api/admin/payouts/:sellerId/process
app.post('/api/admin/payouts/:sellerId/process', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const sellerId = req.params.sellerId;
  const seller = users.users.find(u => u.id === sellerId);
  if (!seller) return res.status(404).json({ ok: false, error: 'Seller not found.' });

  // Find all completed orders not yet paid out for this seller
  const eligibleOrders = orders.orders.filter(o => o.sellerId === sellerId && o.status === 'completed' && !o.paidOut);
  if (eligibleOrders.length === 0) {
    return res.status(400).json({ ok: false, error: 'No eligible orders to pay out.' });
  }

  const totalAmount = eligibleOrders.reduce((sum, o) => sum + o.amount, 0);
  const rate = seller.commissionOverride !== null && seller.commissionOverride !== undefined ? seller.commissionOverride : platformSettings.commissionRate;
  const commissionRate = rate || 20;
  const commission = Math.round(totalAmount * (commissionRate / 100));
  const netAmount = totalAmount - commission;

  if (netAmount < (platformSettings.minPayoutAmount || 2500)) {
    return res.status(400).json({ ok: false, error: `Net payout ($${(netAmount / 100).toFixed(2)}) is below minimum ($${((platformSettings.minPayoutAmount || 2500) / 100).toFixed(2)}).` });
  }

  const payout = {
    id: 'pay_' + crypto.randomBytes(8).toString('hex'),
    sellerId,
    sellerName: (seller.profile && seller.profile.displayName) || seller.name,
    amount: totalAmount,
    commission,
    netAmount,
    orderIds: eligibleOrders.map(o => o.id),
    method: 'manual',
    status: 'processed',
    processedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };

  // Mark orders as paid out
  eligibleOrders.forEach(o => { o.paidOut = true; });
  saveData('orders', orders);

  payouts.payouts.push(payout);
  saveData('payouts', payouts);

  res.json({ ok: true, payout });
});

// GET /api/admin/ratings
app.get('/api/admin/ratings', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const allRatings = [...ratings.ratings].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, ratings: allRatings });
});

// DELETE /api/admin/ratings/:id
app.delete('/api/admin/ratings/:id', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const idx = ratings.ratings.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Rating not found.' });

  ratings.ratings.splice(idx, 1);
  saveData('ratings', ratings);
  res.json({ ok: true });
});

// GET /api/admin/elements — return elements with real (non-fuzzy) locations
app.get('/api/admin/elements', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });
  res.json({ ok: true, elements: elements.elements });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN PROSPECTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/prospects — list all prospects, with ?status= filter
app.get('/api/admin/prospects', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  let filtered = [...prospects.prospects];
  if (req.query.status) {
    filtered = filtered.filter(p => p.status === req.query.status);
  }
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({ ok: true, prospects: filtered });
});

// POST /api/admin/prospects — manually add a prospect
app.post('/api/admin/prospects', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { name, businessName, address, neighborhood, phone, email, website, instagram, products: prodList, permitType, permitNumber, source, sourceUrl, notes } = req.body;
  if (!name && !businessName) return res.status(400).json({ ok: false, error: 'Name or business name required.' });

  const prospect = {
    id: 'pros_' + crypto.randomBytes(8).toString('hex'),
    name: String(name || '').slice(0, 200),
    businessName: String(businessName || '').slice(0, 200),
    address: String(address || '').slice(0, 500),
    neighborhood: String(neighborhood || '').slice(0, 100),
    phone: String(phone || '').slice(0, 30),
    email: String(email || '').slice(0, 200),
    website: String(website || '').slice(0, 500),
    instagram: String(instagram || '').slice(0, 100),
    products: Array.isArray(prodList) ? prodList.map(p => String(p).slice(0, 200)) : [],
    permitType: String(permitType || '').slice(0, 50),
    permitNumber: String(permitNumber || '').slice(0, 100),
    source: String(source || 'manual').slice(0, 100),
    sourceUrl: String(sourceUrl || '').slice(0, 500),
    notes: String(notes || '').slice(0, 2000),
    status: 'prospect',
    featured: false,
    scrapedAt: null,
    createdAt: new Date().toISOString(),
    convertedAt: null,
    convertedUserId: null
  };

  prospects.prospects.push(prospect);
  saveData('prospects', prospects);
  res.json({ ok: true, prospect });
});

// PUT /api/admin/prospects/:id — update prospect details
app.put('/api/admin/prospects/:id', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const prospect = prospects.prospects.find(p => p.id === req.params.id);
  if (!prospect) return res.status(404).json({ ok: false, error: 'Prospect not found.' });

  const fields = ['name', 'businessName', 'address', 'neighborhood', 'phone', 'email', 'website', 'instagram', 'permitType', 'permitNumber', 'source', 'sourceUrl', 'notes'];
  fields.forEach(f => {
    if (req.body[f] !== undefined) prospect[f] = String(req.body[f]);
  });
  if (req.body.products !== undefined) {
    prospect.products = Array.isArray(req.body.products) ? req.body.products.map(p => String(p).slice(0, 200)) : [];
  }
  if (req.body.featured !== undefined) prospect.featured = !!req.body.featured;

  saveData('prospects', prospects);
  res.json({ ok: true, prospect });
});

// DELETE /api/admin/prospects/:id — delete prospect
app.delete('/api/admin/prospects/:id', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const idx = prospects.prospects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Prospect not found.' });

  prospects.prospects.splice(idx, 1);
  saveData('prospects', prospects);
  res.json({ ok: true });
});

// PUT /api/admin/prospects/:id/status — change status
app.put('/api/admin/prospects/:id/status', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const prospect = prospects.prospects.find(p => p.id === req.params.id);
  if (!prospect) return res.status(404).json({ ok: false, error: 'Prospect not found.' });

  const { status } = req.body;
  const validStatuses = ['prospect', 'approved', 'contacted', 'rejected', 'converted'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') });
  }

  prospect.status = status;
  saveData('prospects', prospects);
  res.json({ ok: true, prospect });
});

// POST /api/admin/prospects/:id/make-live — convert prospect to live listing
app.post('/api/admin/prospects/:id/make-live', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const prospect = prospects.prospects.find(p => p.id === req.params.id);
  if (!prospect) return res.status(404).json({ ok: false, error: 'Prospect not found.' });

  if (prospect.status === 'rejected') {
    return res.status(400).json({ ok: false, error: 'Cannot make a rejected prospect live. Change status first.' });
  }

  const { lat, lng, useExternalUrl } = req.body;
  if (lat == null || lng == null) {
    return res.status(400).json({ ok: false, error: 'Latitude and longitude required to place on map.' });
  }

  // Create a user entry for the prospect
  const userId = 'user_' + crypto.randomBytes(8).toString('hex');
  const user = makeUser({
    id: userId,
    name: prospect.businessName || prospect.name,
    email: prospect.email || null,
    phone: prospect.phone || null,
    phoneVerified: false,
    profile: {
      displayName: prospect.businessName || prospect.name,
      bio: prospect.notes || '',
      photos: [],
      location: { lat: parseFloat(lat), lng: parseFloat(lng), address: prospect.address },
      permitType: prospect.permitType || null,
      permitNumber: prospect.permitNumber || null
    }
  });
  users.users.push(user);
  saveData('users', users);

  // Create a map element at their location
  const el = {
    id: 'el_' + crypto.randomBytes(8).toString('hex'),
    type: 'seller',
    title: prospect.businessName || prospect.name,
    subtitle: prospect.neighborhood || '',
    description: prospect.notes || '',
    imageUrl: prospect.imageUrl || '',
    icon: '🏪',
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    ownerId: userId,
    metadata: { userId, prospectId: prospect.id },
    online: true,
    active: true,
    cuisineType: prospect.cuisineType || '',
    tags: prospect.tags || '',
    email: prospect.email || '',
    phone: prospect.phone || '',
    instagram: prospect.instagram || '',
    address: prospect.address || '',
    createdAt: new Date().toISOString()
  };

  // Set external order URL if they have a website and useExternalUrl is true
  if (useExternalUrl !== false && prospect.website) {
    el.externalOrderUrl = prospect.website;
  }

  elements.elements.push(el);
  saveData('elements', elements);

  // Create product entries from their product list
  if (prospect.products && prospect.products.length > 0) {
    prospect.products.forEach(prodName => {
      products.products.push({
        id: 'prod_' + crypto.randomBytes(8).toString('hex'),
        sellerId: userId,
        sellerName: prospect.businessName || prospect.name,
        name: String(prodName),
        description: '',
        price: 0, // Price unknown for scraped products
        category: 'other',
        allergens: [],
        madeInHomeKitchen: true,
        photos: [],
        available: true,
        createdAt: new Date().toISOString()
      });
    });
    saveData('products', products);
  }

  // Update prospect status
  prospect.status = 'approved';
  prospect.convertedAt = new Date().toISOString();
  prospect.convertedUserId = userId;
  saveData('prospects', prospects);

  res.json({ ok: true, prospect, userId, elementId: el.id });
});

// POST /api/admin/prospects/import — bulk import array of prospects
app.post('/api/admin/prospects/import', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'items array required.' });
  }

  const imported = [];
  items.forEach(item => {
    const prospect = {
      id: 'pros_' + crypto.randomBytes(8).toString('hex'),
      name: String(item.name || '').slice(0, 200),
      businessName: String(item.businessName || item.name || '').slice(0, 200),
      address: String(item.address || '').slice(0, 500),
      neighborhood: String(item.neighborhood || '').slice(0, 100),
      phone: String(item.phone || '').slice(0, 30),
      email: String(item.email || '').slice(0, 200),
      website: String(item.website || '').slice(0, 500),
      instagram: String(item.instagram || '').slice(0, 100),
      products: Array.isArray(item.products) ? item.products.map(p => String(p).slice(0, 200)) : (typeof item.products === 'string' ? item.products.split(',').map(p => p.trim()).filter(Boolean) : []),
      permitType: String(item.permitType || '').slice(0, 50),
      permitNumber: String(item.permitNumber || '').slice(0, 100),
      source: String(item.source || 'import').slice(0, 100),
      sourceUrl: String(item.sourceUrl || '').slice(0, 500),
      notes: String(item.notes || '').slice(0, 2000),
      status: 'prospect',
      featured: false,
      scrapedAt: item.scrapedAt || null,
      createdAt: new Date().toISOString(),
      convertedAt: null,
      convertedUserId: null
    };
    prospects.prospects.push(prospect);
    imported.push(prospect);
  });

  saveData('prospects', prospects);
  res.json({ ok: true, imported: imported.length, prospects: imported });
});

// POST /api/admin/prospects/scrape — trigger live scraping
app.post('/api/admin/prospects/scrape', async (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { source, url, query, autoImport } = req.body;

  try {
    const result = await scrapeAll({ source: source || 'all', url, query });

    // Auto-import into prospects list if requested (default: true)
    if (autoImport !== false && result.prospects.length > 0) {
      const existingNames = new Set(prospects.prospects.map(p => (p.businessName || p.name || '').toLowerCase()));
      let imported = 0;
      for (const p of result.prospects) {
        const key = (p.businessName || p.name || '').toLowerCase();
        if (!existingNames.has(key)) {
          prospects.prospects.push(p);
          existingNames.add(key);
          imported++;
        }
      }
      if (imported > 0) saveData('prospects', prospects);
      result.imported = imported;
      result.skippedDuplicates = result.prospects.length - imported;
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/prospects/bulk-make-live — convert multiple prospects to live listings
app.post('/api/admin/prospects/bulk-make-live', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { ids } = req.body;

  // If ids provided, use those; otherwise grab all prospects that have lat/lng
  let targetProspects;
  if (Array.isArray(ids) && ids.length > 0) {
    targetProspects = prospects.prospects.filter(p => ids.includes(p.id));
  } else {
    targetProspects = prospects.prospects.filter(p => p.lat != null && p.lng != null);
  }

  let converted = 0;
  const results = [];

  for (const prospect of targetProspects) {
    // Skip already converted
    if (prospect.convertedUserId || prospect.status === 'approved') {
      results.push({ id: prospect.id, skipped: true, reason: 'already converted' });
      continue;
    }

    // Skip rejected
    if (prospect.status === 'rejected') {
      results.push({ id: prospect.id, skipped: true, reason: 'rejected' });
      continue;
    }

    // Must have lat/lng (from scraper data on the prospect itself)
    if (prospect.lat == null || prospect.lng == null) {
      results.push({ id: prospect.id, skipped: true, reason: 'no coordinates' });
      continue;
    }

    // Create user
    const userId = 'user_' + crypto.randomBytes(8).toString('hex');
    const user = makeUser({
      id: userId,
      name: prospect.businessName || prospect.name,
      email: prospect.email || null,
      phone: prospect.phone || null,
      phoneVerified: false,
      profile: {
        displayName: prospect.businessName || prospect.name,
        bio: prospect.notes || '',
        photos: [],
        location: { lat: parseFloat(prospect.lat), lng: parseFloat(prospect.lng), address: prospect.address },
        permitType: prospect.permitType || null,
        permitNumber: prospect.permitNumber || null
      }
    });
    users.users.push(user);

    // Create map element
    const el = {
      id: 'el_' + crypto.randomBytes(8).toString('hex'),
      type: 'seller',
      title: prospect.businessName || prospect.name,
      subtitle: prospect.neighborhood || '',
      description: prospect.notes || '',
      imageUrl: prospect.imageUrl || '',
      icon: '🏪',
      lat: parseFloat(prospect.lat),
      lng: parseFloat(prospect.lng),
      ownerId: userId,
      metadata: { userId, prospectId: prospect.id },
      online: true,
      active: true,
      cuisineType: prospect.cuisineType || '',
      tags: prospect.tags || '',
      email: prospect.email || '',
      phone: prospect.phone || '',
      instagram: prospect.instagram || '',
      address: prospect.address || '',
      createdAt: new Date().toISOString()
    };

    // Use external URL if prospect has a website
    if (prospect.website) {
      el.externalOrderUrl = prospect.website;
    }

    elements.elements.push(el);

    // Create products
    if (prospect.products && prospect.products.length > 0) {
      prospect.products.forEach(prodName => {
        products.products.push({
          id: 'prod_' + crypto.randomBytes(8).toString('hex'),
          sellerId: userId,
          sellerName: prospect.businessName || prospect.name,
          name: String(prodName),
          description: '',
          price: 0,
          category: 'other',
          allergens: [],
          madeInHomeKitchen: true,
          photos: [],
          available: true,
          createdAt: new Date().toISOString()
        });
      });
    }

    // Update prospect status
    prospect.status = 'approved';
    prospect.convertedAt = new Date().toISOString();
    prospect.convertedUserId = userId;

    converted++;
    results.push({ id: prospect.id, userId, elementId: el.id, converted: true });
  }

  // Save all at once
  if (converted > 0) {
    saveData('users', users);
    saveData('elements', elements);
    saveData('products', products);
    saveData('prospects', prospects);
  }

  res.json({ ok: true, converted, total: targetProspects.length, results });
});

// POST /api/admin/elements/bulk-remove — soft-delete elements (set active=false)
app.post('/api/admin/elements/bulk-remove', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids array required.' });
  }

  let removed = 0;
  for (const id of ids) {
    const el = elements.elements.find(e => e.id === id);
    if (el && el.active !== false) {
      el.active = false;
      removed++;
    }
  }

  if (removed > 0) saveData('elements', elements);
  res.json({ ok: true, removed, requested: ids.length });
});

// POST /api/admin/elements/bulk-restore — restore soft-deleted elements (set active=true)
app.post('/api/admin/elements/bulk-restore', (req, res) => {
  if (!getAdminSession(req)) return res.status(401).json({ ok: false, error: 'Admin login required.' });

  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'ids array required.' });
  }

  let restored = 0;
  for (const id of ids) {
    const el = elements.elements.find(e => e.id === id);
    if (el && el.active === false) {
      el.active = true;
      restored++;
    }
  }

  if (restored > 0) saveData('elements', elements);
  res.json({ ok: true, restored, requested: ids.length });
});

// ═════════════════════════════════════════════════════════════════════════════
//  SEED
// ═════════════════════════════════════════════════════════════════════════════
function seedDefaults() {
  if (elements.elements.length > 0) return;

  const sellers = [
    {
      name: "Maria's Cocina", bio: "Third-generation recipes from Oaxaca. Conchas, empanadas, and tamales baked fresh every morning.",
      lat: 34.0869, lng: -118.2627, address: "Silver Lake, LA", permitType: "Class A", permitNumber: "CFO-LA-2024-1847",
      products: [
        { name: "Conchas (6-pack)", price: 900, category: "bread", description: "Traditional Mexican sweet bread with colorful sugar shell topping. Vanilla and chocolate flavors.", allergens: ["wheat", "eggs", "milk"] },
        { name: "Empanadas (4-pack)", price: 1400, category: "pastry", description: "Flaky hand pies filled with sweet pumpkin or apple. Family recipe.", allergens: ["wheat", "milk"] },
        { name: "Tamales (6-pack)", price: 1800, category: "pastry", description: "Sweet tamales with raisins and cinnamon, wrapped in corn husks.", allergens: ["wheat"] }
      ]
    },
    {
      name: "Golden Crust Bread Co.", bio: "Artisan sourdough baked fresh daily. Organic flour, wild-caught yeast, 48-hour ferment. Pickup in Los Feliz.",
      lat: 34.1065, lng: -118.2810, address: "Los Feliz, LA", permitType: "Class A", permitNumber: "CFO-LA-2024-2103",
      products: [
        { name: "Sourdough Loaf", price: 900, category: "bread", description: "Classic tangy sourdough with crispy crust. 48-hour cold ferment with organic flour.", allergens: ["wheat"] },
        { name: "Focaccia Slab", price: 800, category: "bread", description: "Olive oil focaccia with rosemary and sea salt. Perfect for sandwiches.", allergens: ["wheat"] },
        { name: "Cinnamon Rolls (4-pack)", price: 1200, category: "pastry", description: "Soft, gooey cinnamon rolls with cream cheese frosting.", allergens: ["wheat", "eggs", "milk"] }
      ]
    },
    {
      name: "Sweet Spot LA", bio: "Cookies, brownies, and sweet treats made with love in Echo Park. All butter, real vanilla, no shortcuts.",
      lat: 34.0781, lng: -118.2606, address: "Echo Park, LA", permitType: "Class A", permitNumber: "CFO-LA-2025-0312",
      products: [
        { name: "Cookie Box (12)", price: 1500, category: "cookie", description: "Assorted cookies: chocolate chip, snickerdoodle, oatmeal raisin, double chocolate.", allergens: ["wheat", "eggs", "milk", "soy"] },
        { name: "Fudge Brownies (6)", price: 1200, category: "cookie", description: "Dense, fudgy brownies with a crackly top. Made with Belgian chocolate.", allergens: ["wheat", "eggs", "milk", "soy"] },
        { name: "Cake Pops (6)", price: 1000, category: "candy", description: "Moist cake pops dipped in chocolate. Assorted flavors.", allergens: ["wheat", "eggs", "milk", "soy"] }
      ]
    },
    {
      name: "Jam Session", bio: "Small-batch jams & preserves from California-grown fruit. No pectin, just fruit, sugar, and time. Highland Park.",
      lat: 34.1097, lng: -118.1920, address: "Highland Park, LA", permitType: "Class A", permitNumber: "CFO-LA-2024-0987",
      products: [
        { name: "Strawberry Jam (8oz)", price: 800, category: "jam", description: "Made with Oxnard strawberries at peak ripeness. Classic and bright.", allergens: [] },
        { name: "Meyer Lemon Marmalade (8oz)", price: 900, category: "jam", description: "Bittersweet citrus marmalade from backyard Meyer lemons.", allergens: [] },
        { name: "Fig Preserves (8oz)", price: 1000, category: "jam", description: "Mission figs slow-cooked with vanilla bean and a splash of port.", allergens: [] }
      ]
    },
    {
      name: "The Honey Jar", bio: "Local LA honey from our own hives + handmade granola. Sustainable beekeeping in Atwater Village since 2020.",
      lat: 34.1172, lng: -118.2587, address: "Atwater Village, LA", permitType: "Class A", permitNumber: "CFO-LA-2024-1502",
      products: [
        { name: "Raw Wildflower Honey (12oz)", price: 1400, category: "honey", description: "Unfiltered, raw honey from our LA hives. Floral and complex.", allergens: [] },
        { name: "Honey Granola (12oz)", price: 800, category: "snack", description: "Oats, almonds, and local honey, slow-baked until crunchy.", allergens: ["wheat", "tree nuts", "milk"] },
        { name: "Honeycomb (6oz)", price: 1800, category: "honey", description: "Cut-comb honey straight from the hive. Drizzle on toast or cheese.", allergens: [] }
      ]
    },
    {
      name: "Churro Queen", bio: "Fresh churros and dulces from my Boyle Heights kitchen. Weekend pop-ups and pre-orders. East LA pride.",
      lat: 34.0340, lng: -118.2116, address: "Boyle Heights, LA", permitType: "Class A", permitNumber: "CFO-LA-2025-0088",
      products: [
        { name: "Churros (6-pack)", price: 800, category: "pastry", description: "Crispy, cinnamon-sugar churros. Plain or filled with cajeta.", allergens: ["wheat", "eggs", "milk"] },
        { name: "Cajeta Fudge (8oz)", price: 600, category: "candy", description: "Creamy goat milk caramel fudge. Cuts into 12 pieces.", allergens: ["milk"] },
        { name: "Mexican Hot Cocoa Mix (8oz)", price: 1000, category: "snack", description: "Spiced chocolate mix with cinnamon and chili. Just add hot milk.", allergens: ["milk", "soy"] }
      ]
    },
    {
      name: "Cake Pop Studio", bio: "Custom cake pops, cupcakes & decorated sugar cookies for every occasion. Pasadena pickup or local delivery.",
      lat: 34.1478, lng: -118.1445, address: "Pasadena, LA", permitType: "Class B", permitNumber: "CFO-LA-2024-3201",
      products: [
        { name: "Custom Cake Pops (12)", price: 2400, category: "candy", description: "Beautifully decorated cake pops in your choice of flavors and colors.", allergens: ["wheat", "eggs", "milk", "soy"] },
        { name: "Cupcakes (6-pack)", price: 1800, category: "pastry", description: "Moist cupcakes with buttercream frosting. Flavors rotate weekly.", allergens: ["wheat", "eggs", "milk"] },
        { name: "Decorated Sugar Cookies (12)", price: 2000, category: "cookie", description: "Royal icing decorated sugar cookies. Custom shapes available.", allergens: ["wheat", "eggs", "milk"] }
      ]
    },
    {
      name: "LA Crumbs", bio: "Korean-inspired baked goods in Koreatown. Matcha, red bean, black sesame — East meets West in every bite.",
      lat: 34.0579, lng: -118.3004, address: "Koreatown, LA", permitType: "Class A", permitNumber: "CFO-LA-2025-0445",
      products: [
        { name: "Matcha Cookies (8)", price: 1200, category: "cookie", description: "Chewy white chocolate matcha cookies with ceremonial-grade matcha.", allergens: ["wheat", "eggs", "milk", "soy"] },
        { name: "Red Bean Mochi Cake", price: 1500, category: "pastry", description: "Glutinous rice cake with sweet red bean filling. Chewy and not too sweet.", allergens: ["eggs", "milk"] },
        { name: "Black Sesame Brittle (6oz)", price: 700, category: "candy", description: "Crunchy caramelized brittle loaded with toasted black sesame.", allergens: ["soy"] }
      ]
    },
    {
      name: "Pasta Fresca LA", bio: "Handmade fresh pasta from my Little Tokyo kitchen. Semolina and egg doughs, cut to order. Weekend pickups.",
      lat: 34.0500, lng: -118.2400, address: "Little Tokyo, LA", permitType: "Class A", permitNumber: "CFO-LA-2024-2788",
      products: [
        { name: "Fresh Fettuccine (1lb)", price: 800, category: "pasta", description: "Classic egg fettuccine, hand-rolled and cut. Cooks in 3 minutes.", allergens: ["wheat", "eggs"] },
        { name: "Pappardelle (1lb)", price: 900, category: "pasta", description: "Wide ribbon pasta, perfect for ragu or brown butter sage.", allergens: ["wheat", "eggs"] },
        { name: "Pasta Sampler Box", price: 2200, category: "pasta", description: "1/2 lb each of fettuccine, pappardelle, tagliatelle, and orecchiette.", allergens: ["wheat", "eggs"] }
      ]
    },
    {
      name: "Nutty Professor", bio: "Small-batch nut butters and roasted nuts. No sugar, no palm oil, no junk. Just nuts. Mid-City LA.",
      lat: 34.0481, lng: -118.3417, address: "Mid-City, LA", permitType: "Class A", permitNumber: "CFO-LA-2025-0199",
      products: [
        { name: "Almond Butter (10oz)", price: 1200, category: "snack", description: "Stone-ground roasted almond butter. Creamy, unsweetened, single-ingredient.", allergens: ["tree nuts"] },
        { name: "Cashew Butter (10oz)", price: 1400, category: "snack", description: "Velvety cashew butter with a hint of sea salt.", allergens: ["tree nuts"] },
        { name: "Spiced Mixed Nuts (8oz)", price: 1000, category: "snack", description: "Almonds, cashews, and pecans with smoked paprika and rosemary.", allergens: ["tree nuts"] }
      ]
    }
  ];

  sellers.forEach((s, i) => {
    const userId = `user_seed_${String(i+1).padStart(3,'0')}`;
    const elId = `el_seed_${String(i+1).padStart(3,'0')}`;

    // Create user
    users.users.push({
      id: userId, name: s.name, email: null, phone: null, googleId: null, phoneVerified: false,
      status: 'active',
      profile: {
        displayName: s.name, bio: s.bio,
        photos: [`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(s.name)}&backgroundColor=7c2d12&textColor=fff`],
        location: { lat: s.lat, lng: s.lng, address: s.address },
        permitType: s.permitType, permitNumber: s.permitNumber
      },
      sessions: [], createdAt: new Date(Date.now() - Math.random() * 90 * 86400000).toISOString()
    });

    // Create map element
    elements.elements.push({
      id: elId, type: 'seller', title: s.name,
      subtitle: s.address,
      description: s.bio,
      imageUrl: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(s.name)}&backgroundColor=7c2d12&textColor=fff`,
      icon: '🍞', lat: s.lat, lng: s.lng,
      ownerId: userId, metadata: { userId },
      online: Math.random() > 0.3, active: true,
      createdAt: new Date(Date.now() - Math.random() * 90 * 86400000).toISOString()
    });

    // Create products
    s.products.forEach((p, j) => {
      products.products.push({
        id: `prod_seed_${String(i+1).padStart(3,'0')}_${j+1}`,
        sellerId: userId, sellerName: s.name,
        name: p.name, description: p.description, price: p.price,
        category: p.category, allergens: p.allergens, madeInHomeKitchen: true,
        photos: [], available: true,
        createdAt: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString()
      });
    });
  });

  saveData('users', users);
  saveData('elements', elements);
  saveData('products', products);
  console.log(`✓ Seeded ${sellers.length} chefs with ${products.products.length} meals`);
}

// seedDefaults(); // Disabled — using real MEHKO data from scraper

// ════════════════════════════════════════════════════════════════════════════
// ── Claude Chat Agent ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let Anthropic = null;
let anthropicClient = null;

if (ANTHROPIC_API_KEY) {
  try {
    Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    console.log('✓ Claude Chat Agent initialized');
  } catch (e) {
    console.log('⚠ Anthropic SDK not available:', e.message);
  }
}

// Chat sessions stored in memory (keyed by session ID)
const chatSessions = {};

const PROJECT_ROOT = __dirname;

// Tools Claude can use to modify the project
const CLAUDE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the project. Use this to understand current code before making changes.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from project root (e.g. "public/map.html", "server.js")' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories in the project. Use to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Relative directory path (e.g. "public", "data"). Defaults to project root.' }
      },
      required: []
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating it if it does not exist or overwriting if it does. Use for creating new files or complete rewrites.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from project root' },
        content: { type: 'string', description: 'The full file content to write' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Replace a specific string in a file with new content. The old_string must match exactly (including whitespace). Use for targeted edits.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path from project root' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'search_code',
    description: 'Search for a pattern across project files. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        file_glob: { type: 'string', description: 'Optional glob to filter files (e.g. "*.js", "public/*.html")' }
      },
      required: ['pattern']
    }
  }
];

// Execute a tool call
function executeTool(name, input) {
  const safePath = (rel) => {
    const resolved = path.resolve(PROJECT_ROOT, rel);
    if (!resolved.startsWith(PROJECT_ROOT)) throw new Error('Path outside project directory');
    return resolved;
  };

  switch (name) {
    case 'read_file': {
      const fp = safePath(input.file_path);
      if (!fs.existsSync(fp)) return { error: `File not found: ${input.file_path}` };
      const stat = fs.statSync(fp);
      if (stat.size > 500000) return { error: 'File too large (>500KB)' };
      return { content: fs.readFileSync(fp, 'utf-8') };
    }
    case 'list_files': {
      const dir = safePath(input.directory || '.');
      if (!fs.existsSync(dir)) return { error: `Directory not found: ${input.directory}` };
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return {
        files: entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
      };
    }
    case 'write_file': {
      const fp = safePath(input.file_path);
      const dir = path.dirname(fp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fp, input.content, 'utf-8');
      return { success: true, message: `Wrote ${input.file_path} (${input.content.length} chars)` };
    }
    case 'edit_file': {
      const fp = safePath(input.file_path);
      if (!fs.existsSync(fp)) return { error: `File not found: ${input.file_path}` };
      let content = fs.readFileSync(fp, 'utf-8');
      if (!content.includes(input.old_string)) return { error: 'old_string not found in file. Read the file first to get the exact text.' };
      content = content.replace(input.old_string, input.new_string);
      fs.writeFileSync(fp, content, 'utf-8');
      return { success: true, message: `Edited ${input.file_path}` };
    }
    case 'search_code': {
      const results = [];
      const glob = input.file_glob || '**';
      const searchDir = (dir, rel) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.join(rel, entry.name);
          if (entry.isDirectory()) {
            searchDir(fullPath, relPath);
          } else if (entry.isFile()) {
            if (input.file_glob && !relPath.match(new RegExp(input.file_glob.replace(/\*/g, '.*')))) continue;
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              lines.forEach((line, i) => {
                if (line.includes(input.pattern)) {
                  results.push({ file: relPath, line: i + 1, text: line.trim() });
                }
              });
            } catch (e) {}
          }
        }
      };
      searchDir(PROJECT_ROOT, '');
      return { matches: results.slice(0, 50) };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const CHAT_SYSTEM_PROMPT = `You are a coding assistant embedded in the Kinseb website. You can read, edit, and create files in this project to modify the website in real time.

The project is a Node.js/Express app with MapLibre GL JS frontend — Kinseb is a curated platform for discovering and ordering meals from home chefs.
Key files:
- server.js — Express backend (API routes, auth, data management)
- public/map.html — Main map page (full SPA with markers, profiles, messaging)
- public/profile.html — Profile page
- public/admin.html — Admin dashboard
- public/seller.html — Seller dashboard
- config.json — Service configuration
- data/ — JSON data files (elements, users, products, etc.)

When the user asks for changes:
1. Read the relevant file(s) first to understand the current code
2. Make targeted edits (prefer edit_file over write_file for existing files)
3. Explain what you changed briefly

The changes take effect immediately — the site serves files directly from disk. For server.js changes, note that a server restart may be needed.

Keep responses concise. Focus on making the requested changes.`;

// POST /api/chat — send a message in a chat session
app.post('/api/chat', async (req, res) => {
  console.log('[chat] Request received:', JSON.stringify(req.body).slice(0, 200));
  if (!anthropicClient) return res.status(503).json({ ok: false, error: 'Chat agent not configured' });

  const { sessionId, message } = req.body;
  if (!message) return res.status(400).json({ ok: false, error: 'Message required' });

  const sid = sessionId || 'sess_' + crypto.randomBytes(8).toString('hex');
  console.log('[chat] Session:', sid, '| Message:', message.slice(0, 100));

  if (!chatSessions[sid] || !chatSessions[sid].apiMessages) {
    chatSessions[sid] = {
      id: sid,
      apiMessages: [],
      createdAt: new Date().toISOString()
    };
  }

  const session = chatSessions[sid];

  // Append user message to full API history
  session.apiMessages.push({ role: 'user', content: message });

  // Trim if context gets too large, but ensure we start with a user message
  if (session.apiMessages.length > 40) {
    let msgs = session.apiMessages.slice(-30);
    // Ensure first message is a user role (not orphaned tool_result)
    while (msgs.length > 1 && msgs[0].role !== 'user') msgs.shift();
    // Ensure first user message is a plain string (not tool_result)
    while (msgs.length > 1 && typeof msgs[0].content !== 'string') msgs.shift();
    session.apiMessages = msgs;
  }

  try {
    let toolUseLog = [];

    for (let turn = 0; turn < 8; turn++) {
      console.log('[chat] Turn', turn, '| Messages:', session.apiMessages.length);
      const response = await anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: CHAT_SYSTEM_PROMPT,
        tools: CLAUDE_TOOLS,
        messages: session.apiMessages
      });
      console.log('[chat] API response, stop_reason:', response.stop_reason, '| blocks:', response.content.length);

      const assistantContent = response.content;
      let hasToolUse = false;

      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          hasToolUse = true;
          const result = executeTool(block.name, block.input);
          toolUseLog.push({ tool: block.name, input: block.input, result });

          // Persist tool use exchange in session history
          session.apiMessages.push({ role: 'assistant', content: assistantContent });
          session.apiMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result)
            }]
          });
          break;
        }
      }

      if (!hasToolUse) {
        const textParts = assistantContent.filter(b => b.type === 'text').map(b => b.text);
        const reply = textParts.join('\n');

        // Persist final assistant reply in session history
        session.apiMessages.push({ role: 'assistant', content: reply });

        const filesChanged = toolUseLog
          .filter(t => t.tool === 'write_file' || t.tool === 'edit_file')
          .map(t => t.input.file_path);

        return res.json({
          ok: true,
          sessionId: sid,
          reply,
          toolsUsed: toolUseLog.map(t => ({ tool: t.tool, file: t.input.file_path || t.input.directory || t.input.pattern })),
          filesChanged: [...new Set(filesChanged)]
        });
      }
    }

    // Hit max turns
    session.apiMessages.push({ role: 'assistant', content: 'Hit iteration limit. Check results and ask for more if needed.' });
    return res.json({
      ok: true,
      sessionId: sid,
      reply: 'I made several changes but hit the iteration limit. Check the results and let me know if you need more.',
      toolsUsed: toolUseLog.map(t => ({ tool: t.tool, file: t.input.file_path || t.input.directory || t.input.pattern })),
      filesChanged: [...new Set(toolUseLog.filter(t => t.tool === 'write_file' || t.tool === 'edit_file').map(t => t.input.file_path))]
    });

  } catch (e) {
    console.error('[chat] Error:', e.message);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'Chat failed: ' + e.message });
    }
  }
});

// GET /api/chat/:sessionId — get chat history
app.get('/api/chat/:sessionId', (req, res) => {
  const session = chatSessions[req.params.sessionId];
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, session });
});

app.listen(PORT, () => {
  console.log(`\n  🍽  Kinseb running at http://localhost:${PORT}`);
  console.log(`  Service: ${config.name}`);
  console.log(`  Elements: ${elements.elements.length} | Products: ${products.products.length} | Users: ${users.users.length}\n`);
});
