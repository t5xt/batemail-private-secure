# BateMail

A small, receive-only email web app. Users can create an address, log in, read incoming mail, and post anonymously in the forum. It does **not** send email.

## Requirements
- Node.js 18 or newer
- For internet email, a server reachable on TCP port 25 and a domain with DNS access
- No npm dependencies are required

## Run locally
Set a strong `DATA_KEY` (at least 16 characters), then run:

```bash
export DATA_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
node server.js
```

Open http://127.0.0.1:3000. SMTP listens on port `2525` by default; internet mail servers generally deliver to port `25`. On PowerShell, set `$env:DATA_KEY = "your-long-random-secret"` before running `node server.js`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATA_KEY` | required | Secret used to derive the encryption key. Keep private and backed up. |
| `DOMAIN` | `batemail.lol` | Domain used for mailbox addresses and SMTP recipient checks. |
| `HOST` | `127.0.0.1` | HTTP bind address. |
| `PORT` | `3000` | HTTP port. |
| `SMTP_HOST` | `0.0.0.0` | SMTP bind address. |
| `SMTP_PORT` | `2525` | SMTP port; production usually needs `25`. |
| `DATA_DIR` | `./data` | Directory for encrypted database and backup. |
| `TRUST_PROXY` | `0` | Set to `1` only behind a trusted reverse proxy. |

`.env.example` is a template only; this dependency-free app does not automatically load `.env`. Configure environment variables in your shell or hosting dashboard.

## Production deployment
1. Upload this project to your server and install Node.js 18+.
2. Set a randomly generated, private `DATA_KEY` in the service environment. Never commit it.
3. Point your domain's A/AAAA record to the server. Edit `Caddyfile` for your domain and use Caddy to provide HTTPS for the website.
4. Add an MX record for your domain pointing to a mail host (for example `mail.example.com`) and an A/AAAA record for that host pointing to the server.
5. Allow TCP 25 through your provider and firewall. Set `SMTP_PORT=25`; binding to port 25 may require privileges/capabilities on Linux.
6. Run `npm start` under a process manager or systemd. Keep `DATA_KEY` stable across restarts.

The included Caddyfile is an example for `batemail.lol`; change it for another domain. Website HTTPS does **not** enable SMTP TLS. The SMTP receiver has no TLS, spam filtering, or advanced MIME support, so this is not a hardened public mail platform.

## Data and security
- Password hashes use scrypt; the database file is encrypted with AES-256-GCM.
- Runtime data is created in `data/`, excluded from Git by `.gitignore`.
- Back up `data/batemail.enc` securely and keep the matching `DATA_KEY`. Losing the key means losing access to the data.
- `node server.js dump` prints decrypted user/mail/forum data to the terminal; protect its output.
- Sessions are held in memory and cleared when the server restarts.
- The UI renders mail and forum content as text, not HTML.
- This is a starter project: it lacks spam filtering, SMTP TLS, mailbox deletion/quotas, and durable sessions.

## Check
```bash
npm run check
```

## GitHub upload
Upload the contents of this folder (including `server.js`, `public/`, `package.json`, `Caddyfile`, and `.gitignore`) to a new GitHub repository. Do **not** upload `.env`, `data/`, encryption keys, or real mailbox data.
