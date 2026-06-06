# 捜索マップ / Search Map

A lightweight, self-hosted web map for **coordinating ground searches for a missing
person**. Volunteers upload the GPX track from their phone/GPS, and everyone can see —
on one map — **where searching has already happened** and where the gaps are.

Built to go live fast with **no external services**: plain Node + local file storage.
Base maps use the **GSI (国土地理院 / Geospatial Information Authority of Japan)** tiles,
which Japanese searchers will recognise, including topo, pale, relief and satellite layers.

## Features

- **Open GPX upload** — name, date, searcher, notes, colour. No account needed.
- **All tracks on one map**; overlapping lines show repeatedly-covered ground, blanks show gaps.
- **Japanese + English** interface.
- **Mobile friendly** for use in the field.
- **Security built in**: file-type & size validation, upload rate-limiting, secure
  headers, an optional upload passphrase, and a token-gated delete for moderation.

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
| `UPLOAD_PASSPHRASE` | _(unset)_ | If set, uploaders must enter this. Leave unset for fully-open uploads |
| `ADMIN_TOKEN` | _(unset)_ | Required to delete tracks. If unset, deletion is disabled |

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

## Data & privacy

GPX tracks reveal where searchers walked — which is the point here. Uploaded files
and the `tracks.json` index live under `DATA_DIR` and are never committed to git.

## Tech

Express · Multer · Helmet · express-rate-limit · Leaflet · leaflet-gpx · GSI Japan tiles.
