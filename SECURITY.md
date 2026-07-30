# Security policy

## Reporting a vulnerability

Please report security issues privately through the repository's
[security advisory form](https://github.com/daugasauron/piodide/security/advisories/new).
Do not include credentials, access tokens, private repository contents, or
other sensitive data in a public issue.

## Credential model

Piodide is a static browser application. Provider API keys and GitHub tokens
are held only in page memory and are cleared by a refresh. They are not stored
in local storage, browser sessions, the in-memory filesystem, or the deployed
GitHub Pages site.

The optional Codex subscription proxy binds only to loopback. OpenAI OAuth
credentials remain in that local process; the browser receives only a
process-local capability for the duration of the proxy session.
