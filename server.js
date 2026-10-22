
'use strict';

/*
 * BateMail — receive-only email server
 * Requires Node.js 18+; no external dependencies.
 *
 * Required:
 *   DATA_KEY="your-private-secret-at-least-16-characters"
 *
 * Optional:
 *   PORT=3000
 *   HOST=0.0.0.0
 *   DOMAIN=batemail.lol
 *   DATA_DIR=/persistent/path
 *   SMTP_PORT=2525
 *   SMTP_HOST=0.0.0.0
 *   TRUST_PROXY=1
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');

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

if (!/^[a-z0-9.-]+$/.test(DOMAIN) || DOMAIN.startsWith('.') ||
    DOMAIN.endsWith('.') || DOMAIN.includes('..')) {
  console.error('DOMAIN is invalid.');
  process.exit(1);
}

/* ---------- Frontend ---------- */

function findFrontendFile(name) {
  const candidates = [
    path.join(__dirname, name),
    path.join(__dirname, 'public', name),
  ];

  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Try the next candidate.
    }
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

/* ---------- Encrypted storage ---------- */

let salt;
let key;
let db;

function persist() {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(db), 'utf8'),
    cipher.final(),
  ]);

  const output = JSON.stringify({
    v: 1,
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
    c: encrypted.toString('base64'),
  });

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  const temp = FILE + '.tmp';
  fs.writeFileSync(temp, output, { mode: 0o600 });

  try {
    if (fs.existsSync(FILE)) {
      fs.copyFileSync(FILE, FILE + '.bak');
    }

    fs.renameSync(temp, FILE);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Ignore cleanup failure.
    }
    throw err;
  }
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(FILE)) {
    salt = crypto.randomBytes(16);
    key = crypto.scryptSync(SECRET, salt, 32);
    db = { users: {}, mail: {}, forum: [] };
    persist();
    return;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));

    if (!stored.s || !stored.i || !stored.t || typeof stored.c !== 'string') {
      throw new Error('Invalid encrypted file format');
    }

    salt = Buffer.from(stored.s, 'base64');
    key = crypto.scryptSync(SECRET, salt, 32);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(stored.i, 'base64')
    );

    decipher.setAuthTag(Buffer.from(stored.t, 'base64'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(stored.c, 'base64')),
      decipher.final(),
    ]);

    const parsed = JSON.parse(plaintext.toString('utf8'));

    if (
      !parsed ||
      typeof parsed.users !== 'object' ||
      parsed.users === null ||
      typeof parsed.mail !== 'object' ||
      parsed.mail === null ||
      !Array.isArray(parsed.forum)
    ) {
      throw new Error('Invalid database structure');
    }

    db = parsed;
  } catch (err) {
    console.error(
      'Could not load the encrypted database. Check DATA_KEY and your backup.'
    );
    console.error(err.message);
    process.exit(1);
  }
}

load();

if (process.argv[2] === 'dump') {
  console.log(JSON.stringify(db, null, 2));
  process.exit(0);
}

/* ---------- Helpers ---------- */

const RESERVED = new Set([
  'welcome', 'admin', 'administrator', 'postmaster', 'abuse',
  'root', 'support', 'noreply', 'no-reply', 'webmaster',
  'hostmaster', 'mailer-daemon',
]);

const sessions = new Map();
const hits = new Map();

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function str(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function rid() {
  return crypto.randomBytes(16).toString('hex');
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
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    throw httpErr(401, 'Please log in.');
  }

  const token = header.slice(7);
  const session = sessions.get(token);

  if (!session || session.exp < Date.now()) {
    sessions.delete(token);
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

/*
 * Sliding-window rate limiter.
 * Expired timestamps are removed per key instead of clearing all limits
 * on a fixed hourly schedule.
 */
function limited(id, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(id) || [])
    .filter((timestamp) => now - timestamp < windowMs);

  if (recent.length >= max) {
    hits.set(id, recent);
    return true;
  }

  recent.push(now);
  hits.set(id, recent);
  return false;
}

setInterval(() => {
  const now = Date.now();

  for (const [id, timestamps] of hits) {
    const recent = timestamps.filter((t) => now - t < 3600e3);

    if (recent.length) hits.set(id, recent);
    else hits.delete(id);
  }

  for (const [token, session] of sessions) {
    if (session.exp < now) sessions.delete(token);
  }
}, 10 * 60e3).unref();

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];

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

      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reject(httpErr(400, 'Bad request.'));
          return;
        }

        resolve(value);
      } catch {
        reject(httpErr(400, 'Bad request.'));
      }
    });

    req.on('error', reject);
  });
}

function json(res, status, value) {
  if (res.headersSent || res.destroyed) return;

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(JSON.stringify(value));
}

/* ---------- API ---------- */

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const ip = ipOf(req);

  if (route === 'POST /api/register') {
    if (limited('reg:' + ip, 5, 3600e3)) {
      throw httpErr(429, 'Too many sign-ups. Try again later.');
    }

    const body = await readJson(req);
    const user = str(body.user, 40).trim().toLowerCase();
    const pass = str(body.pass, 200);

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

    // Check again after the asynchronous password hash.
    if (RESERVED.has(user) || db.users[email]) {
      throw httpErr(409, 'That email is taken.');
    }

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

    const body = await readJson(req);
    let email = str(body.email, 80).trim().toLowerCase();

    if (!email.includes('@')) email += '@' + DOMAIN;

    if (limited('acct:' + email, 10, 600e3)) {
      throw httpErr(429, 'Too many attempts. Try again later.');
    }

    const user = db.users[email];
    const passwordSalt = user
      ? Buffer.from(user.s, 'base64')
      : Buffer.alloc(16);

    const passwordHash = await scrypt(str(body.pass, 200), passwordSalt, 32);

    if (
      !user ||
      !crypto.timingSafeEqual(
        passwordHash,
        Buffer.from(user.h, 'base64')
      )
    ) {
      throw httpErr(401, 'Wrong email or password.');
    }

    return json(res, 200, {
      token: newSession(email),
      email,
    });
  }

  if (route === 'POST /api/logout') {
    const header = req.headers.authorization || '';

    if (header.startsWith('Bearer ')) {
      sessions.delete(header.slice(7));
    }

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
    const body = await readJson(req);
    const message = (db.mail[email] || [])
      .find((item) => item.id === body.id);

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

    const body = await readJson(req, 8 * 1024);
    const content = str(body.body, 500).trim();

    if (content.length < 2) {
      throw httpErr(400, 'Write something first.');
    }

    db.forum.push({
      id: rid(),
      name: 'Anonymous ' + crypto.randomInt(1000, 10000),
      title: str(body.title, 80).trim(),
      body: content,
      ts: Date.now(),
    });

    if (db.forum.length > 1000) {
      db.forum = db.forum.slice(-1000);
    }

    persist();

    return json(res, 200, { ok: true });
  }

  throw httpErr(404, 'Not found.');
}

/* ---------- Inbound SMTP: receive only ---------- */

const SMTP_PORT = Number(process.env.SMTP_PORT) || 2525;
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const MAX_MSG = 1024 * 1024;
let smtpOpen = 0;

function qp(input) {
  // Quoted-printable soft line breaks are "=" followed by a newline.
  const source = input.replace(/=\r?\n/g, '');
  const bytes = [];

  for (let i = 0; i < source.length; i++) {
    if (
      source[i] === '=' &&
      /^[0-9a-fA-F]{2}$/.test(source.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(source.charCodeAt(i) & 255);
    }
  }

  return Buffer.from(bytes);
}

function decodeWords(input) {
  return input
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_, charset, encoding, text) => {
        try {
          const buffer = encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : qp(text.replace(/_/g, ' '));

          return new TextDecoder(charset).decode(buffer);
        } catch {
          return text;
        }
      }
    );
}

function parseEntity(raw) {
  const separator = raw.match(/\r?\n\r?\n/);
  const head = separator ? raw.slice(0, separator.index) : raw;
  const body = separator
    ? raw.slice(separator.index + separator[0].length)
    : '';

  const headers = {};

  head
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .forEach((line) => {
      const index = line.indexOf(':');

      if (index > 0) {
        const name = line.slice(0, index).trim().toLowerCase();

        // Keep the first value for duplicate headers.
        if (!(name in headers)) {
          headers[name] = line.slice(index + 1).trim();
        }
      }
    });

  return { h: headers, body };
}

function extract(raw, depth = 0) {
  const { h, body } = parseEntity(raw);
  const contentType = h['content-type'] || 'text/plain';
  const typeLower = contentType.toLowerCase();

  if (typeLower.startsWith('multipart/')) {
    const result = { plain: '', html: '' };
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType);

    if (!boundary || depth >= 5) return result;

    for (const part of body.split('--' + boundary[1]).slice(1)) {
      if (part.startsWith('--')) break;

      const extracted = extract(part.replace(/^\r?\n/, ''), depth + 1);
      result.plain = result.plain || extracted.plain;
      result.html = result.html || extracted.html;
    }

    return result;
  }

  if (/^attachment\b/i.test(h['content-disposition'] || '')) {
    return { plain: '', html: '' };
  }

  const transferEncoding =
    (h['content-transfer-encoding'] || '7bit').toLowerCase();

  let buffer;

  if (transferEncoding === 'base64') {
    buffer = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  } else if (transferEncoding === 'quoted-printable') {
    buffer = qp(body);
  } else {
    buffer = Buffer.from(body, 'latin1');
  }

  const charsetMatch = /charset="?([^";\s]+)"?/i.exec(contentType);
  const charset = charsetMatch ? charsetMatch[1] : 'utf-8';
  let text;

  try {
    text = new TextDecoder(charset).decode(buffer);
  } catch {
    text = buffer.toString('utf8');
  }

  if (typeLower.startsWith('text/html')) {
    return { plain: '', html: text };
  }

  if (typeLower.startsWith('text/')) {
    return { plain: text, html: '' };
  }

  return { plain: '', html: '' };
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deliver(envelope, raw) {
  const { h } = parseEntity(raw);
  const extracted = extract(raw);

  const body = (extracted.plain || htmlToText(extracted.html) || '')
    .replace(/\r\n/g, '\n')
    .trim();

  const from = decodeWords(h.from || '').trim() ||
    envelope.from || 'unknown';

  const subject = decodeWords(h.subject || '').trim();

  for (const recipient of envelope.rcpt) {
    if (!db.users[recipient] || !Array.isArray(db.mail[recipient])) continue;

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

    // Bound mailbox growth.
    if (db.mail[recipient].length > 5000) {
      db.mail[recipient] = db.mail[recipient].slice(-5000);
    }
  }

  persist();
}

const smtp = net.createServer((socket) => {
  const ip = socket.remoteAddress || 'unknown';

  if (smtpOpen >= 50 || limited('smtpconn:' + ip, 60, 600e3)) {
    socket.end('421 Too many connections\r\n');
    return;
  }

  smtpOpen++;
  socket.setTimeout(120000, () => socket.destroy());
  socket.on('close', () => { smtpOpen--; });
  socket.on('error', () => {});

  let envelope;
  let inData;
  let lines;
  let size;
  let tooBig;
  let buffer = '';

  function reset() {
    envelope = { from: '', rcpt: [], started: false };
    inData = false;
    lines = [];
    size = 0;
    tooBig = false;
  }

  function say(message) {
    if (!socket.destroyed) socket.write(message + '\r\n');
  }

  reset();
  say('220 ' + DOMAIN + ' ESMTP');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');

    if (buffer.length > MAX_MSG + 10000) {
      socket.destroy();
      return;
    }

    let newline;

    while ((newline = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (inData) {
        if (line === '.') {
          if (tooBig) {
            say('552 Message too large');
          } else if (limited('smtpmsg:' + ip, 30, 3600e3)) {
            say('450 Too many messages, try later');
          } else {
            try {
              deliver(envelope, lines.join('\r\n'));
              say('250 OK');
            } catch (err) {
              console.error('SMTP delivery failed:', err);
              say('451 Local error');
            }
          }

          reset();
          continue;
        }

        // SMTP dot-stuffing: remove one leading dot from doubled dots.
        if (line.startsWith('..')) line = line.slice(1);

        size += Buffer.byteLength(line, 'latin1') + 2;

        if (size > MAX_MSG) {
          tooBig = true;
          lines = [];
        } else if (!tooBig) {
          lines.push(line);
        }

        continue;
      }

      const command = line.slice(0, 4).toUpperCase();

      if (command === 'EHLO') {
        socket.write(
          '250-' + DOMAIN + '\r\n' +
          '250 SIZE ' + MAX_MSG + '\r\n'
        );
      } else if (command === 'HELO') {
        say('250 ' + DOMAIN);
      } else if (command === 'MAIL') {
        const match = /^MAIL FROM:\s*<([^>]*)>/i.exec(line);

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
        const match = /^RCPT TO:\s*<([^>]*)>/i.exec(line);
        const to = match ? match[1].trim().toLowerCase() : '';

        if (!match) {
          say('501 Bad syntax');
        } else if (!envelope.started) {
          say('503 Need MAIL first');
        } else if (!to.endsWith('@' + DOMAIN) || !db.users[to]) {
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
        socket.end();
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

    console.error('Request failed:', err);
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
