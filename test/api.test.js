import { test, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'adminpass1';
const { server } = await import('../server.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie }, body: body && JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('full student journey', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/me')).data, null);
  assert.equal((await c('POST', '/api/auth/register', { email: 'a@b.ma', password: 'short', consent: true })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { email: 'a@b.ma', password: 'password1', minor: true, consent: true })).data.error, 'parent_consent_required');
  const reg = await c('POST', '/api/auth/register', { email: 'a@b.ma', password: 'password1', name: 'Sara', consent: true });
  assert.equal(reg.status, 201); assert.ok(reg.data.devLink);
  await c('PUT', '/api/me', { name: 'Sara', profile: { bac: 'SM', average: 15.5, city: 'Rabat', gender: 'x' } });
  const me = (await c('GET', '/api/me')).data;
  assert.equal(me.profile.bac, 'SM'); assert.equal(me.profile.gender, undefined);

  const qs = (await c('GET', '/api/questions')).data;
  const t = (await c('POST', '/api/tests', {})).data;
  assert.equal((await c('POST', `/api/tests/${t.id}/finish`)).data.error, 'incomplete');
  // Profil "investigateur / réaliste" : scientifique et technique
  const answers = {};
  for (const q of qs) {
    if (q.type === 'scale') answers[q.id] = (q.dims.I || q.dims.R) ? 5 : 1;
    else if (q.type === 'choice') answers[q.id] = q.options.find(o => o.dims?.I)?.v;
    else if (q.type === 'multi') answers[q.id] = q.options.filter(o => o.dims?.I || o.dims?.R).map(o => o.v);
    else if (q.type === 'rank') answers[q.id] = ['computer', 'math', 'physics', 'bio', 'economics', 'languages', 'humanities', 'art'];
    else answers[q.id] = q.options.at(-1).v;
  }
  await c('PUT', `/api/tests/${t.id}/answers`, { answers });
  const again = (await c('POST', '/api/tests', {})).data; assert.equal(again.id, t.id, 'resumes the in-progress test');
  assert.equal((await c('POST', `/api/tests/${t.id}/finish`)).status, 200);
  const rec = (await c('GET', `/api/tests/${t.id}/recommendations`)).data;
  assert.equal(rec.result.code[0], 'I');
  const top3 = rec.programs.slice(0, 3).map(p => p.id);
  console.log('code', rec.result.code, 'top', rec.programs.slice(0, 5).map(p => p.id + ':' + p.score));
  assert.ok(top3.some(id => ['genie-info', 'maths', 'genie-civil', 'agronomie', 'medecine'].includes(id)));
  assert.ok(rec.programs[0].reasons.length > 0);

  const sh = (await c('POST', `/api/tests/${t.id}/share`)).data.share;
  const pub = await client()('GET', `/api/share/${sh}`);
  assert.equal(pub.status, 200); assert.ok(!JSON.stringify(pub.data).includes('a@b.ma'));

  await c('POST', '/api/favorites', { kind: 'program', id: 'genie-info' });
  await c('POST', '/api/notes', { text: 'Concours ENSA', due: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) });
  const n = (await c('GET', '/api/notifications')).data;
  assert.ok(n.some(x => x.type === 'reminder')); assert.ok(n.some(x => x.type === 'verify'));
  assert.equal((await c('POST', '/api/feedback', { rating: 5, testId: t.id })).status, 201);
  const exp = (await c('GET', '/api/me/export')).data; assert.equal(exp.tests.length, 1); assert.equal(exp.favorites.length, 1);
  assert.equal((await c('GET', '/api/admin/stats')).status, 403);
  assert.equal((await c('DELETE', '/api/me')).status, 200);
  assert.equal((await c('GET', '/api/me')).data, null);
});

test('admin + partner + security', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/auth/login', { email: 'admin@orientation.local', password: 'nope' })).status, 401);
  assert.equal((await a('POST', '/api/auth/login', { email: 'admin@orientation.local', password: 'adminpass1' })).status, 200);
  const s = (await a('GET', '/api/admin/stats')).data; assert.ok('completion' in s);
  const imp = (await a('POST', '/api/admin/import/university', { rows: [{ id: 'ucd', name: { fr: 'UCD' }, city: 'El Jadida', type: 'public', fees: 0, programs: ['droit'] }, { id: 'BAD ID' }] })).data;
  assert.equal(imp.imported, 1); assert.equal(imp.errors.length, 1);
  assert.equal((await a('PUT', '/api/admin/weights', { interest: 2 })).status, 400);

  const p = client();
  await p('POST', '/api/auth/register', { email: 'p@uni.ma', password: 'password1', consent: true });
  const users = (await a('GET', '/api/admin/users')).data;
  const pid = users.find(u => u.email === 'p@uni.ma').id;
  await a('PUT', `/api/admin/users/${pid}`, { role: 'partner', partner_uni: 'ucd' });
  const pd = (await p('GET', '/api/partner')).data; assert.equal(pd.university.id, 'ucd');
  assert.equal((await p('PUT', '/api/partner', { data: { ...pd.university, id: 'um5', city: 'X' } })).status, 200);
  const um5 = (await a('GET', '/api/content/university')).data.find(u => u.id === 'um5');
  assert.equal(um5.city, 'Rabat', 'partner cannot overwrite another university');
  assert.equal((await p('GET', '/api/admin/users')).status, 403);

  // CSRF header required
  const r = await fetch(base + '/api/auth/logout', { method: 'POST' }); assert.equal(r.status, 403);
  // path traversal
  const tr = await fetch(base + '/..%2fserver.js'); assert.ok(!(await tr.text()).includes('DatabaseSync'));
});
