import { DICT, DIM_INFO } from './i18n.js';

// ---------- État & utilitaires ----------
const S = {
  lang: store('lang') || (navigator.language || 'fr').slice(0, 2),
  me: null, cache: {}, questions: null, cmp: JSON.parse(store('cmp') || '{"kind":null,"ids":[]}'),
};
if (!DICT[S.lang]) S.lang = 'fr';
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (k, p = {}) => { let s = DICT[S.lang][k] ?? DICT.fr[k] ?? k; for (const [a, b] of Object.entries(p)) s = s.replaceAll(`{${a}}`, b); return esc(s); };
const tx = v => esc(v == null ? '' : typeof v === 'object' ? (v[S.lang] || v.fr || v.en || '') : v);
const money = n => (+n ? new Intl.NumberFormat(S.lang === 'ar' ? 'ar-MA' : S.lang).format(n) + ' MAD/' + t('year') : t('free'));
const date = d => d ? new Date(d.replace(' ', 'T') + (d.length > 10 && !d.endsWith('Z') ? 'Z' : '')).toLocaleDateString(S.lang === 'ar' ? 'ar-MA' : S.lang) : '';

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'error'); e.status = res.status; throw e; }
  return data;
}
const get = async kind => (S.cache[kind] ||= await api('GET', `/api/content/${kind}`));
const byId = async (kind, id) => (await get(kind)).find(x => x.id === id);
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2600); }
const errMsg = e => DICT[S.lang]['err_' + e.message] || DICT.fr['err_' + e.message] || t('err_generic');

// ---------- Mise en page ----------
function setLang(l) {
  S.lang = l; store('lang', l);
  document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
}
function renderNav(route) {
  const me = S.me, on = r => (route === r ? ' class="on"' : '');
  const links = [`<a href="#/catalog"${on('catalog')}>${t('nav_catalog')}</a>`, `<a href="#/test"${on('test')}>${t('nav_test')}</a>`];
  if (me) {
    links.push(`<a href="#/dashboard"${on('dashboard')}>${t('nav_dashboard')}</a>`);
    if (['admin', 'editor'].includes(me.role)) links.push(`<a href="#/admin"${on('admin')}>${t('nav_admin')}</a>`);
    if (me.role === 'partner') links.push(`<a href="#/partner"${on('partner')}>${t('nav_partner')}</a>`);
    links.push(`<a href="#/profile"${on('profile')}>${t('nav_profile')}</a>`, `<button class="link" data-act="logout">${t('logout')}</button>`);
  } else links.push(`<a href="#/login"${on('login')}>${t('login')}</a>`, `<a class="btn sm" href="#/register">${t('register')}</a>`);
  links.push(`<select data-act="lang" aria-label="Langue">${['fr', 'en', 'ar'].map(l => `<option value="${l}"${l === S.lang ? ' selected' : ''}>${{ fr: 'FR', en: 'EN', ar: 'عربي' }[l]}</option>`).join('')}</select>`);
  $('#nav').innerHTML = links.join('');
  $('#foot').innerHTML = `<a href="#/contact">${t('contact')}</a><a href="#/privacy">${t('privacy')}</a><div class="small">${t('footer_note')}</div>`;
  document.querySelector('.skip').textContent = t('skip');
}
function renderCmpBar() {
  const bar = $('#cmpbar'); const { ids, kind } = S.cmp;
  if (!ids.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>${t('compare_count', { n: ids.length })} (${t('kind_' + kind)})</span>
    <a class="btn sm" href="#/compare">${t('compare')}</a><button class="btn sm subtle" data-act="cmp-clear">${t('clear')}</button>`;
}
function toggleCmp(kind, id) {
  if (S.cmp.kind !== kind) S.cmp = { kind, ids: [] };
  const i = S.cmp.ids.indexOf(id);
  if (i >= 0) S.cmp.ids.splice(i, 1); else if (S.cmp.ids.length >= 4) return toast(t('compare_max')); else S.cmp.ids.push(id);
  store('cmp', JSON.stringify(S.cmp)); renderCmpBar(); route();
}
async function favs() { if (!S.me) return []; return (S.cache.favs ||= await api('GET', '/api/favorites')); }
const isFav = (list, kind, id) => list.some(f => f.kind === kind && f.item_id === id);
const favBtn = (list, kind, id) => S.me ? `<button class="iconbtn${isFav(list, kind, id) ? ' on' : ''}" data-act="fav" data-kind="${kind}" data-id="${esc(id)}" aria-pressed="${isFav(list, kind, id)}" title="${t('favorite')}">♥</button>` : '';
const cmpBtn = (kind, id) => `<button class="iconbtn${S.cmp.kind === kind && S.cmp.ids.includes(id) ? ' on' : ''}" data-act="cmp" data-kind="${kind}" data-id="${esc(id)}">⇄ ${t('compare')}</button>`;
const needLogin = () => `<div class="card narrow empty"><p>${t('need_login')}</p><a class="btn" href="#/login">${t('login')}</a> <a class="btn ghost" href="#/register">${t('register')}</a></div>`;

// ---------- Visualisation RIASEC ----------
function radar(r) {
  const dims = ['R', 'I', 'A', 'S', 'E', 'C'], c = 110, R = 80;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * Math.PI / 3; return [c + Math.cos(a) * R * v, c + Math.sin(a) * R * v]; };
  const ring = v => dims.map((_, i) => pt(i, v).join(',')).join(' ');
  const shape = dims.map((d, i) => pt(i, (r[d] || 0) / 100).join(',')).join(' ');
  return `<svg viewBox="0 0 220 220" class="radar" role="img" aria-label="${t('riasec_profile')}" style="max-width:280px;width:100%">
    ${[.25, .5, .75, 1].map(v => `<polygon points="${ring(v)}" fill="none" stroke="var(--line)"/>`).join('')}
    <polygon points="${shape}" fill="color-mix(in srgb, var(--pri) 30%, transparent)" stroke="var(--pri)" stroke-width="2"/>
    ${dims.map((d, i) => { const [x, y] = pt(i, 1.2); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="700" fill="var(--${d})">${d}</text>`; }).join('')}
  </svg>`;
}
const bars = (r, prev) => `<div class="bars">${['R', 'I', 'A', 'S', 'E', 'C'].map(d => `
  <div class="bar"><span><b style="color:var(--${d})">${d}</b> ${esc(DIM_INFO[S.lang]?.[d]?.[0] || DIM_INFO.fr[d][0])}</span>
  <span class="track"><i style="width:${r[d]}%;background:var(--${d})"></i></span><span>${r[d]}%${prev ? ` <small class="muted">${r[d] - prev[d] >= 0 ? '+' : ''}${r[d] - prev[d]}</small>` : ''}</span></div>`).join('')}</div>`;

// ---------- Vues ----------
const V = {};

V.home = async () => `
  <section class="hero">
    <div>
      <span class="pill">${t('hero_tag')}</span>
      <h1>${t('hero_title')}</h1>
      <p class="lead">${t('hero_lead')}</p>
      <div class="row"><a class="btn" href="#/test">${t('cta_test')}</a><a class="btn ghost" href="#/catalog">${t('cta_catalog')}</a></div>
      <p class="small muted" style="margin-top:12px">${t('hero_small')}</p>
    </div>
    <div class="hero-art">${radar({ R: 55, I: 85, A: 60, S: 75, E: 45, C: 50 })}</div>
  </section>
  <section class="grid steps">
    <div class="card"><h3>${t('step1')}</h3><p class="muted">${t('step1_d')}</p></div>
    <div class="card"><h3>${t('step2')}</h3><p class="muted">${t('step2_d')}</p></div>
    <div class="card"><h3>${t('step3')}</h3><p class="muted">${t('step3_d')}</p></div>
  </section>
  <section class="card" style="margin-top:24px"><h2>${t('riasec_what')}</h2><p class="muted">${t('riasec_expl')}</p>
    <div class="grid">${['R', 'I', 'A', 'S', 'E', 'C'].map(d => `<div><b style="color:var(--${d})">${d} · ${esc((DIM_INFO[S.lang] || DIM_INFO.fr)[d][0])}</b><p class="small muted">${esc((DIM_INFO[S.lang] || DIM_INFO.fr)[d][1])}</p></div>`).join('')}</div>
  </section>`;

const ssoBlock = () => S.config?.oidc ? `<hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
  <a class="btn subtle" style="width:100%" href="/api/auth/oidc/start">${t('sso_continue', { name: esc(S.config.oidc.name) })}</a>
  <p class="small muted" style="margin-top:8px">${t('sso_consent')} <a href="#/privacy">${t('privacy')}</a>.</p>` : '';
const queryError = () => { const e = S.query.get('e'); return e ? `<div class="alert err">${esc(DICT[S.lang]['err_' + e] || DICT.fr['err_' + e] || t('err_generic'))}</div>` : ''; };

V.login = async () => `<div class="card narrow"><h1>${t('login')}</h1>${queryError()}
  <form class="f" data-form="login">
    <label>${t('email')}<input name="email" type="email" autocomplete="email" required></label>
    <label>${t('password')}<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn">${t('login')}</button>
    <div class="row between small"><a href="#/forgot">${t('forgot')}</a><a href="#/register">${t('no_account')}</a></div>
  </form>${ssoBlock()}</div>`;

V.register = async () => `<div class="card narrow"><h1>${t('register')}</h1>
  <form class="f" data-form="register">
    <label>${t('name')}<input name="name" autocomplete="name" required maxlength="100"></label>
    <label>${t('email')}<input name="email" type="email" autocomplete="email" required></label>
    <label>${t('password')}<input name="password" type="password" autocomplete="new-password" minlength="8" required><span class="small muted">${t('pw_rule')}</span></label>
    <label>${t('age')}<input name="age" type="number" min="12" max="99" required></label>
    <label class="check" id="parentWrap" hidden><input type="checkbox" name="parentConsent"> <span>${t('parent_consent')}</span></label>
    <label class="check"><input type="checkbox" name="consent" required> <span>${t('consent')} <a href="#/privacy" target="_blank">${t('privacy')}</a></span></label>
    <button class="btn">${t('create_account')}</button>
    <a class="small" href="#/login">${t('have_account')}</a>
  </form>${ssoBlock()}</div>`;

V.forgot = async () => `<div class="card narrow"><h1>${t('forgot')}</h1><form class="f" data-form="forgot">
  <label>${t('email')}<input name="email" type="email" required></label><button class="btn">${t('send_link')}</button><div id="out"></div></form></div>`;
V.reset = async ([token]) => `<div class="card narrow"><h1>${t('new_password')}</h1><form class="f" data-form="reset"><input type="hidden" name="token" value="${esc(token)}">
  <label>${t('password')}<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><button class="btn">${t('save')}</button></form></div>`;
V.verified = async () => `<div class="card narrow empty"><h1>✓</h1><p>${t('verified')}</p><a class="btn" href="#/test">${t('cta_test')}</a></div>`;

// ----- Test d'orientation -----
V.test = async () => {
  if (!S.me) return `<div class="card narrow"><h1>${t('nav_test')}</h1><p>${t('test_intro')}</p>${needLogin()}</div>`;
  S.questions ||= await api('GET', '/api/questions');
  const tests = await api('GET', '/api/tests');
  const open = tests.find(x => x.status === 'in_progress');
  return `<div class="card qcard stack"><h1>${t('nav_test')}</h1><p>${t('test_intro')}</p>
    <ul class="muted"><li>${t('test_b1', { n: S.questions.length })}</li><li>${t('test_b2')}</li><li>${t('test_b3')}</li></ul>
    <div class="alert info">${t('disclaimer')}</div>
    ${!S.me.profile.bac ? `<div class="alert">${t('profile_hint')} <a href="#/profile">${t('nav_profile')}</a></div>` : ''}
    <div class="row">${open ? `<button class="btn" data-act="test-start">${t('resume_test')}</button><button class="btn ghost" data-act="test-start" data-fresh="1">${t('restart_test')}</button>`
      : `<button class="btn" data-act="test-start">${tests.length ? t('retake_test') : t('start_test')}</button>`}</div></div>`;
};

const T = { test: null, i: 0, saveTimer: null };
async function startTest(fresh) {
  S.questions ||= await api('GET', '/api/questions');
  T.test = await api('POST', '/api/tests', { fresh: !!fresh });
  const firstUnanswered = S.questions.findIndex(q => T.test.answers[q.id] == null);
  T.i = Math.max(0, firstUnanswered < 0 ? S.questions.length - 1 : firstUnanswered);
  location.hash = '#/test/run';
}
function saveAnswers() {
  clearTimeout(T.saveTimer);
  T.saveTimer = setTimeout(() => api('PUT', `/api/tests/${T.test.id}/answers`, { answers: T.test.answers }).then(() => {
    const s = $('#saved'); if (s) s.textContent = t('autosaved');
  }).catch(() => toast(t('err_generic'))), 300);
}
V['test/run'] = async () => {
  if (!T.test) { await startTest(false); }
  const qs = S.questions, q = qs[T.i], a = T.test.answers[q.id];
  const answered = qs.filter(x => T.test.answers[x.id] != null).length;
  let body = '';
  if (q.type === 'scale') {
    body = `<div class="scale" role="radiogroup">${[1, 2, 3, 4, 5].map(v => `<button role="radio" aria-checked="${a == v}" class="${a == v ? 'sel' : ''}" data-act="ans" data-v="${v}"><b>${v}</b>${t('scale_' + v)}</button>`).join('')}</div>`;
  } else if (q.type === 'choice' || q.type === 'constraint') {
    body = `<div class="opts" role="radiogroup">${q.options.map(o => `<button role="radio" aria-checked="${a === o.v}" class="opt${a === o.v ? ' sel' : ''}" data-act="ans" data-v="${esc(o.v)}">${tx(o.text)}</button>`).join('')}</div>`;
  } else if (q.type === 'multi') {
    const sel = a || [];
    body = `<p class="small muted">${t('pick_up_to', { n: q.max })}</p><div class="opts">${q.options.map(o => `<button aria-pressed="${sel.includes(o.v)}" class="opt${sel.includes(o.v) ? ' sel' : ''}" data-act="multi" data-v="${esc(o.v)}">${tx(o.text)}</button>`).join('')}</div>`;
  } else if (q.type === 'rank') {
    const order = a || q.options.map(o => o.v);
    body = `<p class="small muted">${t('rank_hint')}</p><div class="rank"><ol>${order.map((v, i) => { const o = q.options.find(x => x.v === v); return `<li><span class="n">${i + 1}</span><span class="grow">${tx(o.text)}</span>
      <button class="iconbtn" data-act="rank" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="${t('up')}">↑</button><button class="iconbtn" data-act="rank" data-i="${i}" data-d="1" ${i === order.length - 1 ? 'disabled' : ''} aria-label="${t('down')}">↓</button></li>`; }).join('')}</ol></div>
      ${a == null ? `<button class="btn sm ghost" data-act="rank-ok">${t('rank_ok')}</button>` : ''}`;
  }
  const last = T.i === qs.length - 1;
  return `<div class="qcard stack">
    <div class="row between small muted"><span>${t('question_n', { i: T.i + 1, n: qs.length })} · ${t('cat_' + q.cat)}</span><span id="saved"></span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${qs.length}" aria-valuenow="${answered}"><i style="width:${answered / qs.length * 100}%"></i></div>
    <div class="card"><div class="qtext" id="qtext" tabindex="-1">${tx(q.text)}</div>${body}</div>
    <div class="row between">
      <button class="btn subtle" data-act="prev" ${T.i === 0 ? 'disabled' : ''}>← ${t('prev')}</button>
      <a class="small" href="#/dashboard">${t('save_later')}</a>
      ${last ? `<button class="btn" data-act="finish" ${answered < qs.length ? 'disabled' : ''}>${t('see_results')}</button>` : `<button class="btn" data-act="next" ${a == null ? 'disabled' : ''}>${t('next')} →</button>`}
    </div></div>`;
};

// ----- Résultats -----
const R = { filters: { city: '', type: '', dur: '', fees: '', sort: 'score' } };
function reasonText(r) {
  const P = { ...(r.p || {}) };
  if (P.dim) P.dim = esc((DIM_INFO[S.lang] || DIM_INFO.fr)[P.dim][0]);
  if (P.list) P.list = P.list.map(s => DICT[S.lang]['subj_' + s] || DICT.fr['subj_' + s]).join(', ');
  return t('r_' + r.k, P);
}
const noteText = n => t('n_' + n);

function programCard(rec, prog, unis, fl, opts = {}) {
  return `<article class="card">
    <div class="row between" style="align-items:flex-start;flex-wrap:nowrap">
      <div><h3><a href="#/prog/${esc(prog.id)}">${tx(prog.name)}</a></h3>
        <div class="row small"><span class="pill gray">${prog.duration} ${t('years')}</span><span class="pill gray">${esc(prog.diploma)}</span><span class="pill ok">${t('insertion')} ${prog.insertion}%</span></div></div>
      <div class="ring" style="--v:${rec.score}" title="${t('compat')}"><span>${rec.score}%</span></div>
    </div>
    <details ${opts.open ? 'open' : ''}><summary class="small">${t('why')}</summary>
      <ul class="reasons">${rec.reasons.map(r => `<li class="${r.good === true ? 'good' : r.good === false ? 'bad' : ''}">${reasonText(r)}</li>`).join('')}</ul>
      <p class="small muted">${t('parts', rec.parts)}</p>
    </details>
    <div class="small muted" style="margin:8px 0 6px">${t('where')}</div>
    <div class="unis">${unis.length ? unis.slice(0, 6).map(x => `<a class="pill ${x.notes.some(n => ['otherCity', 'overBudget', 'typeMismatch'].includes(n)) ? 'warn' : ''}" href="#/uni/${esc(x.u.id)}" title="${x.notes.map(noteText).join(' · ')}">${tx(x.u.name).split('–')[0]} · ${esc(x.u.city)} · ${x.fit}%</a>`).join('') : `<span class="small muted">${t('no_uni_filter')}</span>`}</div>
    ${opts.actions !== false ? `<div class="row" style="margin-top:12px">${favBtn(fl, 'program', prog.id)}${cmpBtn('program', prog.id)}</div>` : ''}
  </article>`;
}
async function resultsBody(data, { shared = false, prev = null } = {}) {
  const [progs, unis, fl] = await Promise.all([get('program'), get('university'), favs()]);
  const P = Object.fromEntries(progs.map(p => [p.id, p])), U = Object.fromEntries(unis.map(u => [u.id, u]));
  const f = R.filters, cities = [...new Set(unis.map(u => u.city))].sort();
  let rows = data.programs.filter(r => P[r.id]).map(r => {
    const us = r.universities.map(x => ({ ...x, u: U[x.id] })).filter(x => x.u &&
      (!f.city || x.u.city === f.city) && (!f.type || x.u.type === f.type) && (f.fees === '' || x.u.fees <= +f.fees));
    return { r, p: P[r.id], us };
  }).filter(x => (!f.dur || x.p.duration <= +f.dur) && (!(f.city || f.type || f.fees !== '') || x.us.length));
  const sorters = { score: (a, b) => b.r.score - a.r.score, insertion: (a, b) => b.p.insertion - a.p.insertion, duration: (a, b) => a.p.duration - b.p.duration, fees: (a, b) => Math.min(...a.us.map(x => x.u.fees), 1e9) - Math.min(...b.us.map(x => x.u.fees), 1e9) };
  rows.sort(sorters[f.sort] || sorters.score);
  const res = data.result, D = DIM_INFO[S.lang] || DIM_INFO.fr;
  return `
  <section class="grid two">
    <div class="card"><h2>${t('your_profile')} <span class="pill">${esc(res.code)}</span></h2>
      <div class="row" style="justify-content:center">${radar(res.riasec)}</div>${bars(res.riasec, prev)}
      ${prev ? `<p class="small muted">${t('vs_previous')}</p>` : ''}</div>
    <div class="card"><h2>${t('what_it_means')}</h2>
      ${res.code.split('').map(d => `<p><b style="color:var(--${d})">${d} · ${esc(D[d][0])}</b> — ${esc(D[d][1])}</p>`).join('')}
      <div class="alert info small">${t('disclaimer')}</div></div>
  </section>
  <section class="card noprint" style="margin-top:16px"><div class="filters">
    <label>${t('city')}<select data-filter="city"><option value="">${t('all')}</option>${cities.map(c => `<option${f.city === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label>${t('type')}<select data-filter="type"><option value="">${t('all')}</option><option value="public"${f.type === 'public' ? ' selected' : ''}>${t('public')}</option><option value="private"${f.type === 'private' ? ' selected' : ''}>${t('private')}</option></select></label>
    <label>${t('max_duration')}<select data-filter="dur"><option value="">${t('all')}</option>${[2, 3, 5, 7].map(v => `<option value="${v}"${f.dur == v ? ' selected' : ''}>≤ ${v} ${t('years')}</option>`).join('')}</select></label>
    <label>${t('max_fees')}<select data-filter="fees"><option value="">${t('all')}</option>${[0, 50000, 100000].map(v => `<option value="${v}"${f.fees !== '' && +f.fees === v ? ' selected' : ''}>${v ? '≤ ' + money(v) : t('free')}</option>`).join('')}</select></label>
    <label>${t('sort')}<select data-filter="sort">${['score', 'insertion', 'duration', 'fees'].map(s => `<option value="${s}"${f.sort === s ? ' selected' : ''}>${t('sort_' + s)}</option>`).join('')}</select></label>
  </div></section>
  <h2 style="margin-top:24px">${t('recommended')} (${rows.length})</h2>
  <section class="grid two">${rows.slice(0, shared ? 10 : 20).map((x, i) => programCard(x.r, x.p, x.us, fl, { open: i < 3, actions: !shared })).join('') || `<div class="empty">${t('no_results')}</div>`}</section>`;
}
V.results = async ([id]) => {
  if (!S.me) return needLogin();
  const [data, tests] = await Promise.all([api('GET', `/api/tests/${id}/recommendations`), api('GET', '/api/tests')]);
  const done = tests.filter(x => x.status === 'done'); const idx = done.findIndex(x => x.id === +id);
  const prev = done[idx + 1]?.result?.riasec;
  R.data = data; R.id = id;
  return `<div class="row between noprint"><h1>${t('results')}</h1>
    <div class="row"><button class="btn subtle" data-act="print">⤓ PDF</button><button class="btn subtle" data-act="share" data-id="${esc(id)}">${t('share')}</button></div></div>
    <div id="shareOut" class="noprint"></div>
    <div id="resBody">${await resultsBody(data, { prev })}</div>
    <section class="card noprint" style="margin-top:24px"><h2>${t('feedback_title')}</h2>
      <form class="f" data-form="feedback"><input type="hidden" name="testId" value="${esc(id)}"><input type="hidden" name="rating" value="">
      <div class="stars" role="radiogroup" aria-label="${t('rating')}">${[1, 2, 3, 4, 5].map(v => `<button type="button" data-act="star" data-v="${v}" aria-label="${v}/5">★</button>`).join('')}</div>
      <label>${t('comment')}<textarea name="comment" maxlength="2000"></textarea></label><button class="btn">${t('send')}</button></form></section>`;
};
V.share = async ([token]) => {
  const data = await api('GET', `/api/share/${encodeURIComponent(token)}`);
  R.data = data; R.shared = true;
  return `<h1>${t('shared_results')}</h1><div id="resBody">${await resultsBody(data, { shared: true })}</div>
    <div class="card" style="margin-top:24px;text-align:center"><p>${t('shared_cta')}</p><a class="btn" href="#/register">${t('cta_test')}</a></div>`;
};

// ----- Catalogue -----
const C = { tab: 'program', q: '', domain: '', city: '', type: '', dur: '' };
V.catalog = async ([tab]) => {
  if (tab) C.tab = tab;
  const [progs, unis, careers, fl] = await Promise.all([get('program'), get('university'), get('career'), favs()]);
  const q = C.q.trim().toLowerCase(), m = o => !q || JSON.stringify(o).toLowerCase().includes(q);
  const domains = [...new Set(progs.map(p => p.domain))], cities = [...new Set(unis.map(u => u.city))].sort();
  let items = '';
  if (C.tab === 'program') {
    const offeredIn = id => unis.filter(u => u.programs.includes(id));
    items = progs.filter(p => m(p) && (!C.domain || p.domain === C.domain) && (!C.dur || p.duration <= +C.dur) && (!C.city || offeredIn(p.id).some(u => u.city === C.city)) && (!C.type || offeredIn(p.id).some(u => u.type === C.type)))
      .map(p => `<article class="card"><h3><a href="#/prog/${esc(p.id)}">${tx(p.name)}</a></h3><p class="small muted">${tx(p.desc)}</p>
        <div class="row small"><span class="pill">${t('dom_' + p.domain)}</span><span class="pill gray">${p.duration} ${t('years')}</span><span class="pill ok">${t('insertion')} ${p.insertion}%</span></div>
        <div class="row" style="margin-top:10px">${favBtn(fl, 'program', p.id)}${cmpBtn('program', p.id)}</div></article>`).join('');
  } else if (C.tab === 'university') {
    items = unis.filter(u => m(u) && (!C.city || u.city === C.city) && (!C.type || u.type === C.type) && (!C.domain || u.programs.some(id => progs.find(p => p.id === id)?.domain === C.domain)))
      .map(u => `<article class="card"><h3><a href="#/uni/${esc(u.id)}">${tx(u.name)}</a></h3><p class="small muted">${tx(u.desc)}</p>
        <div class="row small"><span class="pill gray">📍 ${esc(u.city)}</span><span class="pill">${t(u.type)}</span><span class="pill gray">${money(u.fees)}</span><span class="pill gray">${u.programs.length} ${t('programs_n')}</span></div>
        <div class="row" style="margin-top:10px">${favBtn(fl, 'university', u.id)}${cmpBtn('university', u.id)}</div></article>`).join('');
  } else {
    items = careers.filter(c => m(c) && (!C.domain || c.programs.some(id => progs.find(p => p.id === id)?.domain === C.domain)))
      .map(c => `<article class="card"><h3><a href="#/career/${esc(c.id)}">${tx(c.name)}</a></h3><p class="small muted">${tx(c.desc)}</p>
        <div class="row small"><span class="pill gray">${esc(c.sector)}</span><span class="pill ${c.outlook === 'high' ? 'ok' : c.outlook === 'competitive' ? 'warn' : 'gray'}">${t('outlook_' + c.outlook)}</span></div>
        <div class="row" style="margin-top:10px">${favBtn(fl, 'career', c.id)}</div></article>`).join('');
  }
  return `<h1>${t('nav_catalog')}</h1>
    <div class="tabs" role="tablist">${['program', 'university', 'career'].map(k => `<a role="tab" aria-selected="${C.tab === k}" class="${C.tab === k ? 'on' : ''}" href="#/catalog/${k}">${t('tab_' + k)}</a>`).join('')}</div>
    <div class="card filters" style="margin-bottom:16px">
      <label>${t('search')}<input type="search" data-cfilter="q" value="${esc(C.q)}" placeholder="${t('search_ph')}"></label>
      <label>${t('domain')}<select data-cfilter="domain"><option value="">${t('all')}</option>${domains.map(d => `<option value="${d}"${C.domain === d ? ' selected' : ''}>${t('dom_' + d)}</option>`).join('')}</select></label>
      ${C.tab !== 'career' ? `<label>${t('city')}<select data-cfilter="city"><option value="">${t('all')}</option>${cities.map(c => `<option${C.city === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>${t('type')}<select data-cfilter="type"><option value="">${t('all')}</option><option value="public"${C.type === 'public' ? ' selected' : ''}>${t('public')}</option><option value="private"${C.type === 'private' ? ' selected' : ''}>${t('private')}</option></select></label>` : ''}
      ${C.tab === 'program' ? `<label>${t('level')}<select data-cfilter="dur"><option value="">${t('all')}</option>${[2, 3, 5, 7].map(v => `<option value="${v}"${C.dur == v ? ' selected' : ''}>≤ Bac+${v}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="grid">${items || `<div class="empty">${t('no_results')}</div>`}</div>
    <p class="small muted" style="margin-top:16px">${t('demo_data')}</p>`;
};

V.prog = async ([id]) => {
  const [p, unis, careers, fl] = [await byId('program', id), await get('university'), await get('career'), await favs()];
  if (!p) return `<div class="empty">${t('not_found')}</div>`;
  api('POST', `/api/content/program/${encodeURIComponent(id)}/view`).catch(() => {});
  const offer = unis.filter(u => u.programs.includes(id)), jobs = careers.filter(c => p.careers.includes(c.id));
  return `<div class="row between"><h1>${tx(p.name)}</h1><div class="row">${favBtn(fl, 'program', id)}${cmpBtn('program', id)}</div></div>
    <p class="lead">${tx(p.desc)}</p>
    <div class="grid two">
      <div class="card"><table><tbody>
        <tr><th>${t('domain')}</th><td>${t('dom_' + p.domain)}</td></tr><tr><th>${t('duration')}</th><td>${p.duration} ${t('years')}</td></tr>
        <tr><th>${t('diploma')}</th><td>${esc(p.diploma)}</td></tr><tr><th>${t('courses')}</th><td>${esc(p.courses)}</td></tr>
        <tr><th>${t('skills')}</th><td>${esc(p.skills)}</td></tr><tr><th>${t('further')}</th><td>${esc(p.further)}</td></tr>
        <tr><th>${t('prereq')}</th><td>${t('bac')} ${p.series.map(esc).join(', ')} · ${t('min_avg')} ${p.minAvg}/20</td></tr>
        <tr><th>${t('insertion')}</th><td>${p.insertion}%</td></tr></tbody></table></div>
      <div class="card"><h3>${t('riasec_profile')}</h3>${radar(Object.fromEntries(Object.entries(p.riasec).map(([k, v]) => [k, v * 100])))}</div>
    </div>
    <h2 style="margin-top:24px">${t('careers')}</h2><div class="grid">${jobs.map(c => `<a class="card" href="#/career/${esc(c.id)}" style="text-decoration:none;color:inherit"><b>${tx(c.name)}</b><p class="small muted">${tx(c.desc)}</p></a>`).join('')}</div>
    <h2 style="margin-top:24px">${t('where')}</h2><div class="grid">${offer.map(u => `<a class="card" href="#/uni/${esc(u.id)}" style="text-decoration:none;color:inherit"><b>${tx(u.name)}</b><div class="small muted">📍 ${esc(u.city)} · ${t(u.type)} · ${money(u.fees)}</div></a>`).join('')}</div>
    <p class="small muted" style="margin-top:16px">${t('demo_data')}</p>`;
};
V.uni = async ([id]) => {
  const [u, progs, fl] = [await byId('university', id), await get('program'), await favs()];
  if (!u) return `<div class="empty">${t('not_found')}</div>`;
  api('POST', `/api/content/university/${encodeURIComponent(id)}/view`).catch(() => {});
  const safeUrl = /^https?:\/\//.test(u.website || '') ? u.website : '';
  return `<div class="row between"><h1>${tx(u.name)}</h1><div class="row">${favBtn(fl, 'university', id)}${cmpBtn('university', id)}</div></div>
    <p class="lead">${tx(u.desc)}</p>
    <div class="card"><table><tbody>
      <tr><th>${t('city')}</th><td>${esc(u.city)}</td></tr><tr><th>${t('type')}</th><td>${t(u.type)}</td></tr>
      <tr><th>${t('fees')}</th><td>${money(u.fees)}</td></tr><tr><th>${t('admission')}</th><td>${esc(u.admission)}</td></tr>
      <tr><th>${t('contact')}</th><td>${esc(u.contact)}</td></tr>
      <tr><th>${t('website')}</th><td>${safeUrl ? `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">${esc(safeUrl)}</a>` : '—'}</td></tr></tbody></table></div>
    <h2 style="margin-top:24px">${t('programs_offered')}</h2>
    <div class="grid">${progs.filter(p => u.programs.includes(p.id)).map(p => `<a class="card" href="#/prog/${esc(p.id)}" style="text-decoration:none;color:inherit"><b>${tx(p.name)}</b><div class="small muted">${p.duration} ${t('years')} · ${esc(p.diploma)}</div></a>`).join('')}</div>
    <p class="small muted" style="margin-top:16px">${t('demo_data')}</p>`;
};
V.career = async ([id]) => {
  const [c, progs, fl] = [await byId('career', id), await get('program'), await favs()];
  if (!c) return `<div class="empty">${t('not_found')}</div>`;
  api('POST', `/api/content/career/${encodeURIComponent(id)}/view`).catch(() => {});
  return `<div class="row between"><h1>${tx(c.name)}</h1>${favBtn(fl, 'career', id)}</div><p class="lead">${tx(c.desc)}</p>
    <div class="card"><table><tbody><tr><th>${t('sector')}</th><td>${esc(c.sector)}</td></tr><tr><th>${t('outlook')}</th><td>${t('outlook_' + c.outlook)}</td></tr></tbody></table></div>
    <h2 style="margin-top:24px">${t('programs_leading')}</h2>
    <div class="grid">${progs.filter(p => c.programs.includes(p.id)).map(p => `<a class="card" href="#/prog/${esc(p.id)}" style="text-decoration:none;color:inherit"><b>${tx(p.name)}</b><div class="small muted">${p.duration} ${t('years')}</div></a>`).join('')}</div>`;
};

V.compare = async () => {
  const { kind, ids } = S.cmp;
  if (ids.length < 2) return `<div class="empty"><p>${t('compare_need')}</p><a class="btn" href="#/catalog">${t('nav_catalog')}</a></div>`;
  const items = (await get(kind)).filter(x => ids.includes(x.id));
  const progs = await get('program'), unis = await get('university');
  const rows = kind === 'program' ? [
    [t('domain'), p => t('dom_' + p.domain)], [t('duration'), p => `${p.duration} ${t('years')}`], [t('diploma'), p => esc(p.diploma)],
    [t('prereq'), p => `${p.series.join(', ')} · ≥ ${p.minAvg}/20`], [t('insertion'), p => `${p.insertion}%`], [t('courses'), p => esc(p.courses)],
    [t('skills'), p => esc(p.skills)], [t('nb_unis'), p => unis.filter(u => u.programs.includes(p.id)).length],
    [t('min_fees'), p => money(Math.min(...unis.filter(u => u.programs.includes(p.id)).map(u => u.fees)))],
  ] : [
    [t('city'), u => esc(u.city)], [t('type'), u => t(u.type)], [t('fees'), u => money(u.fees)], [t('admission'), u => esc(u.admission)],
    [t('programs_offered'), u => u.programs.map(id => tx(progs.find(p => p.id === id)?.name)).filter(Boolean).join(', ')],
  ];
  return `<div class="row between"><h1>${t('compare')}</h1><button class="btn subtle" data-act="print">⤓ PDF</button></div>
    <div class="card tablewrap"><table><thead><tr><th></th>${items.map(x => `<th><a href="#/${kind === 'program' ? 'prog' : 'uni'}/${esc(x.id)}">${tx(x.name)}</a> <button class="iconbtn noprint" data-act="cmp" data-kind="${kind}" data-id="${esc(x.id)}" aria-label="${t('remove')}">✕</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, fn]) => `<tr><th>${label}</th>${items.map(x => `<td>${fn(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
};

// ----- Espace personnel -----
V.dashboard = async () => {
  if (!S.me) return needLogin();
  const [tests, fl, notes, notifs, progs, unis, careers] = await Promise.all([api('GET', '/api/tests'), (S.cache.favs = null, favs()), api('GET', '/api/notes'), api('GET', '/api/notifications'), get('program'), get('university'), get('career')]);
  const done = tests.filter(x => x.status === 'done'), open = tests.find(x => x.status === 'in_progress');
  const lists = { program: progs, university: unis, career: careers }, path = { program: 'prog', university: 'uni', career: 'career' };
  const notifHtml = notifs.map(n => n.type === 'verify' ? `<li>${t('notif_verify')} ${resendBtn()}</li>` : n.type === 'takeTest' ? `<li><a href="#/test">${t('notif_test')}</a></li>`
    : n.type === 'reminder' ? `<li>⏰ ${date(n.due)} — ${esc(n.text)}</li>` : `<li>🔄 <a href="#/${path[n.kind]}/${esc(n.item_id)}">${tx(lists[n.kind]?.find(x => x.id === n.item_id)?.name)}</a> ${t('notif_updated')}</li>`).join('');
  return `<h1>${t('hello', { name: esc(S.me.name || '') })}</h1>
  ${notifHtml ? `<div class="card" style="margin-bottom:16px"><h2>🔔 ${t('notifications')}</h2><ul>${notifHtml}</ul></div>` : ''}
  <div class="grid two">
    <section class="card"><h2>${t('my_results')}</h2>
      ${open ? `<p><a class="btn sm" href="#/test">${t('resume_test')}</a></p>` : ''}
      ${done.length ? `${bars(done[0].result.riasec, done[1]?.result.riasec)}<p class="small muted">${t('profile_code')}: <b>${esc(done[0].result.code)}</b></p>
        <a class="btn sm" href="#/results/${done[0].id}">${t('see_results')}</a>
        <h3 style="margin-top:16px">${t('history')}</h3><table><tbody>${done.map(x => `<tr><td>${date(x.finished)}</td><td><span class="pill">${esc(x.result.code)}</span></td><td><a href="#/results/${x.id}">${t('open')}</a></td></tr>`).join('')}</tbody></table>`
        : `<p class="muted">${t('no_test')}</p><a class="btn" href="#/test">${t('start_test')}</a>`}
    </section>
    <section class="card"><h2>${t('shortlist')}</h2>
      ${fl.length ? `<ul>${fl.map(f => { const it = lists[f.kind]?.find(x => x.id === f.item_id); return it ? `<li><span class="pill gray">${t('kind_' + f.kind)}</span> <a href="#/${path[f.kind]}/${esc(f.item_id)}">${tx(it.name)}</a></li>` : ''; }).join('')}</ul>` : `<p class="muted">${t('no_favs')}</p>`}
    </section>
    <section class="card"><h2>${t('notes_reminders')}</h2>
      <form class="f" data-form="note"><label>${t('note')}<textarea name="text" required maxlength="2000" placeholder="${t('note_ph')}"></textarea></label>
        <label>${t('due_date')}<input type="date" name="due"></label><button class="btn sm">${t('add')}</button></form>
      <ul class="reasons" style="margin-top:14px">${notes.map(n => `<li>${n.due ? `<span class="pill ${n.due < new Date().toISOString().slice(0, 10) ? 'gray' : 'warn'}">${date(n.due)}</span> ` : ''}${esc(n.text)} <button class="iconbtn" data-act="del-note" data-id="${n.id}" aria-label="${t('remove')}">✕</button></li>`).join('')}</ul>
    </section>
  </div>`;
};

V.profile = async () => {
  if (!S.me) return needLogin();
  const p = S.me.profile;
  return `<h1>${t('nav_profile')}</h1><div class="grid two">
  <form class="card f" data-form="profile">
    ${S.query.get('new') ? `<div class="alert info">${t('sso_welcome')}</div>` : ''}
    ${!S.me.verified ? `<div class="alert row between">${t('notif_verify')} ${resendBtn()}</div>` : ''}
    <label>${t('name')}<input name="name" value="${esc(S.me.name)}" maxlength="100"></label>
    <label>${t('age')}<input name="age" type="number" min="12" max="99" value="${esc(p.age)}"></label>
    <label>${t('bac_series')}<select name="bac"><option value="">—</option>${['SM', 'PC', 'SVT', 'STE', 'ECO', 'LET', 'ART'].map(s => `<option value="${s}"${p.bac === s ? ' selected' : ''}>${t('bac_' + s)}</option>`).join('')}</select></label>
    <label>${t('average')}<input name="average" type="number" step="0.01" min="0" max="20" value="${esc(p.average)}"></label>
    <label>${t('city')}<input name="city" value="${esc(p.city)}" list="cities"></label><datalist id="cities">${[...new Set((await get('university')).map(u => u.city))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label>${t('languages')}<input name="languages" value="${esc(p.languages)}" placeholder="Arabe, Français, Anglais"></label>
    <label>${t('type_pref')}<select name="typePref">${['any', 'public', 'private'].map(v => `<option value="${v}"${p.typePref === v ? ' selected' : ''}>${t(v === 'any' ? 'any' : v)}</option>`).join('')}</select></label>
    <label>${t('budget')}<input name="budget" type="number" min="0" step="1000" value="${esc(p.budget)}"></label>
    <button class="btn">${t('save')}</button>
  </form>
  <div class="stack">
    <form class="card f" data-form="password"><h2>${S.me.hasPassword ? t('change_password') : t('set_password')}</h2>
      ${S.me.sso ? `<p class="small muted">${t('sso_linked')}</p>` : ''}
      ${S.me.hasPassword ? `<label>${t('current_password')}<input type="password" name="current" required autocomplete="current-password"></label>` : ''}
      <label>${t('new_password')}<input type="password" name="password" minlength="8" required autocomplete="new-password"></label><button class="btn subtle">${t('save')}</button></form>
    <div class="card"><h2>${t('my_data')}</h2><p class="small muted">${t('gdpr')}</p>
      <div class="row"><a class="btn subtle" href="/api/me/export" download>${t('export')}</a><button class="btn danger" data-act="delete-me">${t('delete_account')}</button></div></div>
  </div></div>`;
};

// ----- Administration -----
const A = { tab: 'stats', kind: 'program', edit: null };
V.admin = async ([tab]) => {
  if (!S.me || !['admin', 'editor'].includes(S.me.role)) return `<div class="empty">${t('err_forbidden')}</div>`;
  if (tab) A.tab = tab;
  const tabs = ['stats', 'content', 'weights', 'import', 'feedback', ...(S.me.role === 'admin' ? ['users'] : [])];
  let body = '';
  if (A.tab === 'stats') {
    const s = await api('GET', '/api/admin/stats'); const progs = await get('program');
    const name = id => tx(progs.find(p => p.id === id)?.name) || esc(id);
    const maxTop = Math.max(1, ...s.topPrograms.map(x => x[1]));
    body = `<div class="grid">${[[t('kpi_users'), s.users], [t('kpi_started'), s.started], [t('kpi_completion'), s.completion + '%'], [t('kpi_satisfaction'), s.satisfaction ? s.satisfaction + '/5 (' + s.feedbackCount + ')' : '—']]
      .map(([l, v]) => `<div class="card"><div class="small muted">${l}</div><div class="kpi">${v}</div></div>`).join('')}</div>
      <div class="grid two" style="margin-top:16px"><div class="card"><h3>${t('top_programs')}</h3><div class="bars">${s.topPrograms.map(([id, n]) => `<div class="bar"><span>${name(id)}</span><span class="track"><i style="width:${n / maxTop * 100}%;background:var(--pri)"></i></span><span>${n}</span></div>`).join('') || `<p class="muted">—</p>`}</div></div>
      <div class="card"><h3>${t('most_viewed')}</h3><table><tbody>${s.views.map(v => `<tr><td><span class="pill gray">${t('kind_' + v.kind)}</span></td><td>${esc(v.id)}</td><td>${v.views}</td></tr>`).join('')}</tbody></table>
      <h3 style="margin-top:14px">${t('most_fav')}</h3><table><tbody>${s.favs.map(v => `<tr><td><span class="pill gray">${t('kind_' + v.kind)}</span></td><td>${esc(v.item_id)}</td><td>${v.n}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><h3>${t('signups_30d')}</h3><table><tbody>${s.byDay.map(d => `<tr><td>${esc(d.day)}</td><td>${d.n}</td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div></div>`;
  } else if (A.tab === 'users') {
    const [users, unis] = await Promise.all([api('GET', '/api/admin/users'), get('university')]);
    body = `<div class="card tablewrap"><table><thead><tr><th>Email</th><th>${t('name')}</th><th>${t('role')}</th><th>${t('university')}</th><th>${t('blocked')}</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr data-user="${u.id}"><td>${esc(u.email)} ${u.verified ? '✓' : ''}<div class="small muted">${date(u.created)}</div></td><td>${esc(u.name)}</td>
        <td><select data-f="role">${['student', 'counsellor', 'partner', 'editor', 'admin'].map(r => `<option${u.role === r ? ' selected' : ''}>${r}</option>`).join('')}</select></td>
        <td><select data-f="partner_uni"><option value="">—</option>${unis.map(x => `<option value="${esc(x.id)}"${u.partner_uni === x.id ? ' selected' : ''}>${esc(x.id)}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-f="blocked"${u.blocked ? ' checked' : ''}></td>
        <td class="row"><button class="btn sm" data-act="user-save" data-id="${u.id}">${t('save')}</button><button class="btn sm danger" data-act="user-del" data-id="${u.id}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  } else if (A.tab === 'content') {
    const rows = await api('GET', `/api/admin/content/${A.kind}`);
    const editing = A.edit === '__new' ? TEMPLATES[A.kind] : rows.find(r => r.id === A.edit)?.data;
    body = `<div class="tabs">${['program', 'university', 'career', 'question'].map(k => `<button class="${A.kind === k ? 'on' : ''}" data-act="akind" data-k="${k}">${t('kind_' + k)}</button>`).join('')}
      <button class="btn sm" data-act="aedit" data-id="__new">+ ${t('add')}</button></div>
      ${editing ? `<form class="card f" data-form="content" style="margin-bottom:16px"><input type="hidden" name="orig" value="${esc(A.edit === '__new' ? '' : A.edit)}">
        <label>JSON<textarea class="code" name="json" spellcheck="false">${esc(JSON.stringify(editing, null, 2))}</textarea></label>
        <div class="row"><button class="btn">${t('save')}</button><button type="button" class="btn subtle" data-act="aedit" data-id="">${t('cancel')}</button></div>
        <p class="small muted">${t('content_help')}</p></form>` : ''}
      <div class="card tablewrap"><table><thead><tr><th>id</th><th>${t('name')}</th><th>${t('views')}</th><th>${t('updated')}</th><th></th></tr></thead><tbody>
      ${rows.sort((a, b) => (a.data.order || 0) - (b.data.order || 0) || a.id.localeCompare(b.id)).map(r => `<tr><td><code>${esc(r.id)}</code></td><td>${tx(r.data.name || r.data.text)}</td><td>${r.views}</td><td class="small">${date(r.updated)}</td>
        <td class="row"><button class="btn sm subtle" data-act="aedit" data-id="${esc(r.id)}">${t('edit')}</button><button class="btn sm danger" data-act="adel" data-id="${esc(r.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>`;
  } else if (A.tab === 'weights') {
    const w = await api('GET', '/api/admin/weights');
    body = `<form class="card f narrow" data-form="weights"><p class="small muted">${t('weights_help')}</p>
      ${Object.entries(w).map(([k, v]) => `<label>${t('w_' + k)}<input type="number" name="${k}" value="${v}" step="0.05" min="0" max="1" required></label>`).join('')}
      <button class="btn">${t('save')}</button></form>`;
  } else if (A.tab === 'import') {
    body = `<form class="card f" data-form="import"><p>${t('import_help')}</p>
      <pre class="small" style="white-space:pre-wrap;background:var(--bg);padding:10px;border-radius:8px">id,name_fr,name_en,city,type,fees,programs,website
ucd,Université Chouaib Doukkali,Chouaib Doukkali University,El Jadida,public,0,droit|eco-gestion|biologie,https://www.ucd.ac.ma</pre>
      <label>${t('kind')}<select name="kind"><option value="university">${t('kind_university')}</option><option value="program">${t('kind_program')}</option><option value="career">${t('kind_career')}</option></select></label>
      <label>CSV<input type="file" name="file" accept=".csv,text/csv" required></label><button class="btn">${t('import')}</button><div id="importOut"></div></form>`;
  } else if (A.tab === 'feedback') {
    const d = await api('GET', '/api/admin/feedback');
    body = `<div class="grid two"><div class="card"><h3>${t('feedback_title')}</h3><table><tbody>${d.feedback.map(f => `<tr><td>${'★'.repeat(f.rating)}</td><td>${esc(f.comment)}<div class="small muted">${esc(f.email || '')} · ${date(f.created)}</div></td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div>
      <div class="card"><h3>${t('messages')}</h3><table><tbody>${d.messages.map(m => `<tr><td><b>${esc(m.name)}</b> &lt;${esc(m.email)}&gt;<div>${esc(m.body)}</div><div class="small muted">${date(m.created)}</div></td></tr>`).join('') || '<tr><td>—</td></tr>'}</tbody></table></div></div>`;
  }
  return `<h1>${t('nav_admin')}</h1><div class="tabs">${tabs.map(k => `<a class="${A.tab === k ? 'on' : ''}" href="#/admin/${k}">${t('admin_' + k)}</a>`).join('')}</div>${body}`;
};
const TEMPLATES = {
  program: { id: 'nouvelle-filiere', name: { fr: '', en: '', ar: '' }, domain: 'sciences', duration: 3, diploma: 'Licence', series: ['SM', 'PC'], minAvg: 12, riasec: { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 }, subjects: [], insertion: 70, careers: [], desc: { fr: '', en: '' }, courses: '', skills: '', further: '' },
  university: { id: 'nouvelle-universite', name: { fr: '', en: '', ar: '' }, city: '', type: 'public', fees: 0, programs: [], desc: { fr: '', en: '' }, admission: '', contact: '', website: 'https://' },
  career: { id: 'nouveau-metier', name: { fr: '', en: '', ar: '' }, sector: '', outlook: 'stable', desc: { fr: '', en: '' }, programs: [] },
  question: { id: 'q99', cat: 'interests', type: 'scale', dims: { I: 1 }, text: { fr: '', en: '', ar: '' }, order: 99, version: 1 },
};

V.partner = async () => {
  if (S.me?.role !== 'partner') return `<div class="empty">${t('err_forbidden')}</div>`;
  let d; try { d = await api('GET', '/api/partner'); } catch (e) { return `<div class="empty">${errMsg(e)}</div>`; }
  return `<h1>${t('nav_partner')} — ${tx(d.university.name)}</h1>
    <div class="grid"><div class="card"><div class="small muted">${t('views')}</div><div class="kpi">${d.views}</div></div><div class="card"><div class="small muted">${t('favorites')}</div><div class="kpi">${d.favorites}</div></div></div>
    <p class="small muted">${t('partner_privacy')}</p>
    <form class="card f" data-form="partner" style="margin-top:16px"><h2>${t('edit_sheet')}</h2><textarea class="code" name="json" spellcheck="false">${esc(JSON.stringify(d.university, null, 2))}</textarea><button class="btn">${t('save')}</button></form>`;
};

V.contact = async () => `<div class="card narrow"><h1>${t('contact')}</h1><form class="f" data-form="contact">
  <label>${t('name')}<input name="name" value="${esc(S.me?.name || '')}" maxlength="100"></label><label>${t('email')}<input name="email" type="email" value="${esc(S.me?.email || '')}" required></label>
  <label>${t('message')}<textarea name="body" required maxlength="5000"></textarea></label><button class="btn">${t('send')}</button></form></div>`;
V.privacy = async () => `<div class="card" style="max-width:760px;margin:0 auto"><h1>${t('privacy')}</h1>${t('privacy_text').split('\n').map(p => `<p>${p}</p>`).join('')}</div>`;

// ---------- Routeur ----------
const resendBtn = () => `<button class="btn sm subtle" data-act="resend-verify">${t('resend_verify')}</button>`;
async function route() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  S.query = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  let name = parts[0] || 'home', args = parts.slice(1);
  if (name === 'test' && args[0] === 'run') { name = 'test/run'; args = []; }
  const view = V[name] || V.home;
  renderNav(name); renderCmpBar();
  const main = $('#main');
  try { main.innerHTML = await view(args); }
  catch (e) { main.innerHTML = e.status === 401 ? needLogin() : `<div class="empty">${errMsg(e)}</div>`; }
  document.title = (main.querySelector('h1')?.textContent || 'Cap Orientation') + (name === 'home' ? '' : ' · Cap Orientation');
  $('#nav').classList.remove('open');
}
async function refreshMe() { S.me = await api('GET', '/api/me').catch(() => null); }

// ---------- Événements ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, d = el.dataset;
  if (el.tagName === 'SELECT') return;
  try {
    if (act === 'menu') { const n = $('#nav'); n.classList.toggle('open'); el.setAttribute('aria-expanded', n.classList.contains('open')); }
    else if (act === 'logout') { await api('POST', '/api/auth/logout'); S.me = null; S.cache.favs = null; location.hash = '#/'; route(); }
    else if (act === 'resend-verify') {
      const r = await api('POST', '/api/auth/resend-verification'); el.disabled = true; toast(t('verify_sent'));
      if (r.devLink) console.info('[dev] verification link:', r.devLink);
    }
    else if (act === 'fav') {
      const fl = await favs(), on = isFav(fl, d.kind, d.id);
      await (on ? api('DELETE', `/api/favorites/${d.kind}/${encodeURIComponent(d.id)}`) : api('POST', '/api/favorites', { kind: d.kind, id: d.id }));
      S.cache.favs = null; toast(on ? t('fav_removed') : t('fav_added')); keepScroll(route);
    }
    else if (act === 'cmp') keepScroll(() => toggleCmp(d.kind, d.id));
    else if (act === 'cmp-clear') { S.cmp = { kind: null, ids: [] }; store('cmp', JSON.stringify(S.cmp)); renderCmpBar(); route(); }
    else if (act === 'test-start') { T.test = null; await startTest(d.fresh); }
    else if (act === 'ans') { const q = S.questions[T.i]; T.test.answers[q.id] = q.type === 'scale' ? +d.v : d.v; saveAnswers(); if (T.i < S.questions.length - 1) T.i++; await route(); focusQ(); }
    else if (act === 'multi') {
      const q = S.questions[T.i], cur = new Set(T.test.answers[q.id] || []);
      if (cur.has(d.v)) cur.delete(d.v); else if (cur.size < q.max) cur.add(d.v); else return toast(t('pick_up_to', { n: q.max }));
      T.test.answers[q.id] = cur.size ? [...cur] : undefined; saveAnswers(); await route();
    }
    else if (act === 'rank' || act === 'rank-ok') {
      const q = S.questions[T.i], order = [...(T.test.answers[q.id] || q.options.map(o => o.v))];
      if (act === 'rank') { const i = +d.i, j = i + +d.d; [order[i], order[j]] = [order[j], order[i]]; }
      T.test.answers[q.id] = order; saveAnswers(); await route();
    }
    else if (act === 'prev') { T.i--; await route(); focusQ(); }
    else if (act === 'next') { T.i++; await route(); focusQ(); }
    else if (act === 'finish') {
      clearTimeout(T.saveTimer); await api('PUT', `/api/tests/${T.test.id}/answers`, { answers: T.test.answers });
      const { id } = await api('POST', `/api/tests/${T.test.id}/finish`); T.test = null; location.hash = `#/results/${id}`;
    }
    else if (act === 'print') window.print();
    else if (act === 'share') {
      const { share } = await api('POST', `/api/tests/${d.id}/share`); const link = `${location.origin}/#/share/${share}`;
      navigator.clipboard?.writeText(link).then(() => toast(t('link_copied'))).catch(() => {});
      $('#shareOut').innerHTML = `<div class="alert info row between"><input readonly value="${esc(link)}" style="flex:1;min-width:200px">
        <a class="btn sm" href="mailto:?subject=${encodeURIComponent(DICT[S.lang].share_subject)}&body=${encodeURIComponent(link)}">${t('by_email')}</a>
        <button class="btn sm subtle" data-act="unshare" data-id="${esc(d.id)}">${t('unshare')}</button></div>`;
    }
    else if (act === 'unshare') { await api('DELETE', `/api/tests/${d.id}/share`); $('#shareOut').innerHTML = ''; toast(t('unshared')); }
    else if (act === 'star') { const f = el.closest('form'); f.rating.value = d.v; f.querySelectorAll('.stars button').forEach(b => b.classList.toggle('on', +b.dataset.v <= +d.v)); }
    else if (act === 'del-note') { await api('DELETE', `/api/notes/${d.id}`); route(); }
    else if (act === 'delete-me') {
      if (!confirm(t('confirm_delete'))) return;
      await api('DELETE', '/api/me'); S.me = null; location.hash = '#/'; toast(t('deleted'));
    }
    else if (act === 'akind') { A.kind = d.k; A.edit = null; route(); }
    else if (act === 'aedit') { A.edit = d.id || null; await route(); if (A.edit) $('textarea.code')?.focus(); }
    else if (act === 'adel') { if (confirm(t('confirm'))) { await api('DELETE', `/api/admin/content/${A.kind}/${encodeURIComponent(d.id)}`); S.cache = {}; S.questions = null; route(); } }
    else if (act === 'user-save') {
      const tr = el.closest('tr'), v = f => tr.querySelector(`[data-f=${f}]`);
      await api('PUT', `/api/admin/users/${d.id}`, { role: v('role').value, partner_uni: v('partner_uni').value, blocked: v('blocked').checked }); toast(t('saved'));
    }
    else if (act === 'user-del') { if (confirm(t('confirm'))) { await api('DELETE', `/api/admin/users/${d.id}`); route(); } }
  } catch (err) { toast(errMsg(err)); }
});
const focusQ = () => $('#qtext')?.focus?.();
async function keepScroll(fn) { const y = scrollY; await fn(); scrollTo(0, y); }

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.act === 'lang') { setLang(el.value); if (S.me) api('PUT', '/api/me', { name: S.me.name, profile: { ...S.me.profile, lang: el.value } }).catch(() => {}); return route(); }
  if (el.dataset.filter) { R.filters[el.dataset.filter] = el.value; $('#resBody').innerHTML = await resultsBody(R.data, { shared: !!R.shared }); return; }
  if (el.dataset.cfilter && el.tagName === 'SELECT') { C[el.dataset.cfilter] = el.value; return keepScroll(route); }
  if (el.name === 'age' && el.form?.dataset.form === 'register') $('#parentWrap').hidden = !(+el.value < 18);
});
let searchTimer;
document.addEventListener('input', e => {
  if (e.target.dataset.cfilter === 'q') { clearTimeout(searchTimer); searchTimer = setTimeout(async () => { C.q = e.target.value; const pos = e.target.selectionStart; await route(); const i = $('[data-cfilter=q]'); i.focus(); i.setSelectionRange(pos, pos); }, 250); }
});

document.addEventListener('submit', async e => {
  const f = e.target, kind = f.dataset.form; if (!kind) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(f)); const btn = f.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try {
    if (kind === 'login') { await api('POST', '/api/auth/login', v); await refreshMe(); if (S.me.profile.lang) setLang(S.me.profile.lang); location.hash = '#/dashboard'; }
    else if (kind === 'register') {
      const minor = +v.age < 18;
      const r = await api('POST', '/api/auth/register', { name: v.name, email: v.email, password: v.password, consent: !!v.consent, minor, parentConsent: !!v.parentConsent, lang: S.lang, profile: { age: v.age } });
      await refreshMe(); if (r.devLink) console.info('[dev] verification link:', r.devLink);
      toast(t('welcome')); location.hash = '#/profile';
    }
    else if (kind === 'forgot') { const r = await api('POST', '/api/auth/forgot', v); $('#out').innerHTML = `<div class="alert info">${t('link_sent')}${r.devLink ? `<br><small>[dev] <a href="${esc(r.devLink)}">${t('open')}</a></small>` : ''}</div>`; }
    else if (kind === 'reset') { await api('POST', '/api/auth/reset', v); toast(t('pw_changed')); location.hash = '#/login'; }
    else if (kind === 'profile') {
      const { name, ...profile } = v; await api('PUT', '/api/me', { name, profile: { ...profile, lang: S.lang } }); await refreshMe(); toast(t('saved')); route();
    }
    else if (kind === 'password') { await api('POST', '/api/me/password', v); f.reset(); toast(t('pw_changed')); }
    else if (kind === 'note') { await api('POST', '/api/notes', v); route(); }
    else if (kind === 'feedback') { if (!v.rating) return toast(t('pick_rating')); await api('POST', '/api/feedback', v); f.innerHTML = `<p>${t('thanks')}</p>`; }
    else if (kind === 'contact') { await api('POST', '/api/contact', v); f.innerHTML = `<p>${t('thanks')}</p>`; }
    else if (kind === 'weights') { await api('PUT', '/api/admin/weights', v); toast(t('saved')); }
    else if (kind === 'content') {
      let data; try { data = JSON.parse(v.json); } catch { return toast(t('err_bad_json')); }
      await api('PUT', `/api/admin/content/${A.kind}/${encodeURIComponent(v.orig || data.id)}`, { data });
      S.cache = {}; S.questions = null; A.edit = null; toast(t('saved')); route();
    }
    else if (kind === 'partner') { let data; try { data = JSON.parse(v.json); } catch { return toast(t('err_bad_json')); } await api('PUT', '/api/partner', { data }); S.cache = {}; toast(t('saved')); }
    else if (kind === 'import') {
      const rows = csvToRows(await f.file.files[0].text());
      const r = await api('POST', `/api/admin/import/${v.kind}`, { rows }); S.cache = {};
      $('#importOut').innerHTML = `<div class="alert info">${t('imported', { n: r.imported })}${r.errors.length ? '<br>' + r.errors.map(x => `L${x.row}: ${esc(x.error)}`).join('<br>') : ''}</div>`;
    }
  } catch (err) { toast(errMsg(err)); }
  finally { if (btn && document.contains(btn)) btn.disabled = false; }
});

// CSV → objets : colonnes name_fr/name_en → {fr,en} ; listes séparées par "|" ; riasec "R:0.5|I:1"
function csvToRows(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',' || ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(c => c !== '')) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) rows.push(row);
  const [head, ...data] = rows; const LISTS = ['programs', 'series', 'subjects', 'careers'];
  return data.map(r => {
    const o = {};
    head.forEach((h, i) => {
      h = h.trim(); const val = (r[i] ?? '').trim(); const m = h.match(/^(\w+)_(fr|en|ar)$/);
      if (m) (o[m[1]] ||= {})[m[2]] = val;
      else if (LISTS.includes(h)) o[h] = val ? val.split('|').map(s => s.trim()) : [];
      else if (h === 'riasec') o.riasec = Object.fromEntries(val.split('|').map(p => p.split(':')).map(([k, n]) => [k.trim(), +n]));
      else o[h] = val !== '' && !isNaN(val) && !['id', 'contact'].includes(h) ? +val : val;
    });
    return o;
  });
}

// ---------- Démarrage ----------
setLang(S.lang);
window.addEventListener('hashchange', () => { route(); scrollTo(0, 0); });
S.query = new URLSearchParams();
[S.config] = await Promise.all([api('GET', '/api/config').catch(() => ({})), refreshMe()]);
if (S.me?.profile?.lang && !store('lang')) setLang(S.me.profile.lang);
route();
