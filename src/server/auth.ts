import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig, saveConfig } from '../cli/config.js';

const COOKIE_NAME = 'swarmie-auth';

function hashPassword(pwd: string): string {
  return createHash('sha256').update(pwd).digest('hex');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

const PAGE_STYLE = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: var(--header-bg); border-radius: 12px; padding: 2rem; width: 100%; max-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; text-align: center; }
    .subtitle { font-size: 0.875rem; color: var(--text-secondary); text-align: center; margin-bottom: 1.5rem; }
    label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: var(--text-secondary); }
    input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--selected-bg); color: var(--fg); font-size: 1rem; outline: none; margin-bottom: 0.75rem; }
    input[type="password"]:focus { border-color: var(--accent); }
    button { width: 100%; padding: 0.75rem; margin-top: 0.5rem; border: none; border-radius: 8px; background: var(--accent); color: #fff; font-size: 1rem; cursor: pointer; font-weight: 600; }
    button:hover { opacity: 0.85; }
    .error { color: var(--error); font-size: 0.875rem; margin-top: 0.75rem; text-align: center; display: none; }
`;

// Theme data embedded for login/setup pages (mirrors src/web/themes.ts)
const THEME_SCRIPT = `<script>
(function() {
  var themes = {
    'github-dark': { bg:'#0d1117', fg:'#c9d1d9', headerBg:'#161b22', border:'#30363d', textSecondary:'#8b949e', accent:'#58a6ff', selectedBg:'#0d1117', error:'#f85149' },
    'dracula': { bg:'#282a36', fg:'#f8f8f2', headerBg:'#21222c', border:'#44475a', textSecondary:'#6272a4', accent:'#8be9fd', selectedBg:'#282a36', error:'#ff5555' },
    'nord': { bg:'#2e3440', fg:'#d8dee9', headerBg:'#3b4252', border:'#4c566a', textSecondary:'#81a1c1', accent:'#88c0d0', selectedBg:'#2e3440', error:'#bf616a' },
    'monokai': { bg:'#272822', fg:'#f8f8f2', headerBg:'#1e1f1c', border:'#3e3d32', textSecondary:'#75715e', accent:'#66d9ef', selectedBg:'#272822', error:'#f92672' },
    'solarized-dark': { bg:'#002b36', fg:'#839496', headerBg:'#073642', border:'#586e75', textSecondary:'#657b83', accent:'#268bd2', selectedBg:'#002b36', error:'#dc322f' },
    'solarized-light': { bg:'#fdf6e3', fg:'#657b83', headerBg:'#eee8d5', border:'#93a1a1', textSecondary:'#93a1a1', accent:'#268bd2', selectedBg:'#fdf6e3', error:'#dc322f' }
  };
  var name = null;
  try { name = localStorage.getItem('swarmie-theme'); } catch(e) {}
  var t = themes[name] || themes['solarized-light'];
  var r = document.documentElement;
  r.style.setProperty('--bg', t.bg);
  r.style.setProperty('--fg', t.fg);
  r.style.setProperty('--header-bg', t.headerBg);
  r.style.setProperty('--border', t.border);
  r.style.setProperty('--text-secondary', t.textSecondary);
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--selected-bg', t.selectedBg);
  r.style.setProperty('--error', t.error);
})();
</script>`;

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>swarmie — Setup</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1>swarmie</h1>
    <p class="subtitle">Set a password to protect your terminal</p>
    <form id="form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password (min 4 chars)" autofocus required>
      <label for="confirm">Confirm password</label>
      <input type="password" id="confirm" name="confirm" placeholder="Confirm password" required>
      <button type="submit">Set Password</button>
      <div class="error" id="error"></div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) {
        errEl.textContent = 'Password must be at least 4 characters';
        errEl.style.display = 'block';
        return;
      }
      if (password !== confirm) {
        errEl.textContent = 'Passwords do not match';
        errEl.style.display = 'block';
        return;
      }
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json();
        errEl.textContent = data.error || 'Setup failed';
        errEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>swarmie — Login</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1>swarmie</h1>
    <form id="form">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus required>
      <button type="submit">Login</button>
      <div class="error" id="error">Incorrect password</div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        document.getElementById('error').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

const CHANGE_PASSWORD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>swarmie — Change Password</title>
  <style>${PAGE_STYLE}</style>
  ${THEME_SCRIPT}
</head>
<body>
  <div class="card">
    <h1>swarmie</h1>
    <p class="subtitle">Change your password</p>
    <form id="form">
      <label for="current">Current password</label>
      <input type="password" id="current" name="current" autofocus required>
      <label for="password">New password</label>
      <input type="password" id="password" name="password" placeholder="Min 4 characters" required>
      <label for="confirm">Confirm new password</label>
      <input type="password" id="confirm" name="confirm" required>
      <button type="submit">Change Password</button>
      <div class="error" id="error"></div>
      <div class="success" id="success" style="color:var(--accent);font-size:0.875rem;margin-top:0.75rem;text-align:center;display:none;">Password changed successfully</div>
    </form>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      const successEl = document.getElementById('success');
      errEl.style.display = 'none';
      successEl.style.display = 'none';
      const current = document.getElementById('current').value;
      const password = document.getElementById('password').value;
      const confirm = document.getElementById('confirm').value;
      if (password.length < 4) {
        errEl.textContent = 'New password must be at least 4 characters';
        errEl.style.display = 'block';
        return;
      }
      if (password !== confirm) {
        errEl.textContent = 'Passwords do not match';
        errEl.style.display = 'block';
        return;
      }
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, password }),
      });
      if (res.ok) {
        successEl.style.display = 'block';
        document.getElementById('form').reset();
      } else {
        const data = await res.json();
        errEl.textContent = data.error || 'Failed to change password';
        errEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;

/**
 * Set up auth for the web dashboard.
 *
 * Two modes:
 * 1. CLI `--password` provided → use that directly
 * 2. No CLI password → check config for stored passwordHash.
 *    If none, show setup page. Once set, require login.
 */
export function setupAuth(app: FastifyInstance, cliPassword?: string): void {
  // Resolve the initial password hash
  let passwordHash: string | undefined;

  if (cliPassword) {
    passwordHash = hashPassword(cliPassword);
  } else {
    const config = loadConfig();
    passwordHash = config.passwordHash;
    if (!passwordHash) {
      console.error('[swarmie] Warning: No password set, please visit browser to set password');
    }
  }

  // Setup page (only when no password is configured yet)
  app.get('/setup', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (passwordHash) {
      reply.redirect('/login');
      return;
    }
    reply.type('text/html').send(SETUP_HTML);
  });

  // Setup endpoint — set initial password
  app.post('/api/auth/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    if (passwordHash) {
      reply.status(403).send({ error: 'Password already set' });
      return;
    }
    const body = request.body as { password?: string } | null;
    const pwd = body?.password;
    if (!pwd || pwd.length < 4) {
      reply.status(400).send({ error: 'Password must be at least 4 characters' });
      return;
    }
    passwordHash = hashPassword(pwd);
    // Persist to config
    const config = loadConfig();
    config.passwordHash = passwordHash;
    saveConfig(config);
    console.error('[swarmie] Password has been set');
    // Set auth cookie
    reply
      .header('Set-Cookie', `${COOKIE_NAME}=${passwordHash}; HttpOnly; Path=/; SameSite=Lax`)
      .send({ ok: true });
  });

  // Login page
  app.get('/login', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!passwordHash) {
      reply.redirect('/setup');
      return;
    }
    reply.type('text/html').send(LOGIN_HTML);
  });

  // Login endpoint
  app.post('/api/auth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!passwordHash) {
      reply.status(400).send({ error: 'No password configured' });
      return;
    }
    const body = request.body as { password?: string } | null;
    if (body?.password && hashPassword(body.password) === passwordHash) {
      reply
        .header('Set-Cookie', `${COOKIE_NAME}=${passwordHash}; HttpOnly; Path=/; SameSite=Lax`)
        .send({ ok: true, token: passwordHash });
    } else {
      reply.status(401).send({ error: 'Invalid password' });
    }
  });

  // Change password page (requires auth — handled by the hook below)
  app.get('/change-password', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(CHANGE_PASSWORD_HTML);
  });

  // Change password endpoint
  app.post('/api/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!passwordHash) {
      reply.status(400).send({ error: 'No password configured' });
      return;
    }
    const body = request.body as { current?: string; password?: string } | null;
    if (!body?.current || hashPassword(body.current) !== passwordHash) {
      reply.status(401).send({ error: 'Current password is incorrect' });
      return;
    }
    const newPwd = body.password;
    if (!newPwd || newPwd.length < 4) {
      reply.status(400).send({ error: 'New password must be at least 4 characters' });
      return;
    }
    passwordHash = hashPassword(newPwd);
    const config = loadConfig();
    config.passwordHash = passwordHash;
    saveConfig(config);
    console.error('[swarmie] Password has been changed');
    reply
      .header('Set-Cookie', `${COOKIE_NAME}=${passwordHash}; HttpOnly; Path=/; SameSite=Lax`)
      .send({ ok: true });
  });

  // Auth check hook
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url;

    // Always allow auth-related routes and CORS preflight
    if (request.method === 'OPTIONS' || url === '/login' || url === '/setup' || url.startsWith('/api/auth') || url === '/favicon.ico') {
      return;
    }

    // No password configured yet → redirect to setup
    if (!passwordHash) {
      if (url.startsWith('/api/') || url.startsWith('/ws')) {
        reply.status(401).send({ error: 'Password not configured. Visit /setup first.' });
      } else {
        reply.redirect('/setup');
      }
      return;
    }

    // Check cookie
    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[COOKIE_NAME];

    if (token === passwordHash) {
      return;
    }

    // Check Authorization header (for cross-origin remote connections)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === passwordHash) {
      return;
    }

    // Check query token (for WebSocket connections which can't set headers)
    const queryToken = (request.query as Record<string, string>)?.token;
    if (queryToken && queryToken === passwordHash) {
      return;
    }

    // Unauthenticated
    if (url.startsWith('/api/') || url.startsWith('/ws')) {
      reply.status(401).send({ error: 'Unauthorized' });
    } else {
      reply.redirect('/login');
    }
  });
}
