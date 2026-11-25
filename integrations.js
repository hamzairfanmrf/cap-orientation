// Intégrations tierces : envoi d'e-mails (Resend / Brevo / SendGrid) et connexion OpenID Connect (Google, Auth0, …).
// Tout est configuré par variables d'environnement ; sans configuration, les e-mails sont journalisés en console.
import crypto from 'node:crypto';

const env = k => process.env[k] || '';

// ---------------- E-mail ----------------
export const mailConfigured = () => !!(env('EMAIL_PROVIDER') && env('EMAIL_API_KEY') && env('EMAIL_FROM'));

function parseFrom(s) { const m = s.match(/^\s*(.*?)\s*<(.+)>\s*$/); return m ? { name: m[1], email: m[2] } : { name: 'Cap Orientation', email: s.trim() }; }

/** Envoie un e-mail. Ne lève jamais d'exception : renvoie true/false. */
export async function sendMail(to, subject, html) {
  if (!mailConfigured()) { console.log(`[mail:console] to=${to} | ${subject}\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`); return false; }
  const provider = env('EMAIL_PROVIDER').toLowerCase(), key = env('EMAIL_API_KEY'), from = parseFrom(env('EMAIL_FROM'));
  const req = {
    resend: ['https://api.resend.com/emails', { Authorization: `Bearer ${key}` }, { from: `${from.name} <${from.email}>`, to: [to], subject, html }],
    brevo: ['https://api.brevo.com/v3/smtp/email', { 'api-key': key }, { sender: from, to: [{ email: to }], subject, htmlContent: html }],
    sendgrid: ['https://api.sendgrid.com/v3/mail/send', { Authorization: `Bearer ${key}` }, { personalizations: [{ to: [{ email: to }] }], from, subject, content: [{ type: 'text/html', value: html }] }],
  }[provider];
  if (!req) { console.error(`[mail] EMAIL_PROVIDER inconnu : ${provider} (resend | brevo | sendgrid)`); return false; }
  try {
    const res = await fetch(req[0], { method: 'POST', headers: { 'Content-Type': 'application/json', ...req[1] }, body: JSON.stringify(req[2]), signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.error(`[mail] ${provider} ${res.status}: ${(await res.text()).slice(0, 300)}`); return false; }
    return true;
  } catch (e) { console.error(`[mail] ${provider} error: ${e.message}`); return false; }
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = {
  verify: { fr: ['Vérifiez votre adresse e-mail', 'Bienvenue sur Cap Orientation ! Confirmez votre adresse pour sécuriser votre compte.', 'Vérifier mon e-mail'],
    en: ['Verify your email address', 'Welcome to Cap Orientation! Confirm your address to secure your account.', 'Verify my email'],
    ar: ['تحقق من بريدك الإلكتروني', 'مرحباً بك في Cap Orientation! أكّد عنوانك لتأمين حسابك.', 'تحقق من بريدي'] },
  reset: { fr: ['Réinitialisation du mot de passe', 'Vous avez demandé à changer votre mot de passe. Ce lien est valable 1 heure. Si ce n’est pas vous, ignorez cet e-mail.', 'Choisir un nouveau mot de passe'],
    en: ['Reset your password', 'You asked to change your password. This link is valid for 1 hour. If it wasn’t you, ignore this email.', 'Choose a new password'],
    ar: ['إعادة تعيين كلمة المرور', 'طلبت تغيير كلمة المرور. هذا الرابط صالح لمدة ساعة. إذا لم تكن أنت، تجاهل هذه الرسالة.', 'اختيار كلمة مرور جديدة'] },
  reminder: { fr: ['Rappel : {text}', 'Échéance le {due} : {text}', 'Ouvrir mon espace'],
    en: ['Reminder: {text}', 'Due on {due}: {text}', 'Open my space'],
    ar: ['تذكير: {text}', 'الموعد {due}: {text}', 'فتح فضائي'] },
};
/** Construit {subject, html} pour un modèle d'e-mail, dans la langue de l'utilisateur. */
export function template(kind, lang, link, vars = {}) {
  const [subject, body, cta] = (T[kind][lang] || T[kind].fr).map(s => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''));
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return { subject, html: `<div dir="${dir}" style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:24px;color:#1b1a2e">
    <h2 style="color:#5b4ef0">◆ Cap Orientation</h2><p>${esc(body)}</p>
    <p><a href="${esc(link)}" style="display:inline-block;background:#5b4ef0;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">${esc(cta)}</a></p>
    <p style="color:#5f5d78;font-size:13px">${esc(link)}</p></div>` };
}

// ---------------- OpenID Connect (Google, Auth0, Microsoft, Keycloak…) ----------------
export const oidcConfigured = () => !!(env('OIDC_ISSUER') && env('OIDC_CLIENT_ID') && env('OIDC_CLIENT_SECRET'));
export const oidcName = () => env('OIDC_NAME') || (env('OIDC_ISSUER').includes('google') ? 'Google' : 'SSO');

let discovery = null;
async function discover() {
  if (discovery && discovery.iss === env('OIDC_ISSUER')) return discovery.doc;
  const iss = env('OIDC_ISSUER').replace(/\/$/, '');
  const res = await fetch(`${iss}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('oidc_discovery_failed');
  const doc = await res.json(); discovery = { iss: env('OIDC_ISSUER'), doc }; return doc;
}
const b64url = buf => buf.toString('base64url');

/** Étape 1 : URL d'autorisation (+ secrets à stocker côté serveur, liés au state). */
export async function oidcStart(redirectUri) {
  const doc = await discover();
  const state = b64url(crypto.randomBytes(24)), nonce = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const u = new URL(doc.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: env('OIDC_CLIENT_ID'), redirect_uri: redirectUri, scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })) u.searchParams.set(k, v);
  return { url: u.toString(), state, nonce, verifier };
}

/** Étape 2 : échange du code → identité vérifiée {sub, email, email_verified, name}. */
export async function oidcFinish({ code, redirectUri, nonce, verifier }) {
  const doc = await discover();
  const res = await fetch(doc.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env('OIDC_CLIENT_ID'), client_secret: env('OIDC_CLIENT_SECRET'), code_verifier: verifier }),
  });
  if (!res.ok) throw new Error('oidc_token_failed');
  const { id_token } = await res.json(); if (!id_token) throw new Error('oidc_no_id_token');
  // Jeton reçu directement du token endpoint via TLS avec authentification client : la validation TLS
  // remplace la vérification de signature (OpenID Connect Core §3.1.3.7). On vérifie les claims.
  const claims = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64url').toString('utf8'));
  const aud = [].concat(claims.aud);
  const issOk = claims.iss === doc.issuer || claims.iss?.replace(/\/$/, '') === doc.issuer?.replace(/\/$/, '');
  if (!issOk || !aud.includes(env('OIDC_CLIENT_ID')) || claims.exp * 1000 < Date.now() - 60000 || claims.nonce !== nonce) throw new Error('oidc_invalid_token');
  return { sub: claims.sub, email: String(claims.email || '').toLowerCase(), email_verified: claims.email_verified === true || claims.email_verified === 'true', name: claims.name || '' };
}
