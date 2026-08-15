# Security Policy

## Reporting a vulnerability

Please **do not open a public issue containing vulnerability details, leaked credentials, proof-of-concept payloads, or other sensitive security information**.

Use GitHub's **Security → Report a vulnerability** flow for this repository so the report starts as a private security advisory. Include the affected component, impact, reproduction steps, and any proof of concept needed to validate the issue.

If private vulnerability reporting is temporarily unavailable, open a public issue containing only a request for a private reporting channel. Do not include the vulnerability details in that issue.

For ordinary non-sensitive bugs, use the normal issue tracker.

## Scope

In scope:

- the mirror frontend deployed from this repository
- build, snapshot, verification, and recovery scripts under `scripts/`
- GitHub Actions workflows
- repository-controlled Cloudflare Pages headers and redirects
- supply-chain or workflow issues that could expose repository/deployment credentials or publish an untrusted snapshot

Out of scope:

- vulnerabilities in the upstream SeaDex service that are not caused by this mirror
- vulnerabilities in AniList itself
- Cloudflare or GitHub infrastructure vulnerabilities outside this repository's configuration

## Design notes

This project intentionally has no application server, login system, user database, or server-side session state. That reduces the public runtime attack surface, but the build pipeline remains security-sensitive because it holds deployment credentials and converts third-party data into published HTML/JSON.

The workflows therefore scope secrets to individual steps, pin external Actions to immutable commit SHAs, validate externally sourced URLs before rendering, and cryptographically verify snapshots before deployment.
