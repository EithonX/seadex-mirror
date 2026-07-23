# Contributing

This is an unofficial mirror of [SeaDex](https://releases.moe). If your issue is with the upstream data (wrong entries, missing torrents, etc.), report it to the [original project](https://github.com/seadex-moe/seadex) instead.

## Setup

```bash
git clone https://github.com/EithonX/seadex-mirror.git
cd seadex-mirror
npm install
```

To run the dev server with live data:

```bash
npm run data:build
npm run dev
```

`data:build` fetches live data from SeaDex and AniList. It works without API keys, though you may hit AniList rate limits without an `ANILIST_ACCESS_TOKEN` set in `.env`.

## Submitting changes

1. Fork the repo and create a branch off `main`
2. Make your changes
3. Run `npm run typecheck` to catch type errors
4. Open a pull request

Keep PRs focused — one feature or fix per PR.

## What's in scope

- Frontend improvements (UI, accessibility, performance)
- Build script fixes and optimizations
- Documentation
- CI and deployment improvements

## What's out of scope

- Changes to the upstream SeaDex data format — those go to [seadex-moe/seadex](https://github.com/seadex-moe/seadex)
- Features that require a server-side runtime — the architecture is intentionally static
