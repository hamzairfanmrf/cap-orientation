import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as seed from './seed.js';
import { computeProfile, recommend } from './engine.js';
import { sendMail, template, mailConfigured, oidcConfigured, oidcName, oidcStart, oidcFinish } from './integrations.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = +process.env.PORT || 3000;
const DEV = process.env.NODE_ENV !== 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const KINDS = ['university', 'program', 'career', 'question'];

// ---------------- Base de données ----------------
export const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, 'data.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT, name TEXT, role TEXT DEFAULT 'student',
  verified INT DEFAULT 0, blocked INT DEFAULT 0, profile TEXT DEFAULT '{}', partner_uni TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, created INT);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, kind TEXT, created INT);
CREATE TABLE IF NOT EXISTS content(kind TEXT, id TEXT, data TEXT, views INT DEFAULT 0, updated TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS tests(id INTEGER PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, status TEXT DEFAULT 'in_progress',
  version INT, answers TEXT DEFAULT '{}', result TEXT, share TEXT UNIQUE, created TEXT DEFAULT CURRENT_TIMESTAMP, finished TEXT);
CREATE TABLE IF NOT EXISTS favorites(user_id INT REFERENCES users(id) ON DELETE CASCADE, kind TEXT, item_id TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,kind,item_id));
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE, text TEXT, due TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE SET NULL, test_id INT, rating INT, comment TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, name TEXT, email TEXT, body TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY, nonce TEXT, verifier TEXT, created INT);
`);
// Migrations légères (colonnes ajoutées après la v1)
for (const sql of ['ALTER TABLE notes ADD COLUMN emailed INT DEFAULT 0', 'ALTER TABLE users ADD COLUMN oidc_sub TEXT']) { try { db.exec(sql); } catch { /* déjà présente */ } }

const J = s => (s ? JSON.parse(s) : null);
const putContent = db.prepare(`INSERT INTO content(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=CURRENT_TIMESTAMP`);
if (!db.prepare('SELECT 1 FROM content LIMIT 1').get()) {
  for (const [kind, list] of [['program', seed.programs], ['university', seed.universities], ['career', seed.careers], ['question', seed.questions]])
    for (const it of list) putContent.run(kind, it.id, JSON.stringify(it));
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('weights', JSON.stringify(seed.defaultWeights));
}

// ---------------- Sécurité ----------------
function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPw(pw, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':'); const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tok = () => crypto.randomBytes(24).toString('base64url');

if (!db.prepare(`SELECT 1 FROM users WHERE role='admin'`).get()) {
  const email = process.env.ADMIN_EMAIL || 'admin@orientation.local', pw = process.env.ADMIN_PASSWORD || 'admin1234';
  db.prepare(`INSERT INTO users(email,pass,name,role,verified) VALUES(?,?,?,?,1)`).run(email, hashPw(pw), 'Admin', 'admin');
  console.log(`[setup] Compte admin créé : ${email} / ${pw}  (changez-le !)`);
}

// Derrière un proxy (Cloudflare, Render, Caddy…), TRUST_PROXY=1 pour utiliser la vraie IP du client.
const clientIp = req => (process.env.TRUST_PROXY ? (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) : '') || req.socket.remoteAddress;
const hits = new Map(); // limitation anti force brute
function rateLimit(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr); return arr.length <= max;
}

const userLang = u => (J(typeof u.profile === 'string' ? u.profile : JSON.stringify(u.profile || {})) || {}).lang || 'fr';
async function mail(user, kind, link, vars) { const m = template(kind, userLang(user), link, vars); return sendMail(user.email, m.subject, m.html); }
function issueVerification(user) {
  const t = tok(); db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(t, user.id, 'verify', Date.now());
  const link = `${BASE_URL}/api/auth/verify?token=${t}`; mail(user, 'verify', link); return link;
}
function startSession(userId) { const s = tok(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(s, userId, Date.now()); return sessionCookie(s, 30 * 86400); }

// ---------------- HTTP helpers ----------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
};
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2e6) fail(413, 'too_large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'bad_json'); }
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const sessionCookie = (t, maxAge) => `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${BASE_URL.startsWith('https') ? '; Secure' : ''}`;

function currentUser(req) {
  const t = cookies(req).sid; if (!t) return null;
  const u = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.created>?`).get(t, Date.now() - 30 * 864e5);
  if (!u || u.blocked) return null;
  return { ...u, profile: J(u.profile) || {} };
}
const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, verified: !!u.verified, hasPassword: !!u.pass, sso: !!u.oidc_sub, profile: u.profile, partner_uni: u.partner_uni, created: u.created });

const list = kind => db.prepare('SELECT data FROM content WHERE kind=?').all(kind).map(r => J(r.data));
const questions = () => list('question').sort((a, b) => (a.order || 0) - (b.order || 0));
const weights = () => ({ ...seed.defaultWeights, ...J(db.prepare(`SELECT value FROM settings WHERE key='weights'`).get()?.value) });

function cleanEmail(e) { e = String(e || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) fail(400, 'bad_email'); return e; }
function cleanPw(p) { p = String(p || ''); if (p.length < 8 || p.length > 200) fail(400, 'weak_password'); return p; }
const str = (v, n = 500) => String(v ?? '').slice(0, n);

function sanitizeProfile(p = {}) {
  const out = {};
  for (const k of ['age', 'average', 'budget']) if (p[k] !== undefined && p[k] !== '') { const n = +p[k]; if (Number.isFinite(n)) out[k] = n; }
  if (seed.BAC_SERIES.includes(p.bac)) out.bac = p.bac;
  for (const k of ['city', 'languages', 'mention']) if (p[k]) out[k] = str(p[k], 100);
  if (['public', 'private', 'any'].includes(p.typePref)) out.typePref = p.typePref;
  if (p.lang && ['fr', 'en', 'ar'].includes(p.lang)) out.lang = p.lang;
  if (p.consentVia === 'oidc') out.consentVia = 'oidc';
  return out;
}

function testRow(id, user) {
  const t = db.prepare('SELECT * FROM tests WHERE id=?').get(id);
  if (!t || t.user_id !== user.id) fail(404, 'not_found');
  return { ...t, answers: J(t.answers) || {}, result: J(t.result) };
}

function recommendationsFor(result, userProfile) {
  return recommend({ profile: result, userProfile, programs: list('program'), universities: list('university'), weights: weights() });
}

// ---------------- Routes ----------------
const routes = [];
const r = (method, pattern, role, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn });
const can = (u, role) => role === 'any' || (u && (role === 'user' || u.role === 'admin' || (role === 'editor' && u.role === 'editor') || (role === 'partner' && u.role === 'partner')));

// Auth
r('POST', '/api/auth/register', 'any', async ({ req, b }) => {
  if (!rateLimit('reg:' + clientIp(req), 10, 36e5)) fail(429, 'too_many');
  const email = cleanEmail(b.email), pw = cleanPw(b.password);
  if (!b.consent) fail(400, 'consent_required');
  if (b.minor && !b.parentConsent) fail(400, 'parent_consent_required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) fail(409, 'email_taken');
  const { lastInsertRowid: id } = db.prepare('INSERT INTO users(email,pass,name,profile) VALUES(?,?,?,?)')
    .run(email, hashPw(pw), str(b.name, 100), JSON.stringify(sanitizeProfile({ ...b.profile, lang: b.lang })));
  const link = issueVerification(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  return { status: 201, data: { ok: true, devLink: DEV && !mailConfigured() ? link : undefined }, headers: { 'Set-Cookie': startSession(id) } };
});
r('POST', '/api/auth/resend-verification', 'user', ({ user }) => {
  if (user.verified) return { data: { ok: true } };
  if (!rateLimit('verify:' + user.id, 3, 36e5)) fail(429, 'too_many');
  db.prepare(`DELETE FROM tokens WHERE user_id=? AND kind='verify'`).run(user.id);
  const link = issueVerification(user); return { data: { ok: true, devLink: DEV && !mailConfigured() ? link : undefined } };
});
r('GET', '/api/config', 'any', () => ({ data: { oidc: oidcConfigured() ? { name: oidcName() } : null, email: mailConfigured() } }));

// Connexion via fournisseur tiers (OpenID Connect : Google, Auth0, …)
const OIDC_REDIRECT = () => `${BASE_URL}/api/auth/oidc/callback`;
r('GET', '/api/auth/oidc/start', 'any', async ({ req }) => {
  if (!oidcConfigured()) fail(404, 'oidc_disabled');
  if (!rateLimit('oidc:' + clientIp(req), 30, 6e5)) fail(429, 'too_many');
  const s = await oidcStart(OIDC_REDIRECT());
  db.prepare('DELETE FROM oauth_states WHERE created<?').run(Date.now() - 6e5);
  db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)').run(s.state, s.nonce, s.verifier, Date.now());
  return { redirect: s.url };
});
r('GET', '/api/auth/oidc/callback', 'any', async ({ url }) => {
  const st = db.prepare('SELECT * FROM oauth_states WHERE state=? AND created>?').get(url.searchParams.get('state') || '', Date.now() - 6e5);
  if (st) db.prepare('DELETE FROM oauth_states WHERE state=?').run(st.state); // usage unique
  const code = url.searchParams.get('code');
  if (!st || !code) return { redirect: '/#/login?e=oidc_failed' };
  let id;
  try { id = await oidcFinish({ code, redirectUri: OIDC_REDIRECT(), nonce: st.nonce, verifier: st.verifier }); }
  catch (e) { console.error('[oidc]', e.message); return { redirect: '/#/login?e=oidc_failed' }; }
  if (!id.email || !id.email_verified) return { redirect: '/#/login?e=oidc_email_unverified' };
  let u = db.prepare('SELECT * FROM users WHERE oidc_sub=?').get(id.sub) || db.prepare('SELECT * FROM users WHERE email=?').get(id.email);
  let isNew = false;
  if (u) {
    if (u.blocked) return { redirect: '/#/login?e=blocked' };
    db.prepare('UPDATE users SET oidc_sub=?, verified=1 WHERE id=?').run(id.sub, u.id); // l'e-mail est vérifié par le fournisseur
  } else {
    const { lastInsertRowid } = db.prepare('INSERT INTO users(email,pass,name,verified,oidc_sub,profile) VALUES(?,NULL,?,1,?,?)').run(id.email, str(id.name, 100), id.sub, JSON.stringify({ consentVia: 'oidc' }));
    u = { id: lastInsertRowid }; isNew = true;
  }
  return { redirect: isNew ? '/#/profile?new=1' : '/#/dashboard', headers: { 'Set-Cookie': startSession(u.id) } };
});
r('GET', '/api/auth/verify', 'any', ({ url }) => {
  const t = db.prepare(`SELECT * FROM tokens WHERE token=? AND kind='verify'`).get(url.searchParams.get('token') || '');
  if (t) { db.prepare('UPDATE users SET verified=1 WHERE id=?').run(t.user_id); db.prepare('DELETE FROM tokens WHERE token=?').run(t.token); }
  return { redirect: t ? '/#/verified' : '/#/login' };
});
r('POST', '/api/auth/login', 'any', async ({ req, b }) => {
  const email = cleanEmail(b.email);
  if (!rateLimit('login:' + clientIp(req) + email, 8, 15 * 6e4)) fail(429, 'too_many');
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u || !checkPw(String(b.password || ''), u.pass)) fail(401, 'bad_credentials');
  if (u.blocked) fail(403, 'blocked');
  const s = tok(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(s, u.id, Date.now());
  return { data: { ok: true }, headers: { 'Set-Cookie': sessionCookie(s, 30 * 86400) } };
});
r('POST', '/api/auth/logout', 'any', ({ req }) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(cookies(req).sid || '');
  return { data: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
});
r('POST', '/api/auth/forgot', 'any', ({ req, b }) => {
  if (!rateLimit('forgot:' + clientIp(req), 5, 36e5)) fail(429, 'too_many');
  const u = db.prepare('SELECT id,email,profile FROM users WHERE email=?').get(cleanEmail(b.email)); let link;
  if (u) { const t = tok(); db.prepare('INSERT INTO tokens VALUES(?,?,?,?)').run(t, u.id, 'reset', Date.now()); link = `${BASE_URL}/#/reset/${t}`; mail(u, 'reset', link); }
  return { data: { ok: true, devLink: DEV && !mailConfigured() ? link : undefined } }; // même réponse que l'e-mail existe ou non
});
r('POST', '/api/auth/reset', 'any', ({ b }) => {
  const t = db.prepare(`SELECT * FROM tokens WHERE token=? AND kind='reset' AND created>?`).get(str(b.token, 100), Date.now() - 36e5);
  if (!t) fail(400, 'invalid_token');
  db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPw(cleanPw(b.password)), t.user_id);
  db.prepare('DELETE FROM tokens WHERE token=?').run(t.token); db.prepare('DELETE FROM sessions WHERE user_id=?').run(t.user_id);
  return { data: { ok: true } };
});

// Compte
r('GET', '/api/me', 'any', ({ user }) => ({ data: publicUser(user) }));
r('PUT', '/api/me', 'user', ({ user, b }) => {
  db.prepare('UPDATE users SET name=?, profile=? WHERE id=?').run(str(b.name ?? user.name, 100), JSON.stringify(sanitizeProfile({ ...b.profile, consentVia: user.profile.consentVia })), user.id);
  return { data: { ok: true } };
});
r('POST', '/api/me/password', 'user', ({ user, b }) => {
  if (user.pass && !checkPw(String(b.current || ''), user.pass)) fail(401, 'bad_credentials'); // comptes Google/SSO : premier mot de passe
  db.prepare('UPDATE users SET pass=? WHERE id=?').run(hashPw(cleanPw(b.password)), user.id); return { data: { ok: true } };
});
r('DELETE', '/api/me', 'user', ({ user }) => {
  if (user.role === 'admin' && db.prepare(`SELECT COUNT(*) n FROM users WHERE role='admin'`).get().n < 2) fail(400, 'last_admin');
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  return { data: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
});
r('GET', '/api/me/export', 'user', ({ user }) => ({
  data: {
    user: publicUser(user),
    tests: db.prepare('SELECT id,status,answers,result,created,finished FROM tests WHERE user_id=?').all(user.id).map(t => ({ ...t, answers: J(t.answers), result: J(t.result) })),
    favorites: db.prepare('SELECT kind,item_id,created FROM favorites WHERE user_id=?').all(user.id),
    notes: db.prepare('SELECT text,due,created FROM notes WHERE user_id=?').all(user.id),
    feedback: db.prepare('SELECT rating,comment,created FROM feedback WHERE user_id=?').all(user.id),
  }, headers: { 'Content-Disposition': 'attachment; filename="mes-donnees.json"' },
}));

// Catalogue
r('GET', '/api/content/:kind', 'any', ({ p }) => {
  if (!['university', 'program', 'career'].includes(p.kind)) fail(404, 'not_found');
  return { data: list(p.kind) };
});
r('POST', '/api/content/:kind/:id/view', 'any', ({ p }) => { db.prepare('UPDATE content SET views=views+1 WHERE kind=? AND id=?').run(p.kind, p.id); return { data: { ok: true } }; });

// Test
r('GET', '/api/questions', 'any', () => ({ data: questions() }));
r('GET', '/api/tests', 'user', ({ user }) => ({
  data: db.prepare('SELECT id,status,result,created,finished FROM tests WHERE user_id=? ORDER BY id DESC').all(user.id).map(t => ({ ...t, result: J(t.result) })),
}));
r('POST', '/api/tests', 'user', ({ user, b }) => {
  const open = db.prepare(`SELECT id FROM tests WHERE user_id=? AND status='in_progress' ORDER BY id DESC`).get(user.id);
  if (open && !b.fresh) return { data: testRow(open.id, user) };
  if (open) db.prepare('DELETE FROM tests WHERE id=?').run(open.id);
  const { lastInsertRowid } = db.prepare('INSERT INTO tests(user_id,version) VALUES(?,1)').run(user.id);
  return { status: 201, data: testRow(lastInsertRowid, user) };
});
r('GET', '/api/tests/:id', 'user', ({ user, p }) => ({ data: testRow(+p.id, user) }));
r('PUT', '/api/tests/:id/answers', 'user', ({ user, p, b }) => {
  const t = testRow(+p.id, user); if (t.status !== 'in_progress') fail(400, 'finished');
  const ids = new Set(questions().map(q => q.id));
  const answers = Object.fromEntries(Object.entries(b.answers || {}).filter(([k]) => ids.has(k)));
  db.prepare('UPDATE tests SET answers=? WHERE id=?').run(JSON.stringify(answers), t.id); return { data: { ok: true } };
});
r('POST', '/api/tests/:id/finish', 'user', ({ user, p }) => {
  const t = testRow(+p.id, user); const qs = questions();
  const missing = qs.filter(q => t.answers[q.id] == null && q.type !== 'rank');
  if (missing.length) fail(400, 'incomplete');
  const result = computeProfile(qs, t.answers);
  db.prepare(`UPDATE tests SET status='done', result=?, finished=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(result), t.id);
  return { data: { ok: true, id: t.id } };
});
r('GET', '/api/tests/:id/recommendations', 'user', ({ user, p }) => {
  const t = testRow(+p.id, user); if (!t.result) fail(400, 'not_finished');
  return { data: { result: t.result, ...recommendationsFor(t.result, user.profile), share: t.share } };
});
r('POST', '/api/tests/:id/share', 'user', ({ user, p }) => {
  const t = testRow(+p.id, user); const s = t.share || tok();
  db.prepare('UPDATE tests SET share=? WHERE id=?').run(s, t.id); return { data: { share: s } };
});
r('DELETE', '/api/tests/:id/share', 'user', ({ user, p }) => { testRow(+p.id, user); db.prepare('UPDATE tests SET share=NULL WHERE id=?').run(+p.id); return { data: { ok: true } }; });
r('GET', '/api/share/:token', 'any', ({ p }) => {
  const t = db.prepare('SELECT t.result, u.profile FROM tests t JOIN users u ON u.id=t.user_id WHERE t.share=?').get(p.token);
  if (!t) fail(404, 'not_found');
  const result = J(t.result); const rec = recommendationsFor(result, J(t.profile));
  return { data: { result, programs: rec.programs.slice(0, 10) } }; // aucune donnée identifiante
});

// Espace personnel
r('GET', '/api/favorites', 'user', ({ user }) => ({ data: db.prepare('SELECT kind,item_id,created FROM favorites WHERE user_id=?').all(user.id) }));
r('POST', '/api/favorites', 'user', ({ user, b }) => {
  if (!['university', 'program', 'career'].includes(b.kind)) fail(400, 'bad_kind');
  db.prepare('INSERT OR IGNORE INTO favorites(user_id,kind,item_id) VALUES(?,?,?)').run(user.id, b.kind, str(b.id, 100)); return { data: { ok: true } };
});
r('DELETE', '/api/favorites/:kind/:id', 'user', ({ user, p }) => { db.prepare('DELETE FROM favorites WHERE user_id=? AND kind=? AND item_id=?').run(user.id, p.kind, p.id); return { data: { ok: true } }; });
r('GET', '/api/notes', 'user', ({ user }) => ({ data: db.prepare('SELECT * FROM notes WHERE user_id=? ORDER BY due IS NULL, due, id DESC').all(user.id) }));
r('POST', '/api/notes', 'user', ({ user, b }) => {
  const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null; if (!b.text) fail(400, 'empty');
  db.prepare('INSERT INTO notes(user_id,text,due) VALUES(?,?,?)').run(user.id, str(b.text, 2000), due); return { status: 201, data: { ok: true } };
});
r('DELETE', '/api/notes/:id', 'user', ({ user, p }) => { db.prepare('DELETE FROM notes WHERE id=? AND user_id=?').run(+p.id, user.id); return { data: { ok: true } }; });
r('GET', '/api/notifications', 'user', ({ user }) => {
  const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
  const reminders = db.prepare('SELECT id,text,due FROM notes WHERE user_id=? AND due BETWEEN ? AND ? ORDER BY due').all(user.id, today, soon).map(n => ({ type: 'reminder', ...n }));
  const updates = db.prepare(`SELECT f.kind, f.item_id, c.updated FROM favorites f JOIN content c ON c.kind=f.kind AND c.id=f.item_id
    WHERE f.user_id=? AND c.updated > f.created AND c.updated > datetime('now','-30 days')`).all(user.id).map(x => ({ type: 'update', ...x }));
  const out = [...reminders, ...updates];
  if (!user.verified) out.unshift({ type: 'verify' });
  if (!db.prepare(`SELECT 1 FROM tests WHERE user_id=? AND status='done'`).get(user.id)) out.push({ type: 'takeTest' });
  return { data: out };
});

// Retours
r('POST', '/api/feedback', 'user', ({ user, b }) => {
  const rating = Math.round(+b.rating); if (!(rating >= 1 && rating <= 5)) fail(400, 'bad_rating');
  db.prepare('INSERT INTO feedback(user_id,test_id,rating,comment) VALUES(?,?,?,?)').run(user.id, +b.testId || null, rating, str(b.comment, 2000));
  return { status: 201, data: { ok: true } };
});
r('POST', '/api/contact', 'any', ({ req, b }) => {
  if (!rateLimit('contact:' + clientIp(req), 5, 36e5)) fail(429, 'too_many');
  if (!b.body) fail(400, 'empty');
  db.prepare('INSERT INTO messages(name,email,body) VALUES(?,?,?)').run(str(b.name, 100), str(b.email, 200), str(b.body, 5000));
  return { status: 201, data: { ok: true } };
});

// Administration
r('GET', '/api/admin/stats', 'editor', () => {
  const one = sql => db.prepare(sql).get();
  const users = one(`SELECT COUNT(*) n FROM users WHERE role='student'`).n;
  const started = one('SELECT COUNT(DISTINCT user_id) n FROM tests').n, done = one(`SELECT COUNT(DISTINCT user_id) n FROM tests WHERE status='done'`).n;
  const sat = one('SELECT AVG(rating) avg, COUNT(*) n FROM feedback');
  const counts = {};
  for (const t of db.prepare(`SELECT t.result, u.profile FROM tests t JOIN users u ON u.id=t.user_id WHERE t.status='done' ORDER BY t.id DESC LIMIT 500`).all()) {
    for (const p of recommendationsFor(J(t.result), J(t.profile)).programs.slice(0, 3)) counts[p.id] = (counts[p.id] || 0) + 1;
  }
  const byDay = db.prepare(`SELECT substr(created,1,10) day, COUNT(*) n FROM users WHERE created > datetime('now','-30 days') GROUP BY day ORDER BY day`).all();
  const views = db.prepare(`SELECT kind,id,views FROM content WHERE kind!='question' ORDER BY views DESC LIMIT 10`).all();
  const favs = db.prepare('SELECT kind,item_id,COUNT(*) n FROM favorites GROUP BY kind,item_id ORDER BY n DESC LIMIT 10').all();
  return { data: { users, started, done, completion: started ? Math.round(done / started * 100) : 0, satisfaction: sat.avg ? +sat.avg.toFixed(2) : null, feedbackCount: sat.n,
    topPrograms: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10), byDay, views, favs } };
});
r('GET', '/api/admin/users', 'admin', () => ({ data: db.prepare('SELECT id,email,name,role,verified,blocked,partner_uni,created FROM users ORDER BY id DESC').all() }));
r('PUT', '/api/admin/users/:id', 'admin', ({ p, b, user }) => {
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(+p.id); if (!target) fail(404, 'not_found');
  const role = ['student', 'editor', 'partner', 'admin', 'counsellor'].includes(b.role) ? b.role : target.role;
  if (target.id === user.id && role !== 'admin') fail(400, 'cannot_demote_self');
  db.prepare('UPDATE users SET role=?, blocked=?, partner_uni=? WHERE id=?').run(role, b.blocked ? 1 : 0, b.partner_uni ? str(b.partner_uni, 100) : null, target.id);
  if (b.blocked) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  return { data: { ok: true } };
});
r('DELETE', '/api/admin/users/:id', 'admin', ({ p, user }) => {
  if (+p.id === user.id) fail(400, 'cannot_delete_self');
  db.prepare('DELETE FROM users WHERE id=?').run(+p.id); return { data: { ok: true } };
});
r('GET', '/api/admin/content/:kind', 'editor', ({ p }) => {
  if (!KINDS.includes(p.kind)) fail(404, 'not_found');
  return { data: db.prepare('SELECT id,data,views,updated FROM content WHERE kind=?').all(p.kind).map(x => ({ ...x, data: J(x.data) })) };
});
function validateItem(kind, d) {
  if (!d || typeof d !== 'object' || !/^[a-z0-9-]{1,60}$/.test(d.id || '')) fail(400, 'bad_id');
  const req = { university: ['name', 'city', 'type', 'programs'], program: ['name', 'riasec', 'series', 'duration'], career: ['name'], question: ['text', 'type'] }[kind];
  for (const k of req) if (d[k] == null) fail(400, 'missing_' + k);
  if (kind === 'university') { d.fees = +d.fees || 0; if (!Array.isArray(d.programs)) fail(400, 'bad_programs'); }
  if (kind === 'program') { d.duration = +d.duration; d.minAvg = +d.minAvg || 0; d.subjects ||= []; d.careers ||= []; }
  return d;
}
r('PUT', '/api/admin/content/:kind/:id', 'editor', ({ p, b }) => {
  if (!KINDS.includes(p.kind)) fail(404, 'not_found');
  const d = validateItem(p.kind, b.data); if (d.id !== p.id) db.prepare('DELETE FROM content WHERE kind=? AND id=?').run(p.kind, p.id);
  putContent.run(p.kind, d.id, JSON.stringify(d)); return { data: { ok: true } };
});
r('DELETE', '/api/admin/content/:kind/:id', 'editor', ({ p }) => { db.prepare('DELETE FROM content WHERE kind=? AND id=?').run(p.kind, p.id); return { data: { ok: true } }; });
r('POST', '/api/admin/import/:kind', 'editor', ({ p, b }) => {
  if (!['university', 'program', 'career'].includes(p.kind) || !Array.isArray(b.rows)) fail(400, 'bad_import');
  let n = 0; const errors = [];
  db.exec('BEGIN');
  try {
    b.rows.forEach((row, i) => { try { const d = validateItem(p.kind, row); putContent.run(p.kind, d.id, JSON.stringify(d)); n++; } catch (e) { errors.push({ row: i + 2, error: e.message }); } });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { data: { imported: n, errors } };
});
r('GET', '/api/admin/weights', 'editor', () => ({ data: weights() }));
r('PUT', '/api/admin/weights', 'editor', ({ b }) => {
  const w = {}; for (const k of Object.keys(seed.defaultWeights)) { const v = +b[k]; if (!(v >= 0 && v <= 1)) fail(400, 'bad_weight_' + k); w[k] = v; }
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('weights', JSON.stringify(w)); return { data: { ok: true } };
});
r('GET', '/api/admin/feedback', 'editor', () => ({
  data: { feedback: db.prepare('SELECT f.*, u.email FROM feedback f LEFT JOIN users u ON u.id=f.user_id ORDER BY f.id DESC LIMIT 200').all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all() },
}));

// Espace partenaire
r('GET', '/api/partner', 'partner', ({ user }) => {
  const row = db.prepare(`SELECT data,views FROM content WHERE kind='university' AND id=?`).get(user.partner_uni || '');
  if (!row) fail(404, 'no_university_linked');
  const d = J(row.data);
  return { data: { university: d, views: row.views, favorites: db.prepare(`SELECT COUNT(*) n FROM favorites WHERE kind='university' AND item_id=?`).get(d.id).n,
    programViews: db.prepare(`SELECT id,views FROM content WHERE kind='program'`).all().filter(x => d.programs.includes(x.id)) } };
});
r('PUT', '/api/partner', 'partner', ({ user, b }) => {
  const d = validateItem('university', { ...b.data, id: user.partner_uni }); putContent.run('university', d.id, JSON.stringify(d)); return { data: { ok: true } };
});

// ---------------- Serveur ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      // CSRF : cookie SameSite=Strict + en-tête personnalisé obligatoire sur les requêtes modifiantes
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') fail(403, 'csrf');
      const user = currentUser(req);
      for (const rt of routes) {
        if (rt.method !== req.method) continue;
        const m = url.pathname.match(rt.re); if (!m) continue;
        if (!can(user, rt.role)) fail(user ? 403 : 401, user ? 'forbidden' : 'unauthorized');
        const b = req.method === 'GET' ? {} : await body(req);
        const out = await rt.fn({ req, url, user, b, p: m.groups || {} });
        if (out.redirect) { res.writeHead(302, { Location: out.redirect, 'Cache-Control': 'no-store', ...out.headers }); return res.end(); }
        return json(res, out.status || 200, out.data, out.headers);
      }
      fail(404, 'not_found');
    }
    // Fichiers statiques
    let fp = path.normalize(path.join(PUB, decodeURIComponent(url.pathname)));
    if (!fp.startsWith(PUB)) fail(403, 'forbidden');
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(PUB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': fp.endsWith('.html') ? 'no-cache' : 'public, max-age=3600', ...SEC_HEADERS });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    json(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'server_error' });
  }
});

// Rappels par e-mail (F26) : notes dont l'échéance est aujourd'hui ou demain, envoyées une seule fois.
export async function sendDueReminders() {
  const today = new Date().toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const due = db.prepare(`SELECT n.id, n.text, n.due, u.email, u.profile FROM notes n JOIN users u ON u.id=n.user_id
    WHERE n.emailed=0 AND n.due BETWEEN ? AND ? AND u.verified=1 AND u.blocked=0`).all(today, tomorrow);
  for (const n of due) {
    db.prepare('UPDATE notes SET emailed=1 WHERE id=?').run(n.id);
    await mail(n, 'reminder', `${BASE_URL}/#/dashboard`, { text: n.text.slice(0, 120), due: n.due });
  }
  return due.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`Orientation → ${BASE_URL}`);
    console.log(`  e-mail : ${mailConfigured() ? process.env.EMAIL_PROVIDER : 'console (EMAIL_PROVIDER non configuré)'}`);
    console.log(`  SSO    : ${oidcConfigured() ? oidcName() + ' (' + process.env.OIDC_ISSUER + ')' : 'désactivé (OIDC_* non configuré)'}`);
  });
  const tick = () => sendDueReminders().catch(e => console.error('[reminders]', e));
  setTimeout(tick, 5000); setInterval(tick, 36e5);
}
