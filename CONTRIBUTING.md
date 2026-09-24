# Contributing

Thanks for taking the time to contribute.

## Development setup

Follow the "Getting started" section of the README. You need Node.js 24 (or 22.12+),
Docker and a Shopify development store.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm run docker:test
```

All three must pass. Tests run in Docker against real Postgres and Redis instances; please
add unit tests for pure logic under `app/lib/**` and integration tests for routes, webhooks
and workers under `tests/integration/`.

## Guidelines

- Keep pure logic in `app/lib/**` free of I/O so it stays unit-testable.
- Follow the current Shopify recommendations: GraphQL Admin API only, managed installation,
  Polaris web components. Do not introduce REST Admin API calls or legacy OAuth flows.
- Request only read scopes; the app must never modify a store.
- Keep the UI accessible (labels, keyboard navigation, contrast).
- Use conventional, descriptive commit messages.

## Reporting issues

Open a GitHub issue with steps to reproduce, the expected behaviour and relevant logs
(redact API keys and shop domains).
