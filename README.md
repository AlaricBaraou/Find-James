# 捜索マップ / Search Map

A lightweight, self-hosted web map for **coordinating ground searches for a missing
person**. Volunteers upload the GPX track from their phone/GPS, and everyone can see —
on one map — **where searching has already happened** and where the gaps are.

Built to go live fast with **no external services**: plain Node + local file storage.
Base maps use the **GSI (国土地理院 / Geospatial Information Authority of Japan)** tiles,
which Japanese searchers will recognise, including topo, pale, relief and satellite layers.

## Features

- **Open GPX upload** — name, date, searcher, notes, colour. No account needed.
- **Searched vs planned tracks** — completed searches render solid; planned routes dashed.
- **All tracks on one map**; overlapping lines show repeatedly-covered ground, blanks show gaps.
- **Trail-aware route planner** — click waypoints on the map and the route snaps to real
  OSM trails via [BRouter](https://brouter.de/) (`hiking` profile, no API key), then saves
  as a planned route. Falls back to straight segments off-trail.
- **Claim a route** — volunteers claim a planned route (`open → claimed → completed`) so
  people stop duplicating effort; status is live on the map for everyone.
- **Recommended routes** — admins can flag planned routes as ★ recommended.
- **3D terrain view** — a three.js viewer builds an elevation mesh from GSI DEM tiles,
  drapes satellite/relief imagery, and projects the tracks onto the terrain. Great for
  understanding ridgelines and valleys in mountain searches.
- **Optional anonymous sign-in + contact** — passwordless **magic-link email** login
  (your email is only used to send the link; everyone else sees a chosen nickname). Each
  route gets a **contact thread** so volunteers can team up ("I'll do that ridge with
  you"); the owner/claimer gets an email nudge that reveals no address or message body.
  An optional **group-chat link** (e.g. LINE OpenChat) can be surfaced for real-time
  coordination. All of this stays dormant until SMTP is configured — uploads remain open.
- **Japanese + English** interface, **mobile friendly** for field use.
- **Security built in**: file-type & size validation, upload rate-limiting, secure
  headers, an optional upload passphrase, a token-gated delete for moderation, and
  httpOnly + SameSite session cookies for sign-in.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Configuration (environment variables)

All optional — see `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where GPX files + metadata live — **use a persistent path in production** |
| `MAX_FILE_BYTES` | `10485760` (10 MB) | Max upload size |
| `SEARCH_LAT` / `SEARCH_LON` | Kyoto | Default map center for the search area |
| `SEARCH_ZOOM` | `12` | Default zoom |
| `SEARCH_AREA_NAME` | _(unset)_ | Label shown in the panel header |
| `UPLOAD_PASSPHRASE` | _(unset)_ | If set, uploaders must enter this. Leave unset for fully-open uploads |
| `ADMIN_TOKEN` | _(unset)_ | Required to delete tracks. If unset, deletion is disabled |
| `MAIL_SMTP_URL` | _(unset)_ | SMTP transport (`smtps://user:pass@host:port`). **Enables sign-in.** Unset = auth off |
| `MAIL_FROM` | _(localhost)_ | From-address for sign-in emails |
| `PUBLIC_URL` | _(inferred)_ | Base URL used to build magic-links — set in production |
| `COOKIE_SECURE` | auto | `1` to force HTTPS-only session cookies |
| `AUTH_DEV_ECHO` | _(off)_ | Local testing only: returns the magic link in the API response. **Never in production** |
| `GROUP_CHAT_URL` | _(unset)_ | Optional anonymous group-chat link shown in the UI |

### Moderating / deleting tracks

Set `ADMIN_TOKEN` to a long random string, then open the site at:

```
https://your-site/#admin=YOUR_TOKEN
```

A ✕ delete button appears next to each track. The token stays in the URL fragment
(never sent to the server except as a header on delete), so don't share that link.

### Locking down uploads later

If open uploads get abused, set `UPLOAD_PASSPHRASE` and redeploy. The upload form
will show a passphrase field automatically. No code change required.

### Turning on sign-in & contact

Auth is **off by default** — the site works fully anonymously. To enable it, point
`MAIL_SMTP_URL` at any email provider (Resend, Postmark, Mailgun, SendGrid, Gmail
SMTP…), set `MAIL_FROM` and `PUBLIC_URL`, and redeploy. Then a **Sign in** button
appears: a volunteer enters their email, clicks the link, picks a nickname, and can
use the per-route **Contact** threads. Uploads/claims made while signed in are tied to
that nickname so others can reach them. To test locally without a mailbox, run with
`AUTH_DEV_ECHO=1` (the link comes back in the API response).

## Deploy (when you're back at a computer)

The app is a single Node process that stores files on disk, so **pick a host with a
persistent disk/volume** (otherwise uploads vanish on redeploy).

**Docker (any VPS):**

```bash
docker build -t search-map .
docker run -d -p 80:3000 -v /srv/searchmap-data:/data \
  -e ADMIN_TOKEN="$(openssl rand -hex 16)" \
  --restart unless-stopped search-map
```

**Render / Railway / Fly.io:** deploy from this repo, set the env vars above, and
attach a persistent disk mounted at the path you set as `DATA_DIR` (e.g. `/data`).

> ⚠️ **Ephemeral filesystems** (e.g. some free tiers) lose uploaded files on
> redeploy/restart. For long-running searches, use a persistent volume, or migrate
> storage to an object store (S3/R2) later.

## 3D terrain & the GSI proxy

The 3D view (`/terrain.html`) fetches **GSI DEM elevation tiles** and imagery. GSI tiles
don't send CORS headers, which would taint WebGL textures and block DEM `fetch()`, so the
server proxies them **same-origin** at `/api/gsi/:layer/:z/:x/:y`. This means:

> The 3D view requires the **server** to have outbound access to
> `cyberjapandata.gsi.go.jp`. If the host blocks egress, the 3D view shows flat terrain
> with a notice; the 2D map is unaffected (it loads GSI directly in the browser).

The route planner calls **BRouter** directly from the browser (`brouter.de`), so it needs
client-side outbound access only.

> ⚠️ **Status:** the planner and 3D viewer are v1 and best-tuned in a real browser.

## Data & privacy

GPX tracks reveal where searchers walked — which is the point here. Uploaded files
and all JSON state (`tracks`, `users`, `sessions`, `messages`) live under `DATA_DIR`
and are never committed to git. Emails are stored only to send login links and are
never exposed to other users; contact threads show only nicknames.

## Tech

Express · Multer · Helmet · express-rate-limit · cookie-parser · Nodemailer ·
Leaflet · leaflet-gpx · three.js · GSI Japan tiles · BRouter.
