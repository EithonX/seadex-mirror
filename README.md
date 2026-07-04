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
npm run build:frontend
```

Verify generated mirror data:

```bash
npm run verify:mirror-data
```

Verify frontend build output:

```bash
npm run verify:frontend-build
```

Build a deployable site snapshot:

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
2. write `status.json`, `catalog.json`, `sheet-workbook.json`, and `entries/<anilist-id>.json` into `frontend/public/mirror-data`
3. build the frontend with Vite
4. deploy the static output to Cloudflare Pages

The data builder has two intentional unchanged-upstream behaviors:

- `--onUnchanged=skip`
  Use this for scheduled CI rebuilds. If the upstream probe signature matches the last deployed snapshot, the job exits without rebuilding local files or deploying again.
- `--onUnchanged=materialize`
  Use this for packaging or deploy builds. If upstream is unchanged but the local `frontend/public/mirror-data` folder is missing, the job reconstructs a complete local snapshot using the available cache instead of producing an empty site.

The static data builder:

- fetches `listIDs`
- fetches all public `entries` with `expand=trs`
- verifies parity between those two source views
- resolves relative torrent URLs against `https://releases.moe`
- fetches AniList only for SeaDex entry IDs
- enriches relation data for extra franchise context on entry pages
- writes a full clean snapshot into static JSON files

## Frontend data loading

- Catalog pages read `catalog.json` for table filtering and global search.
- Entry pages load `entries/<alId>.json` directly, without loading `catalog.json`.
- `/sheet` loads `sheet-workbook.json` and lazy-loads the sheet workbook renderer as a separate frontend chunk.

`npm run verify:mirror-data` checks that the expected generated JSON files exist and have the basic shape the frontend needs. `npm run verify:frontend-build` checks that the production build keeps the sheet renderer in its lazy chunk.

## Cache policy

Cloudflare Pages headers keep freshness short for top-level mirror indexes:

- `catalog.json`, `status.json`, and `sheet-workbook.json`: 60 seconds
- `entries/*`: 900 seconds

Hashed frontend assets are cached immutably.

## Automation

Cloudflare Pages is the recommended deployment target because static asset requests are free and do not burn Workers request quota. The full enrichment pass should still happen outside Cloudflare at build time.

The recommended automation path is the GitHub Actions workflow in `.github/workflows/rebuild-mirror.yml`.

Required GitHub secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Optional repository variables:

- `CLOUDFLARE_PAGES_PROJECT_NAME`
  Default expected project name: `seadex`

Optional GitHub secrets:

- `ANILIST_ACCESS_TOKEN`
  Recommended if you want authenticated AniList GraphQL access during snapshot builds.

Workflow split:

- `.github/workflows/rebuild-mirror.yml`
  Scheduled every 12 hours and manually runnable. Uses `--onUnchanged=skip`, so it only rebuilds and deploys when upstream data actually changed. It also supports a manual `force` input.
- `.github/workflows/deploy-site.yml`
  Runs on `main` pushes that touch app/workflow/build files. Uses `--onUnchanged=materialize`, so frontend-only deploys still package a complete local snapshot even on fresh CI checkouts.

Cloudflare Pages deployment note:

- These workflows use Direct Upload through Wrangler and explicitly deploy to the production branch (`main`), so successful runs update `seadex.pages.dev` instead of only creating a preview deployment URL.

## Frontend goals

- stay close to SeaDex's editorial browsing feel
- keep torrent choices readable on desktop and mobile
- surface mirror freshness without turning the site into a dashboard
- leave room for extra metadata such as franchise context

## Notes

- This mirror is unofficial.
- Credit and source links should always point back to `releases.moe`.
- AniList metadata is cached for mirrored SeaDex entries only.
