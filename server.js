'use strict';
/*
 * BateMail server. No dependencies, Node 18+.
 * Receive-only: people can get mail from anyone but cannot send any.
 *
 * All accounts, mail and forum posts live in ONE file (data/batemail.enc),
 * encrypted with AES-256-GCM. The key comes from the DATA_KEY environment
 * variable, which only you (the owner) know. Nothing is ever deleted.
 *
 *   DATA_KEY="long secret" node server.js        start the site
 *   DATA_KEY="long secret" node server.js dump   print everything, decrypted
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DOMAIN = (process.env.DOMAIN || 'batemail.lol').toLowerCase();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'batemail.enc');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECRET = process.env.DATA_KEY || '';

if (SECRET.length < 16) {
  console.error('Set DATA_KEY to a secret of at least 16 characters and keep it private.');
  console.error('Without it the data file cannot be read, so back it up somewhere safe.');
  process.exit(1);
}

/* ---------- encrypted storage ---------- */
let salt, key, db;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(FILE)) {
    const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    salt = Buffer.from(f.s, 'base64');
    key = crypto.scryptSync(SECRET, salt, 32);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.i, 'base64'));
      d.setAuthTag(Buffer.from(f.t, 'base64'));
      const pt = Buffer.concat([d.update(Buffer.from(f.c, 'base64')), d.final()]);
      db = JSON.parse(pt.toString('utf8'));
    } catch (e) {
      console.error('Could not decrypt data/batemail.enc. Wrong DATA_KEY, or the file is damaged.');
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
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(db), 'utf8'), c.final()]);
  const out = JSON.stringify({
    v: 1,
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    t: c.getAuthTag().toString('base64'),
    c: ct.toString('base64'),
  });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, FILE + '.bak'); // previous version kept
  fs.renameSync(tmp, FILE);
}

load();
if (process.argv[2] === 'dump') {
  console.log(JSON.stringify(db, null, 2));
  process.exit(0);
}

/* ---------- helpers ---------- */
const files = {
  '/': ['text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html'))],
  '/app.js': ['text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'app.js'))],
};
const RESERVED = new Set(['welcome', 'admin', 'administrator', 'postmaster', 'abuse', 'root', 'support', 'noreply', 'no-reply', 'webmaster', 'hostmaster', 'mailer-daemon']);
const sessions = new Map();
const hits = new Map();

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function rid() { return crypto.randomBytes(8).toString('hex'); }
function newSession(email) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, { email, exp: Date.now() + 30 * 864e5 });
  return t;
}
function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw httpErr(401, 'Please log in.');
  const s = sessions.get(h.slice(7));
  if (!s || s.exp < Date.now()) throw httpErr(401, 'Please log in.');
  return s.email;
}
function ipOf(req) {
  if (TRUST_PROXY) {
    const x = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (x) return x;
  }
  return req.socket.remoteAddress || 'unknown';
}
// Kept in memory only, never written to the data file.
function limited(k, max, windowMs) {
  const now = Date.now();
  const a = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (a.length >= max) { hits.set(k, a); return true; }
  a.push(now); hits.set(k, a); return false;
}
setInterval(() => { hits.clear(); for (const [t, s] of sessions) if (s.exp < Date.now()) sessions.delete(t); }, 3600e3).unref();

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpErr(413, 'That is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(httpErr(400, 'Bad request.')); }
    });
    req.on('error', reject);
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

/* ---------- API ---------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const ip = ipOf(req);

  if (route === 'POST /api/register') {
    if (limited('reg:' + ip, 5, 3600e3)) throw httpErr(429, 'Too many sign-ups. Try again later.');
    const b = await readJson(req);
    const user = str(b.user, 40).trim().toLowerCase();
    const pass = str(b.pass, 200);
    if (!/^[a-z0-9._-]{3,30}$/.test(user)) throw httpErr(400, 'Username: 3–30 letters, numbers, . - or _');
    if (pass.length < 6) throw httpErr(400, 'Password must be at least 6 characters.');
    const email = user + '@' + DOMAIN;
    if (RESERVED.has(user) || db.users[email]) throw httpErr(409, 'That email is taken.');
    const s = crypto.randomBytes(16);
    const h = await scrypt(pass, s, 32);
    if (db.users[email]) throw httpErr(409, 'That email is taken.');
    db.users[email] = { s: s.toString('base64'), h: h.toString('base64'), created: Date.now() };
    db.mail[email] = [{
      id: rid(), folder: 'inbox', from: 'welcome@' + DOMAIN, to: email, subject: 'Welcome to BateMail',
      body: 'Your address is ' + email + '.\n\nDon’t share your email, password or personal info on ' + DOMAIN + '. Passwords can’t be recovered.',
      ts: Date.now(), read: false,
    }];
    persist();
    return json(res, 200, { token: newSession(email), email });
  }

  if (route === 'POST /api/login') {
    if (limited('login:' + ip, 15, 600e3)) throw httpErr(429, 'Too many attempts. Try again later.');
    const b = await readJson(req);
    let email = str(b.email, 80).trim().toLowerCase();
    if (email.indexOf('@') < 0) email += '@' + DOMAIN;
    if (limited('acct:' + email, 10, 600e3)) throw httpErr(429, 'Too many attempts. Try again later.');
    const u = db.users[email];
    const s = u ? Buffer.from(u.s, 'base64') : Buffer.alloc(16);
    const h = await scrypt(str(b.pass, 200), s, 32); // same work whether or not the account exists
    if (!u || !crypto.timingSafeEqual(h, Buffer.from(u.h, 'base64'))) throw httpErr(401, 'Wrong email or password.');
    return json(res, 200, { token: newSession(email), email });
  }

  if (route === 'POST /api/logout') {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) sessions.delete(h.slice(7));
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/mail') {
    const email = authed(req);
    return json(res, 200, { email, mail: (db.mail[email] || []).filter((m) => m.folder === 'inbox') });
  }

  if (route === 'POST /api/read') {
    const email = authed(req);
    const b = await readJson(req);
    const m = (db.mail[email] || []).find((x) => x.id === b.id);
    if (m && !m.read) { m.read = true; persist(); }
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/forum') {
    const posts = db.forum.slice(-200).reverse().map(({ id, name, title, body, ts }) => ({ id, name, title, body, ts }));
    return json(res, 200, { posts });
  }

  if (route === 'POST /api/forum') {
    // Anonymous: no login is read, and no account or IP is stored with the post.
    if (limited('forum:' + ip, 10, 3600e3)) throw httpErr(429, 'Posting too fast. Try again later.');
    const b = await readJson(req, 8 * 1024);
    const body = str(b.body, 500).trim();
    if (body.length < 2) throw httpErr(400, 'Write something first.');
    db.forum.push({ id: rid(), name: 'Anonymous ' + crypto.randomInt(1000, 10000), title: str(b.title, 80).trim(), body, ts: Date.now() });
    persist();
    return json(res, 200, { ok: true });
  }

  throw httpErr(404, 'Not found.');
}


/* ---------- inbound SMTP (receive only, no relaying) ---------- */
const SMTP_PORT = +process.env.SMTP_PORT || 2525;
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const MAX_MSG = 1024 * 1024;
let smtpOpen = 0;

function qp(s) {
  s = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 255);
  }
  return Buffer.from(out);
}
function decodeWords(s) {
  return s.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qp(txt.replace(/_/g, ' '));
      return new TextDecoder(cs).decode(buf);
    } catch (e) { return txt; }
  });
}
function parseEntity(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const h = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach((l) => {
    const i = l.indexOf(':');
    if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = l.slice(i + 1).trim(); }
  });
  return { h, body };
}
function extract(raw, depth = 0) {
  const { h, body } = parseEntity(raw);
  const ctRaw = h['content-type'] || 'text/plain', ct = ctRaw.toLowerCase();
  if (ct.startsWith('multipart/')) {
    const out = { plain: '', html: '' };
    const bm = /boundary="?([^";]+)"?/i.exec(ctRaw);
    if (!bm || depth > 3) return out;
    for (const p of body.split('--' + bm[1]).slice(1)) {
      if (p.startsWith('--')) break;
      const r = extract(p.replace(/^\r?\n/, ''), depth + 1);
      out.plain = out.plain || r.plain; out.html = out.html || r.html;
    }
    return out;
  }
  if (/^attachment/i.test(h['content-disposition'] || '')) return { plain: '', html: '' };
  const cte = (h['content-transfer-encoding'] || '7bit').toLowerCase();
  const buf = cte === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : cte === 'quoted-printable' ? qp(body) : Buffer.from(body, 'latin1');
  const cs = (/charset="?([^";\s]+)"?/i.exec(ctRaw) || [])[1] || 'utf-8';
  let text;
  try { text = new TextDecoder(cs).decode(buf); } catch (e) { text = buf.toString('utf8'); }
  if (ct.startsWith('text/html')) return { plain: '', html: text };
  if (ct.startsWith('text/')) return { plain: text, html: '' };
  return { plain: '', html: '' };
}
function htmlToText(h) {
  return h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}
function deliver(env, raw) {
  const { h } = parseEntity(raw);
  const ex = extract(raw);
  const text = (ex.plain || htmlToText(ex.html) || '').replace(/\r\n/g, '\n').trim();
  const from = decodeWords(h.from || '').trim() || env.from || 'unknown';
  const subject = decodeWords(h.subject || '').trim();
  for (const to of env.rcpt) {
    if (!db.mail[to]) continue;
    db.mail[to].push({ id: rid(), folder: 'inbox', from: str(from, 200), to, subject: str(subject, 200), body: str(text || '(no text)', 100000), ts: Date.now(), read: false });
  }
  persist();
}

const smtp = net.createServer((sock) => {
  const ip = sock.remoteAddress || 'x';
  if (smtpOpen >= 50 || limited('smtpconn:' + ip, 60, 600e3)) { sock.end('421 Too many connections\r\n'); return; }
  smtpOpen++;
  sock.setTimeout(120000, () => sock.destroy());
  sock.on('close', () => smtpOpen--);
  sock.on('error', () => {});
  let env, inData, lines, size, tooBig, buf = '';
  const reset = () => { env = { from: '', rcpt: [], started: false }; inData = false; lines = []; size = 0; tooBig = false; };
  const say = (s) => sock.write(s + '\r\n');
  reset();
  say('220 ' + DOMAIN + ' ESMTP');
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    if (buf.length > 100000) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (inData) {
        if (line === '.') {
          if (tooBig) say('552 Message too large');
          else if (limited('smtpmsg:' + ip, 30, 3600e3)) say('450 Too many messages, try later');
          else { try { deliver(env, lines.join('\n')); say('250 OK'); } catch (e) { console.error(e); say('451 Local error'); } }
          reset(); continue;
        }
        if (line.startsWith('..')) line = line.slice(1);
        size += line.length + 2;
        if (size > MAX_MSG) tooBig = true; else lines.push(line);
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') say('250-' + DOMAIN + '\r\n250 SIZE ' + MAX_MSG);
      else if (cmd === 'HELO') say('250 ' + DOMAIN);
      else if (cmd === 'MAIL') {
        const m = /^MAIL FROM:\s*<([^>]*)>/i.exec(line);
        if (!m) say('501 Bad syntax'); else { env = { from: m[1].slice(0, 200), rcpt: [], started: true }; say('250 OK'); }
      } else if (cmd === 'RCPT') {
        const m = /^RCPT TO:\s*<([^>]*)>/i.exec(line);
        const to = m ? m[1].trim().toLowerCase() : '';
        if (!m) say('501 Bad syntax');
        else if (!env.started) say('503 Need MAIL first');
        else if (!to.endsWith('@' + DOMAIN) || !db.users[to]) say('550 No such user here'); // never relays
        else if (env.rcpt.length >= 20) say('452 Too many recipients');
        else { if (!env.rcpt.includes(to)) env.rcpt.push(to); say('250 OK'); }
      } else if (cmd === 'DATA') {
        if (!env.rcpt.length) say('503 Need RCPT first'); else { inData = true; say('354 End data with <CR><LF>.<CR><LF>'); }
      } else if (cmd === 'RSET') { reset(); say('250 OK'); }
      else if (cmd === 'NOOP') say('250 OK');
      else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); }
      else if (cmd === 'VRFY') say('252 Cannot verify');
      else say('502 Command not implemented');
    }
  });
});
smtp.on('error', (e) => console.error('SMTP could not start (' + e.code + '). The website still works, but incoming mail will not arrive.'));
smtp.listen(SMTP_PORT, SMTP_HOST, () => console.log('Receiving mail on ' + SMTP_HOST + ':' + SMTP_PORT));

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const p = url.pathname === '/index.html' ? '/' : url.pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && files[p]) {
      res.writeHead(200, { 'Content-Type': files[p][0], 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : files[p][1]);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    if (e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, HOST, () => console.log('BateMail running on http://' + HOST + ':' + PORT + ' for ' + DOMAIN));
