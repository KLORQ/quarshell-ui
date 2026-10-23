# quarshell-ui agent guide

This repository owns the browser and desktop-installable console only. Keep Go,
gateway server logic, protocol sources, and generated clients out of this repo.
`@klorq/quarshell-proto` comes from the sibling `quarshell-proto/typescript` module.

Use strict TypeScript, validate JSON at network boundaries, keep access tokens
out of URLs/logs, and preserve same-origin routing for HTTP and WebSocket API
calls. Browser tests run in Chrome. Run `npm run check`, `npm run build`, and
`npm run test:e2e` for UI changes. Build the image from the workspace root so
the pinned protocol checkout is available.
