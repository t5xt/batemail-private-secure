# BateMail server (receive-only)

People get a free address at batemail.lol and can **receive** mail from anyone. They **cannot send**
any. Everything (accounts, mail, forum posts) is saved in **one encrypted file**: `data/batemail.enc`
(AES-256-GCM). The key is your `DATA_KEY` secret, which lives only on your server. Nothing is ever
deleted, and the previous version is kept as `batemail.enc.bak`.

No installs needed. Just Node 18 or newer.

## Run it

```bash
export DATA_KEY="a-long-random-secret-only-you-know"   # 16+ characters
export TRUST_PROXY=1                                    # when behind Caddy/nginx
node server.js
```

It starts two things:
- the website on `127.0.0.1:3000` (settings: `PORT`, `HOST`)
- a mail receiver on `0.0.0.0:2525` (settings: `SMTP_PORT`, `SMTP_HOST`)

Other settings: `DOMAIN` (default `batemail.lol`), `DATA_DIR` (default `./data`).

**Write `DATA_KEY` down somewhere safe.** If you lose it, the data can never be recovered.
Also copy `data/batemail.enc` somewhere safe now and then. It is already encrypted.

## Put it on batemail.lol

1. Get a server (a small VPS, or a computer at home).
2. **Website:** point the domain's A record at the server's IP, install [Caddy](https://caddyserver.com)
   and use the included `Caddyfile`. It gets a free HTTPS certificate automatically.
3. **Incoming mail:** add DNS records
   - `mail.batemail.lol`  A  `<server IP>`
   - `batemail.lol`  MX  priority 10  `mail.batemail.lol`

   Then make port 25 reach the receiver. Easiest: run with `SMTP_PORT=25` after
   `sudo setcap 'cap_net_bind_service=+ep' $(which node)`. Open port 25 in your firewall too.
4. Keep the app running with systemd, pm2, or a `screen` session.

Many home internet providers block port 25. A VPS usually works. Free option: Oracle Cloud's free tier
VM (open port 25 in its security list). The domain name itself still costs a yearly fee.

## Read the data as the owner

```bash
DATA_KEY="your secret" node server.js dump
```

Prints everything decrypted (users, mail, forum). Only someone with the key can do this.

## What it does and doesn't do

- **Receive-only.** There is no send feature and no sending endpoint. The mail receiver only accepts
  mail for existing batemail.lol users and refuses everything else, so it can't be used to relay spam.
- Plain-text and HTML mail is shown as text. Attachments and images are dropped.
- Incoming mail is not spam-filtered and has no TLS yet, so some senders may hesitate. Limits per
  sender IP (kept in memory only) and a 1 MB size cap are built in.
- Passwords are required and stored as salted scrypt hashes. Login and sign-up are rate-limited.
- Forum posts are anonymous: no account or IP address is saved with them.
- Mail is encrypted in the file, but the server can read it while running, as with any server.
- Sessions are kept in memory, so restarting the server logs everyone out.
