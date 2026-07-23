# Security Policy

## Reporting a vulnerability

If you find a security issue, open a [GitHub issue](https://github.com/EithonX/seadex-mirror/issues/new) with the `bug` label.

This is a static site — no server-side runtime, no authentication, no user data. The attack surface is small. But if you find something worth reporting (XSS in the frontend, a CSP bypass, credentials leaking through the build pipeline), please do.

## Scope

**In scope:**

- The mirror frontend at [seadex.pages.dev](https://seadex.pages.dev)
- Build scripts in `scripts/`
- GitHub Actions workflows
- Cloudflare Pages configuration (`_headers`, `_redirects`)

**Out of scope:**

- The upstream SeaDex site at [releases.moe](https://releases.moe)
- AniList's API or website
- Cloudflare's own infrastructure
