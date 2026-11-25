import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DB_PATH = ':memory:';
Object.assign(process.env, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'Cap Orientation <no-reply@example.ma>' });

// Intercepte les appels à l'API e-mail
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    assert.equal(opts.headers.Authorization, 'Bearer test-key');
    sent.push(JSON.parse(opts.body)); return new Response('{"id":"x"}', { status: 200 });
  }
  return realFetch(url, opts);
};

// Faux fournisseur OpenID Connect (rôle de Google / Auth0)
const idp = { lastAuth: null, user: { sub: 'g-123', email: 'lina@gmail.com', email_verified: true, name: 'Lina' } };
const jwt = claims => ['{"alg":"none"}', JSON.stringify(claims), ''].map(s => Buffer.from(s).toString('base64url')).join('.');
const fake = http.createServer(async (req, res) => {
  const iss = `http://localhost:${fake.address().port}`, u = new URL(req.url, iss);
  if (u.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: iss, authorization_endpoint: iss + '/authorize', token_endpoint: iss + '/token' }));
  if (u.pathname === '/token') {
    let b = ''; for await (const c of req) b += c; const p = new URLSearchParams(b);
    const challenge = crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url');
    if (p.get('client_secret') !== 'sec' || challenge !== idp.lastAuth.get('code_challenge') || p.get('code') !== 'good-code') { res.statusCode = 400; return res.end('{}'); }
    return res.end(JSON.stringify({ id_token: jwt({ iss, aud: 'cid', exp: Date.now() / 1000 + 300, nonce: idp.lastAuth.get('nonce'), ...idp.user }) }));
  }
  res.statusCode = 404; res.end();
});
await new Promise(r => fake.listen(0, r));
Object.assign(process.env, { OIDC_ISSUER: `http://localhost:${fake.address().port}`, OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'sec', OIDC_NAME: 'Google' });

const { server, sendDueReminders } = await import('../server.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
after(() => { server.close(); fake.close(); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await realFetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie }, body: body && JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), data: await res.json().catch(() => null) };
  };
}
const linkIn = mail => mail.html.match(/href="([^"]+)"/)[1].replace(/^http:\/\/localhost:3000/, '');

test('emails: verification, reset, reminders', async () => {
  const c = client();
  assert.deepEqual((await c('GET', '/api/config')).data, { oidc: { name: 'Google' }, email: true });
  const reg = await c('POST', '/api/auth/register', { email: 'omar@example.ma', password: 'password1', consent: true, lang: 'en' });
  assert.equal(reg.data.devLink, undefined, 'no dev link once email is configured');
  await new Promise(r => setTimeout(r, 20));
  const v = sent.pop(); assert.deepEqual(v.to, ['omar@example.ma']); assert.equal(v.subject, 'Verify your email address');
  assert.equal((await c('GET', linkIn(v))).location, '/#/verified');
  assert.equal((await c('GET', '/api/me')).data.verified, true);

  await c('POST', '/api/auth/forgot', { email: 'omar@example.ma' }); await new Promise(r => setTimeout(r, 20));
  const resetTok = linkIn(sent.pop()).split('/reset/')[1];
  assert.equal((await c('POST', '/api/auth/reset', { token: resetTok, password: 'newpassword1' })).status, 200);
  assert.equal((await c('POST', '/api/auth/login', { email: 'omar@example.ma', password: 'newpassword1' })).status, 200);

  await c('POST', '/api/notes', { text: 'Concours ENSA', due: new Date().toISOString().slice(0, 10) });
  assert.equal(await sendDueReminders(), 1);
  assert.match(sent.pop().subject, /Reminder: Concours ENSA/);
  assert.equal(await sendDueReminders(), 0, 'reminder sent only once');
});

test('OIDC login (Google / Auth0 style)', async () => {
  const c = client();
  const start = await c('GET', '/api/auth/oidc/start');
  assert.equal(start.status, 302);
  idp.lastAuth = new URL(start.location).searchParams;
  assert.equal(idp.lastAuth.get('client_id'), 'cid'); assert.equal(idp.lastAuth.get('code_challenge_method'), 'S256');
  const state = idp.lastAuth.get('state');

  assert.equal((await c('GET', `/api/auth/oidc/callback?code=bad-code&state=${state}`)).location, '/#/login?e=oidc_failed');
  // le state est à usage unique : il faut recommencer
  idp.lastAuth = new URL((await c('GET', '/api/auth/oidc/start')).location).searchParams;
  const cb = await c('GET', `/api/auth/oidc/callback?code=good-code&state=${idp.lastAuth.get('state')}`);
  assert.equal(cb.location, '/#/profile?new=1');
  const me = (await c('GET', '/api/me')).data;
  assert.equal(me.email, 'lina@gmail.com'); assert.equal(me.verified, true); assert.equal(me.sso, true); assert.equal(me.hasPassword, false);
  assert.equal((await c('POST', '/api/me/password', { password: 'firstpass1' })).status, 200, 'SSO user can set a first password');

  // Connexion suivante → compte existant
  const c2 = client();
  idp.lastAuth = new URL((await c2('GET', '/api/auth/oidc/start')).location).searchParams;
  assert.equal((await c2('GET', `/api/auth/oidc/callback?code=good-code&state=${idp.lastAuth.get('state')}`)).location, '/#/dashboard');
  assert.equal((await c2('GET', `/api/auth/oidc/callback?code=good-code&state=${idp.lastAuth.get('state')}`)).location, '/#/login?e=oidc_failed', 'state replay rejected');

  // E-mail non vérifié chez le fournisseur → refusé (pas de prise de contrôle de compte)
  idp.user = { sub: 'evil', email: 'omar@example.ma', email_verified: false };
  const c3 = client();
  idp.lastAuth = new URL((await c3('GET', '/api/auth/oidc/start')).location).searchParams;
  assert.equal((await c3('GET', `/api/auth/oidc/callback?code=good-code&state=${idp.lastAuth.get('state')}`)).location, '/#/login?e=oidc_email_unverified');
});
