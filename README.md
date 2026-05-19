# SeaDex mirror

This repo hosts an unofficial resilience mirror for `releases.moe`.

The current architecture is intentionally simple:

- Cloudflare Worker serves the API and static frontend
- D1 stores a clean mirrored snapshot
- an external rebuild script fetches SeaDex public data plus AniList metadata, verifies parity, and rewrites D1 from a known-good snapshot

## Why this changed

The earlier Worker-side sync path was flaky for two reasons:

- AniList requests from inside the Worker were unreliable
- partial sync logic allowed torrent rows to drift out of parity with the source

The live source audit showed:

- SeaDex currently exposes `2661` public entries
- all live entries currently expand to torrents through `expand=trs`
- broken torrent links in the mirror came from unresolved relative source URLs, not missing source data

So the mirror now rebuilds from a full validated snapshot instead of trying to patch data incrementally inside a single Worker invocation.

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

Rebuild remote D1 from live SeaDex + AniList:

```bash
npm run rebuild:d1
```

Deploy Worker + static assets:

```bash
npm run deploy
```

## D1 workflow

The intended flow is:

1. create or recreate the D1 database
2. apply [`migrations/0001_init.sql`](migrations/0001_init.sql)
3. run [`scripts/rebuild-d1.mjs`](scripts/rebuild-d1.mjs) against the remote database
4. deploy the Worker

The rebuild script:

- fetches `listIDs`
- fetches all public `entries` with `expand=trs`
- verifies parity between those two source views
- resolves relative torrent URLs against `https://releases.moe`
- fetches AniList only for SeaDex entry IDs
- writes a full clean snapshot into D1

## Automation

Cloudflare free-tier Workers are fine for serving the mirror, but they are not a reliable place to do the full AniList enrichment pass.

The recommended automation path is the GitHub Actions workflow in `.github/workflows/rebuild-mirror.yml`.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`

Optional repository variables:

- `CLOUDFLARE_D1_DATABASE_NAME`

## Frontend

The old placeholder frontend has been replaced with a TypeScript app built by Vite.

Goals of the new UI:

- make mirror freshness and integrity visible
- keep torrent choices readable on desktop and mobile
- clearly distinguish original SeaDex links from mirrored cached data
- feel intentional instead of generic

## Notes

- This mirror is unofficial.
- Credit and source links should always point back to `releases.moe`.
- AniList metadata is cached for mirrored SeaDex entries only.
