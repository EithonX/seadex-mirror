# SeaDex mirror

This repo hosts an unofficial static mirror for `releases.moe`.

The current architecture is intentionally simple:

- GitHub Actions or a local script fetch SeaDex public data plus AniList metadata
- the build step writes static JSON into `frontend/public/mirror-data`
- Vite builds a static frontend that reads those files directly
- Cloudflare Pages serves the app as static assets

## Why this works

The public SeaDex data is mostly read-heavy and changes far less often than users browse it. That makes a static snapshot a much better fit than a live database on a free-tier quota.

## Core commands

Install dependencies:

```bash
npm install
```

Typecheck:

```bash
npm run typecheck
```

Build the frontend:

```bash
npm run build
```

Build local mirror data from live SeaDex + AniList:

```bash
npm run data:build
```

Build data and static site together:

```bash
npm run build:site
```

Deploy to Cloudflare Pages:

```bash
npm run deploy
```

## Static data workflow

The intended flow is:

1. run [`scripts/build-static-data.mjs`](scripts/build-static-data.mjs)
2. write `status.json`, `catalog.json`, and `entries/<anilist-id>.json` into `frontend/public/mirror-data`
3. build the frontend with Vite
4. deploy the static output to Cloudflare Pages

The static data builder:

- fetches `listIDs`
- fetches all public `entries` with `expand=trs`
- verifies parity between those two source views
- resolves relative torrent URLs against `https://releases.moe`
- fetches AniList only for SeaDex entry IDs
- enriches relation data for extra franchise context on entry pages
- writes a full clean snapshot into static JSON files

## Automation

Cloudflare Pages is the recommended deployment target because static asset requests are free and do not burn Workers request quota. The full enrichment pass should still happen outside Cloudflare at build time.

The recommended automation path is the GitHub Actions workflow in `.github/workflows/rebuild-mirror.yml`.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`

Optional repository variables:

- `CLOUDFLARE_PAGES_PROJECT_NAME`

## Frontend goals

- stay close to SeaDex's editorial browsing feel
- keep torrent choices readable on desktop and mobile
- surface mirror freshness without turning the site into a dashboard
- leave room for extra metadata such as franchise context

## Notes

- This mirror is unofficial.
- Credit and source links should always point back to `releases.moe`.
- AniList metadata is cached for mirrored SeaDex entries only.
