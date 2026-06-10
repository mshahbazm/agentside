# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email the
maintainer at `msmanzoor91@gmail.com` with:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept), and
- any suggested remediation.

You'll get an acknowledgement within a few days. Please allow a reasonable
window to ship a fix before public disclosure.

## Security model (what this project assumes)

agentside is open source by design — its security must not depend on the code
being secret. It rests on configuration and secrets that live only in your
environment:

- **`AUTH_SECRET`** verifies the JWT your frontend presents at the WebSocket
  upgrade. Keep it secret; rotate on any suspicion.
- **`APP_API_KEY`** is the service credential the agent uses to call your API.
  Combined with the `X-Act-As-User-Id` header, it can act as *any* user — so
  your app's API must accept those headers only on a trusted internal network,
  never from the public internet.
- **`CORS_ORIGINS`** gates both HTTP CORS and the WebSocket `Origin` check.
  Set it to your real frontend origins only.

The agent has no filesystem or shell tools, and all authorization is enforced
by your API per request. See the "Security model" and "Deploying safely"
sections of the README for details.
