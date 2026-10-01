# SkyHigh Event Radio

A temporary WebRTC, radio-style voice network for SkyHigh events.

- Frontend: GitHub Pages static site in `site/`
- Signaling: Cloudflare Worker + Durable Objects in `worker/`
- Channel names: aviation frequencies, COM1, COM2, or any entered channel string
- Intended for temporary small-group event use; rooms are limited to 19 participants.

## Quick start

1. Deploy `worker/` with Wrangler.
2. Put the deployed Worker WebSocket URL into `site/config.js`.
3. Enable GitHub Pages from the `main` branch and `/site` folder.

See the source files for deployment commands and configuration.
