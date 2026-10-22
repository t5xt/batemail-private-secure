```js
'use strict';

/*
 * BateMail server. No dependencies, Node 18+.
 * Receive-only: users can receive mail but cannot send any.
 *
 * Storage:
 *   DATA_DIR/batemail.enc (AES-256-GCM encrypted)
 *
 * Start:
 *   DATA_KEY="your-long-secret" node server.js
 *
 * Optional environment:
 *   PORT=3000
 *   HOST=0.0.0.0
 *   DOMAIN=batemail.lol
 *   DATA_DIR=/persistent/path
 *   SMTP_PORT=2525
 *   SMTP_HOST=0.0.0.0
 *   TRUST_PROXY=1
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DOMAIN = (process.env.DOMAIN || 'batemail.lol').toLowerCase();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'batemail.enc');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECRET = process.env.DATA_KEY || '';

if (SECRET.length < 16) {
  console.error('Set DATA_KEY to a private secret of at least 16 characters.');
  process.exit(1);
}

/* ---------- frontend files ---------- */

// Prefer the repository root. Fall back to public/ if root files are absent.
function findFrontendFile(name) {
  const candidates = [
    path.join(__dirname, name),
    path.join(__dirname, 'public', name),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }

  throw new Error(
    `Cannot find ${name}. Expected ${candidates.join(' or ')}`
  );
}

const FRONTEND = {
  '/': {
    file: findFrontendFile('index.html'),
    type: 'text/html; charset=utf-8',
  },
  '/app.js': {
    file: findFrontendFile('app.js'),
    type: 'text/javascript; charset=utf-8',
  },
};

console.log('Frontend HTML:', FRONTEND['/'].file);
console.log('Frontend JS:', FRONTEND['/app.js'].file);

/* ---------- encrypted storage ---------- */

let salt;
let key;
let db;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(FILE)) {
    const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));

    salt = Buffer.from(f.s, 'base64');
    key = crypto.scryptSync(SECRET, salt, 32);

    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(f.i, 'base64')
      );

      decipher.setAuthTag(Buffer.from(f.t, 'base64'));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(f.c, 'base64')),
        decipher.final(),
      ]);

      db = JSON.parse(plaintext.toString('utf8'));

      if (!db || typeof db !== 'object' ||
          !db.users || !db.mail || !Array.isArray(db.forum)) {
        throw new Error('Invalid database structure');
      }
    } catch (err) {
      console.error(
        'Could not decrypt the data file. Check DATA_KEY and your backup.'
      );
      process.exit(1);
    }
  } else {
    salt = crypto.randomBytes(16);
    key = crypto.scryptSync(SECRET, salt, 32);
    db = { users: {}, mail: {}, forum: [] };
    persist();
  }
}

function persist() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(db), 'utf8'),
    cipher.final(),
  ]);

  const out = JSON.stringify({
    v: 1,
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
    c: encrypted.toString('base64'),
  });

  const tmp = FILE + '.tmp';

  fs.writeFileSync(tmp, out, { mode: 0o600 });

  if (fs.existsSync(FILE)) {
    fs.copyFileSync(FILE, FILE + '.bak');
  }

  fs.renameSync(tmp, FILE);
}

load();

if (process.argv[2] === 'dump') {
  console.log(JSON.stringify(db, null, 2));
  process.exit(0);
}

/* ---------- helpers ---------- */

const RESERVED = new Set([
  'welcome', 'admin', 'administrator', 'postmaster', 'abuse',
  'root', 'support', 'noreply', 'no-reply', 'webmaster',
  'hostmaster', 'mailer-daemon',
]);

const sessions = new Map();
const hits = new Map();

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function rid() {
  return crypto.randomBytes(8).toString('hex');
}

function newSession(email) {
  const token = crypto.randomBytes(32).toString('hex');

  sessions.set(token, {
    email,
    exp: Date.now() + 30 * 864e5,
  });

  return token;
}

function authed(req) {
  const h = req.headers.authorization || '';

  if (!h.startsWith('Bearer ')) {
    throw httpErr(401, 'Please log in.');
  }

  const session = sessions.get(h.slice(7));

  if (!session || session.exp < Date.now()) {
    throw httpErr(401, 'Please log in.');
  }

  return session.email;
}

function ipOf(req) {
  if (TRUST_PROXY) {
    const forwarded = (req.headers['x-forwarded-for'] || '')
      .split(',')[0].trim();

    if (forwarded) return forwarded;
  }

  return req.socket.remoteAddress || 'unknown';
}

function limited(k, max, windowMs) {
  const now = Date.now();
  const timestamps = (hits.get(k) || [])
    .filter((t) => now - t < windowMs);

  if (timestamps.length >= max) {
    hits.set(k, timestamps);
    return true;
  }

  timestamps.push(now);
  hits.set(k, timestamps);
  return false;
}

setInterval(() => {
  hits.clear();

  for (const [token, session] of sessions) {
    if (session.exp < Date.now()) sessions.delete(token);
  }
}, 3600e3).unref();

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        rejected = true;
        reject(httpErr(413, 'That is too large.'));
        req.resume();
        return;
      }

      if (!rejected) chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;
      if (!chunks.length) return resolve({});

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpErr(400, 'Bad request.'));
      }
    });

    req.on('error', reject);
  });
}

function json(res, status, obj) {
  if (res.headersSent || res.destroyed) return;

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(JSON.stringify(obj));
}

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

/* ---------- API ---------- */

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const ip = ipOf(req);

  if (route === 'POST /api/register') {
    if (limited('reg:' + ip, 5, 3600e3)) {
      throw httpErr(429, 'Too many sign-ups. Try again later.');
    }

    const b = await readJson(req);
    const user = str(b.user, 40).trim().toLowerCase();
    const pass = str(b.pass, 200);

    if (!/^[a-z0-9._-]{3,30}$/.test(user)) {
      throw httpErr(400, 'Username: 3–30 letters, numbers, . - or _');
    }

    if (pass.length < 6) {
      throw httpErr(400, 'Password must be at least 6 characters.');
    }

    const email = user + '@' + DOMAIN;

    if (RESERVED.has(user) || db.users[email]) {
      throw httpErr(409, 'That email is taken.');
    }

    const passwordSalt = crypto.randomBytes(16);
    const passwordHash = await scrypt(pass, passwordSalt, 32);

    // Recheck before inserting the account.
    if (db.users[email]) throw httpErr(409, 'That email is taken.');

    db.users[email] = {
      s: passwordSalt.toString('base64'),
      h: passwordHash.toString('base64'),
      created: Date.now(),
    };

    db.mail[email] = [{
      id: rid(),
      folder: 'inbox',
      from: 'welcome@' + DOMAIN,
      to: email,
      subject: 'Welcome to BateMail',
      body: 'Your address is ' + email +
        '.\n\nDon’t share your email, password or personal info on ' +
        DOMAIN + '. Passwords can’t be recovered.',
      ts: Date.now(),
      read: false,
    }];

    persist();

    return json(res, 200, {
      token: newSession(email),
      email,
    });
  }

  if (route === 'POST /api/login') {
    if (limited('login:' + ip, 15, 600e3)) {
      throw httpErr(429, 'Too many attempts. Try again later.');
    }

    const b = await readJson(req);
    let email = str(b.email, 80).trim().toLowerCase();

    if (!email.includes('@')) email += '@' + DOMAIN;

    if (limited('acct:' + email, 10, 600e3)) {
      throw httpErr(429, 'Too many attempts. Try again later.');
    }

    const user = db.users[email];
    const passwordSalt = user
      ? Buffer.from(user.s, 'base64')
      : Buffer.alloc(16);

    const passwordHash = await scrypt(str(b.pass, 200), passwordSalt, 32);

    if (!user ||
        !crypto.timingSafeEqual(
          passwordHash,
          Buffer.from(user.h, 'base64')
        )) {
      throw httpErr(401, 'Wrong email or password.');
    }

    return json(res, 200, {
      token: newSession(email),
      email,
    });
  }

  if (route === 'POST /api/logout') {
    const h = req.headers.authorization || '';

    if (h.startsWith('Bearer ')) sessions.delete(h.slice(7));

    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/mail') {
    const email = authed(req);

    return json(res, 200, {
      email,
      mail: (db.mail[email] || [])
        .filter((message) => message.folder === 'inbox'),
    });
  }

  if (route === 'POST /api/read') {
    const email = authed(req);
    const b = await readJson(req);
    const message = (db.mail[email] || [])
      .find((item) => item.id === b.id);

    if (message && !message.read) {
      message.read = true;
      persist();
    }

    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/forum') {
    const posts = db.forum.slice(-200).reverse().map(
      ({ id, name, title, body, ts }) => ({ id, name, title, body, ts })
    );

    return json(res, 200, { posts });
  }

  if (route === 'POST /api/forum') {
    if (limited('forum:' + ip, 10, 3600e3)) {
      throw httpErr(429, 'Posting too fast. Try again later.');
    }

    const b = await readJson(req, 8 * 1024);
    const body = str(b.body, 500).trim();

    if (body.length < 2) {
      throw httpErr(400, 'Write something first.');
    }

    db.forum.push({
      id: rid(),
      name: 'Anonymous ' + crypto.randomInt(1000, 10000),
      title: str(b.title, 80).trim(),
      body,
      ts: Date.now(),
    });

    persist();

    return json(res, 200, { ok: true });
  }

  throw httpErr(404, 'Not found.');
}

/* ---------- inbound SMTP: receive only ---------- */

const SMTP_PORT = Number(process.env.SMTP_PORT) || 2525;
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const MAX_MSG = 1024 * 1024;
let smtpOpen = 0;

function qp(s) {
  s = s.replace(/=\\r?\\n/g, '');
  const out = [];

  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 255);
    }
  }

  return Buffer.from(out);
}

function decodeWords(s) {
  return s.replace(/(\\?=)\\s+(=\\?)/g, '$1$2')
    .replace(/=\\?([^?]+)\\?([bBqQ])\\?([^?]*)\\?=/g,
      (_, charset, encoding, text) => {
        try {
          const buf = encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : qp(text.replace(/_/g, ' '));

          return new TextDecoder(charset).decode(buf);
        } catch {
          return text;
        }
      });
}

function parseEntity(raw) {
  const match = raw.match(/\\r?\\n\\r?\\n/);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : '';
  const headers = {};

  head.replace(/\\r?\\n[ \\t]+/g, ' ')
    .split(/\\r?\\n/)
    .forEach((line) => {
      const i = line.indexOf(':');

      if (i > 0) {
        const k = line.slice(0, i).trim().toLowerCase();
        if (!(k in headers)) headers[k] = line.slice(i + 1).trim();
      }
    });

  return { h: headers, body };
}

function extract(raw, depth = 0) {
  const { h, body } = parseEntity(raw);
  const ctRaw = h['content-type'] || 'text/plain';
  const ct = ctRaw.toLowerCase();

  if (ct.startsWith('multipart/')) {
    const out = { plain: '', html: '' };
    const boundary = /boundary="?([^";]+)"?/i.exec(ctRaw);

    if (!boundary || depth > 3) return out;

    for (const part of body.split('--' + boundary[1]).slice(1)) {
      if (part.startsWith('--')) break;

      const result = extract(part.replace(/^\\r?\\n/, ''), depth + 1);
      out.plain = out.plain || result.plain;
      out.html = out.html || result.html;
    }

    return out;
  }

  if (/^attachment/i.test(h['content-disposition'] || '')) {
    return { plain: '', html: '' };
  }

  const transferEncoding =
    (h['content-transfer-encoding'] || '7bit').toLowerCase();

  const buffer = transferEncoding === 'base64'
    ? Buffer.from(body.replace(/\\s+/g, ''), 'base64')
    : transferEncoding === 'quoted-printable'
      ? qp(body)
      : Buffer.from(body, 'latin1');

  const charset = (/charset="?([^";\\s]+)"?/i.exec(ctRaw) || [])[1] || 'utf-8';
  let text;

  try {
    text = new TextDecoder(charset).decode(buffer);
  } catch {
    text = buffer.toString('utf8');
  }

  if (ct.startsWith('text/html')) return { plain: '', html: text };
  if (ct.startsWith('text/')) return { plain: text, html: '' };

  return { plain: '', html: '' };
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\\s\\S]*?<\\/\\1>/gi, '')
    .replace(/<br\\s*\\/?>|<\\/(p|div|tr|h\\d|li)>/gi, '\\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
}

function deliver(envelope, raw) {
  const { h } = parseEntity(raw);
  const extracted = extract(raw);
  const body = (extracted.plain || htmlToText(extracted.html) || '')
    .replace(/\\r\\n/g, '\\n')
    .trim();

  const from = decodeWords(h.from || '').trim() ||
    envelope.from || 'unknown';
  const subject = decodeWords(h.subject || '').trim();

  for (const recipient of envelope.rcpt) {
    if (!db.mail[recipient]) continue;

    db.mail[recipient].push({
      id: rid(),
      folder: 'inbox',
      from: str(from, 200),
      to: recipient,
      subject: str(subject, 200),
      body: str(body || '(no text)', 100000),
      ts: Date.now(),
      read: false,
    });
  }

  persist();
}

const smtp = net.createServer((sock) => {
  const ip = sock.remoteAddress || 'x';

  if (smtpOpen >= 50 || limited('smtpconn:' + ip, 60, 600e3)) {
    sock.end('421 Too many connections\\r\\n');
    return;
  }

  smtpOpen++;
  sock.setTimeout(120000, () => sock.destroy());
  sock.on('close', () => smtpOpen--);
  sock.on('error', () => {});

  let envelope;
  let inData;
  let lines;
  let size;
  let tooBig;
  let buffer = '';

  const reset = () => {
    envelope = { from: '', rcpt: [], started: false };
    inData = false;
    lines = [];
    size = 0;
    tooBig = false;
  };

  const say = (message) => sock.write(message + '\\r\\n');

  reset();
  say('220 ' + DOMAIN + ' ESMTP');

  sock.on('data', (chunk) => {
    buffer += chunk.toString('latin1');

    if (buffer.length > 100000) {
      sock.destroy();
      return;
    }

    let i;

    while ((i = buffer.indexOf('\\n')) >= 0) {
      let line = buffer.slice(0, i).replace(/\\r$/, '');
      buffer = buffer.slice(i + 1);

      if (inData) {
        if (line === '.') {
          if (tooBig) {
            say('552 Message too large');
          } else if (limited('smtpmsg:' + ip, 30, 3600e3)) {
            say('450 Too many messages, try later');
          } else {
            try {
              deliver(envelope, lines.join('\\n'));
              say('250 OK');
            } catch (err) {
              console.error(err);
              say('451 Local error');
            }
          }

          reset();
          continue;
        }

        if (line.startsWith('..')) line = line.slice(1);

        size += line.length + 2;
        if (size > MAX_MSG) tooBig = true;
        else lines.push(line);

        continue;
      }

      const command = line.slice(0, 4).toUpperCase();

      if (command === 'EHLO') {
        sock.write('250-' + DOMAIN + '\\r\\n250 SIZE ' + MAX_MSG + '\\r\\n');
      } else if (command === 'HELO') {
        say('250 ' + DOMAIN);
      } else if (command === 'MAIL') {
        const match = /^MAIL FROM:\\s*<([^>]*)>/i.exec(line);

        if (!match) {
          say('501 Bad syntax');
        } else {
          envelope = {
            from: match[1].slice(0, 200),
            rcpt: [],
            started: true,
          };
          say('250 OK');
        }
      } else if (command === 'RCPT') {
        const match = /^RCPT TO:\\s*<([^>]*)>/i.exec(line);
        const to = match ? match[1].trim().toLowerCase() : '';

        if (!match) say('501 Bad syntax');
        else if (!envelope.started) say('503 Need MAIL first');
        else if (!to.endsWith('@' + DOMAIN) || !db.users[to]) {
          say('550 No such user here');
        } else if (envelope.rcpt.length >= 20) {
          say('452 Too many recipients');
        } else {
          if (!envelope.rcpt.includes(to)) envelope.rcpt.push(to);
          say('250 OK');
        }
      } else if (command === 'DATA') {
        if (!envelope.rcpt.length) {
          say('503 Need RCPT first');
        } else {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        }
      } else if (command === 'RSET') {
        reset();
        say('250 OK');
      } else if (command === 'NOOP') {
        say('250 OK');
      } else if (command === 'QUIT') {
        say('221 Bye');
        sock.end();
      } else if (command === 'VRFY') {
        say('252 Cannot verify');
      } else {
        say('502 Command not implemented');
      }
    }
  });
});

smtp.on('error', (err) => {
  console.error(
    'SMTP could not start (' + err.code +
    '). The website may still work, but incoming mail will not arrive.'
  );
});

smtp.listen(SMTP_PORT, SMTP_HOST, () => {
  console.log('Receiving mail on ' + SMTP_HOST + ':' + SMTP_PORT);
});

/* ---------- HTTP server ---------- */

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'none'; " +
    "form-action 'self'"
  );

  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      return await api(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Allow': 'GET, HEAD',
      });
      return res.end('Method not allowed');
    }

    const pathname = url.pathname === '/index.html'
      ? '/'
      : url.pathname;

    const file = FRONTEND[pathname];

    if (!file) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end('Not found');
    }

    res.writeHead(200, {
      'Content-Type': file.type,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });

    if (req.method === 'HEAD') return res.end();

    return res.end(fs.readFileSync(file.file));
  } catch (err) {
    if (res.headersSent || res.destroyed) return;

    if (err.status) {
      return json(res, err.status, { error: err.message });
    }

    console.error(err);
    return json(res, 500, { error: 'Server error.' });
  }
});

server.on('error', (err) => {
  console.error('HTTP server failed to start:', err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(
    'BateMail running on http://' + HOST + ':' + PORT +
    ' for ' + DOMAIN
  );
});
```
