import PostalMime from "postal-mime";
const EMAIL_DOMAIN = "batemail.lol";
const SESSION_DAYS = 7;
const ALLOWED_ORIGINS = new Set([
  "https://batemail.lol",
  "https://www.batemail.lol"
]);

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function response(request, data, status = 200) {
  return json(data, status, corsHeaders(request));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest),
    b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(
    saltHex.match(/.{2}/g).map(b => parseInt(b, 16))
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt,
    iterations: 100000,
    hash: "SHA-256"
  }, key, 256);

  return Array.from(new Uint8Array(bits),
    b => b.toString(16).padStart(2, "0")).join("");
}

async function makePasswordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt,
    b => b.toString(16).padStart(2, "0")).join("");
  const digest = await hashPassword(password, saltHex);
  return `${saltHex}:${digest}`;
}

async function verifyPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length !== 2 || !/^[a-f0-9]{32}$/.test(parts[0])) {
    return false;
  }

  const digest = await hashPassword(password, parts[0]);
  return digest === parts[1];
}

function normalizeUsername(value) {
  let username = String(value || "").trim().toLowerCase();

  if (username.endsWith("@" + EMAIL_DOMAIN)) {
    username = username.slice(0, -(EMAIL_DOMAIN.length + 1));
  }

  return username;
}

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return null;

  const tokenHash = await sha256(match[1]);
  const now = Math.floor(Date.now() / 1000);

  const session = await env.DB.prepare(
    "SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?"
  ).bind(tokenHash, now).first();

  return session ? session.username : null;
}

async function createSession(env, username) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expires = Math.floor(Date.now() / 1000) +
    SESSION_DAYS * 24 * 60 * 60;

  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)"
  ).bind(tokenHash, username, expires).run();

  return token;
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request)
    });
  }

  if (method === "GET" && path === "/api/health") {
    return response(request, {
      ok: true,
      service: "BateMail API",
      databaseConfigured: !!env.DB
    });
  }

  if (!env.DB) {
    return response(request, { error: "Database unavailable" }, 500);
  }

  if (method === "POST" &&
      (path === "/api/register" || path === "/api/login")) {
    let data;
    try {
      data = await request.json();
    } catch {
      return response(request, { error: "Invalid JSON" }, 400);
    }

    const username = normalizeUsername(
      path === "/api/register" ? data.user : data.email
    );
    const password = String(data.pass || "");

    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      return response(request, { error: "Invalid username" }, 400);
    }

    if (password.length < 6 || password.length > 128) {
      return response(request, {
        error: "Password must be 6–128 characters"
      }, 400);
    }

    if (path === "/api/register") {
      const existing = await env.DB.prepare(
        "SELECT id FROM users WHERE username = ?"
      ).bind(username).first();

      if (existing) {
        return response(request, { error: "Username already taken" }, 409);
      }

      const passwordHash = await makePasswordHash(password);

      try {
        await env.DB.prepare(
          "INSERT INTO users (username, password_hash) VALUES (?, ?)"
        ).bind(username, passwordHash).run();
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) {
          return response(request, {
            error: "Username already taken"
          }, 409);
        }
        throw error;
      }
    } else {
      const user = await env.DB.prepare(
        "SELECT password_hash FROM users WHERE username = ?"
      ).bind(username).first();

      if (!user || !await verifyPassword(password, user.password_hash)) {
        return response(request, {
          error: "Invalid username or password"
        }, 401);
      }
    }

    const token = await createSession(env, username);

    return response(request, {
      ok: true,
      token,
      email: `${username}@${EMAIL_DOMAIN}`
    });
  }

  if (method === "POST" && path === "/api/logout") {
    const auth = request.headers.get("Authorization") || "";
    const match = auth.match(/^Bearer ([a-f0-9]{64})$/i);

    if (match) {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE token_hash = ?"
      ).bind(await sha256(match[1])).run();
    }

    return response(request, { ok: true });
  }

  if (method === "GET" && path === "/api/forum") {
    const result = await env.DB.prepare(
      "SELECT id, username, title, body, created_at FROM forum_posts ORDER BY id DESC LIMIT 100"
    ).all();

    return response(request, { posts: result.results || [] });
  }

  if (method === "POST" && path === "/api/forum") {
    const username = await getUser(request, env);
    if (!username) {
      return response(request, { error: "Unauthorized" }, 401);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return response(request, { error: "Invalid JSON" }, 400);
    }

    const title = String(data.title || "").trim();
    const body = String(data.body || "").trim();

    if (!title || title.length > 150 || !body || body.length > 10000) {
      return response(request, { error: "Invalid post title or body" }, 400);
    }

    await env.DB.prepare(
      "INSERT INTO forum_posts (username, title, body) VALUES (?, ?, ?)"
    ).bind(username, title, body).run();

    return response(request, { ok: true }, 201);
  }

  if (method === "GET" && path === "/api/mail") {
    const username = await getUser(request, env);
    if (!username) {
      return response(request, { error: "Unauthorized" }, 401);
    }

    const email = `${username}@${EMAIL_DOMAIN}`;
    const result = await env.DB.prepare(
      "SELECT id, sender, recipient, subject, body, received_at, is_read FROM emails WHERE recipient = ? ORDER BY id DESC LIMIT 200"
    ).bind(email).all();

    return response(request, {
      email,
      mail: result.results || []
    });
  }

  if (method === "POST" && path === "/api/read") {
    const username = await getUser(request, env);
    if (!username) {
      return response(request, { error: "Unauthorized" }, 401);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return response(request, { error: "Invalid JSON" }, 400);
    }

    const id = Number(data.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return response(request, { error: "Invalid message ID" }, 400);
    }

    const email = `${username}@${EMAIL_DOMAIN}`;
    const result = await env.DB.prepare(
      "UPDATE emails SET is_read = 1 WHERE id = ? AND recipient = ?"
    ).bind(id, email).run();

    return response(request, {
      ok: true,
      changed: result.meta?.changes || 0
    });
  }

  return response(request, { error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("BateMail API error:", error);
        return response(request, { error: "Internal server error" }, 500);
      }
    }

   
    return env.ASSETS.fetch(request);
  },

  async email(message, env) {
    const recipient = String(message.to || "").trim().toLowerCase();
    const match = recipient.match(
      /^([a-z0-9._-]{3,30})@batemail\.lol$/
    );

    if (!match) {
      message.setReject("Invalid BateMail address");
      return;
    }

    const username = match[1];

    const user = await env.DB.prepare(
      "SELECT username FROM users WHERE username = ?"
    ).bind(username).first();

    if (!user) {
      message.setReject("Unknown BateMail recipient");
      return;
    }

    if (message.rawSize > 10 * 1024 * 1024) {
      message.setReject("Email exceeds BateMail's size limit");
      return;
    }

    const parsed = await PostalMime.parse(message.raw);

    const sender = String(
      parsed.from?.address || message.from || ""
    ).slice(0, 320);

    const subject = String(parsed.subject || "").slice(0, 998);
    const body = String(parsed.text || "").slice(0, 100000);

    await env.DB.prepare(
      "INSERT INTO emails (recipient, sender, subject, body) VALUES (?, ?, ?, ?)"
    ).bind(recipient, sender, subject, body).run();
  }
};
