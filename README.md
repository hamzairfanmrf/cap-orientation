# Cap Orientation — MVP

University orientation platform (per the *cahier des charges*). Zero dependencies: Node ≥ 22.5 (built-in SQLite) + vanilla JS SPA. FR / EN / AR (RTL).

```bash
npm start          # http://localhost:3000
npm test           # API tests (in-memory DB)
```

First run creates an admin: `admin@orientation.local` / `admin1234` (override with `ADMIN_EMAIL`, `ADMIN_PASSWORD`).
Env: `PORT`, `DB_PATH`, `BASE_URL` (set to your https URL in prod → Secure cookies), `NODE_ENV=production` (hides dev links).

| File | Role |
|---|---|
| `server.js` | REST API, auth (scrypt, HttpOnly SameSite cookies, CSRF header, rate limit), SQLite schema |
| `engine.js` | Recommendation engine v1 — weighted rules, every score explained |
| `seed.js` | Demo data: 20 programmes, 12 institutions, 25 careers, 24-question RIASEC test |
| `public/` | SPA: test, results, catalog, compare, dashboard, admin, partner space |

## Email + external login (`cp .env.example .env`)

Without keys, emails print to the console and the SSO button is hidden.

**Email (Resend, ~5 min):** sign up at resend.com → *Domains* → add & verify your domain (DNS records) → *API Keys* → create.
Set `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY=re_…`, `EMAIL_FROM=Cap Orientation <no-reply@your-domain>`.
(Brevo: `EMAIL_PROVIDER=brevo`, key from *SMTP & API → API keys*, verified sender. SendGrid: `sendgrid`.)
Sends: verification, password reset, deadline reminders (hourly job, the day before / day of).

**Login with Google directly:** console.cloud.google.com → *APIs & Services → OAuth consent screen* (External) →
*Credentials → Create OAuth client ID → Web application* → Authorized redirect URI: `{BASE_URL}/api/auth/oidc/callback`.
Set `OIDC_ISSUER=https://accounts.google.com`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`.

**…or via Auth0** (adds Microsoft/Apple/Facebook from its dashboard): create a *Regular Web Application* →
Allowed Callback URL: `{BASE_URL}/api/auth/oidc/callback` → enable *google-oauth2* under *Social*.
Set `OIDC_ISSUER=https://YOUR-TENANT.auth0.com/`, client ID/secret from the app, `OIDC_NAME=Google`.

Accounts are linked by verified email; SSO users can also set a password from their profile.
**Data:** seed data is for demonstration and must be checked against official sources.
