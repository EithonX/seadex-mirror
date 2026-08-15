# Contributing

SeaDex Mirror is an unofficial static mirror of [SeaDex](https://releases.moe). Problems with the underlying recommendations or upstream records should normally be reported to the [SeaDex project](https://github.com/seadex-moe/seadex), not corrected by silently forking the data here.

## Setup

Use Node.js 24.x and the committed lockfile:

```bash
git clone https://github.com/EithonX/seadex-mirror.git
cd seadex-mirror
npm ci
```

Generate live mirror data when your change needs it:

```bash
npm run data:build
npm run dev
```

The data build works without API credentials. An optional `ANILIST_ACCESS_TOKEN` may be supplied for AniList requests.

## Before opening a pull request

Run the deterministic checks that do not require upstream access:

```bash
npm run verify
```

For changes to the data pipeline, generated schema, frontend build, or deployment behavior, also run the relevant end-to-end checks with a generated snapshot:

```bash
npm run data:build
npm run verify:mirror-data
npm run build:frontend
npm run verify:frontend-build
npm run verify:pages-limits
```

A data-pipeline bug fix should include a regression test whenever the affected logic can be isolated without live network access.

## Engineering constraints

These are intentional project properties, not implementation accidents:

- Keep the public site fully static.
- Do not introduce a database, paid storage dependency, server process, or Pages Function for work that can be solved during the build.
- Never weaken source parity, manifest verification, atomic replacement, or deployment verification to make a flaky build appear green.
- Preserve the previous known-good snapshot when an upstream dependency is incomplete or unavailable.
- Treat upstream/workbook/AniList strings as untrusted when they cross into HTML or URLs.
- Keep dependencies and GitHub Actions reproducible; CI uses `npm ci` and Actions are pinned by commit SHA.
- Keep changes focused and readable. Avoid generated-code churn unrelated to the change.

## Pull requests

1. Branch from `main`.
2. Make the smallest coherent change that solves the problem completely.
3. Add/update tests and documentation where behavior changes.
4. Run the applicable verification commands above.
5. Open a pull request describing the behavior change and how it was verified.

## Security issues

Follow [SECURITY.md](SECURITY.md). Do not place sensitive vulnerability details in a public issue or pull request.
