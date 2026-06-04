# x402-server-kit

Receive **x402** (HTTP 402) micropayments in a **Fastify** app, with the boilerplate every
server reimplements done for you — over the official [`@x402/*`](https://docs.x402.org) packages.

[x402](https://docs.x402.org) turns HTTP 402 into a real payment flow: an unpaid request to a
gated route gets `402` + signed `PaymentRequirements`; the client retries with an EIP‑3009
`transferWithAuthorization` signature; your server delegates verification + settlement to a
**facilitator** (you never hold the payer's key or touch the chain yourself). This kit adds:

- **Facilitator selection** — Coinbase **CDP** (hosted, lands you in the Bazaar discovery index)
  when CDP credentials are present, otherwise a **permissionless** facilitator URL. One simple,
  unambiguous rule.
- **A validated, frozen paywall config** built from a plain `routes` array — fail‑fast on a bad
  address, network, price, or facilitator URL at boot rather than mid‑payment.
- **Bazaar discovery wiring** — each route is decorated so the facilitator can catalogue your
  paid endpoints.
- **`describePaywall()`** — a JSON projection of price + rails for a `/` index or an agent/MCP
  surface, so callers can introspect cost without making a 402‑receiving request first.

It reads **no `process.env`** and holds **no shared mutable state** — you pass everything in,
including secrets. The heavy `@x402` runtime is loaded **lazily**, so the pure config/price
helpers stay usable and unit‑testable without paying for the wagmi/viem stack.

> **Status:** powers the x402 paywall on the **Seneschal data API** in production at
> [api.seneschal.space](https://api.seneschal.space/.well-known/x402) — Private Watch + Penny
> Oracle micropayments on Base, settled through the Coinbase CDP facilitator. `0.x` while the
> public API settles.

## Install

```bash
npm install x402-server-kit fastify
# optional — only if you use the Coinbase CDP facilitator:
npm install @coinbase/x402
```

`fastify` and `@coinbase/x402` are **optional peer dependencies**: bring `fastify` if you call
`registerX402`, and `@coinbase/x402` only if you use CDP mode. Requires **Node ≥ 20**.

## Quickstart

Full runnable server in [`examples/fastify-server.mjs`](examples/fastify-server.mjs):

```js
import Fastify from 'fastify';
import { buildX402Config, registerX402, describePaywall } from 'x402-server-kit';

const x402 = buildX402Config({
  recipient: process.env.X402_RECIPIENT,                  // 0x... receives the funds
  facilitatorUrl: 'https://facilitator.openx402.ai',      // permissionless default
  cdpApiKeyId: process.env.CDP_API_KEY_ID,                // both set → CDP facilitator
  cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  routes: [
    { method: 'GET',  path: '/v1/premium/quote', price: '$0.01', description: 'A premium quote.' },
    { method: 'POST', path: '/v1/premium/job',   price: '$0.10', description: 'Submit a job.' }
  ]
});

const app = Fastify();
if (x402.enabled) {
  await registerX402(app, x402, {                         // install BEFORE the gated routes
    cdpApiKeyId: process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET
  });
}
app.get('/', async () => ({ paywall: describePaywall(x402) }));
app.get('/v1/premium/quote', async () => ({ quote: 42 })); // only runs after payment settles
```

## Facilitator modes

| Condition | Mode | Facilitator URL |
| --- | --- | --- |
| both `cdpApiKeyId` **and** `cdpApiKeySecret` set | `cdp` | `CDP_FACILITATOR_URL` (Coinbase) — pinned, ignores `facilitatorUrl` |
| otherwise | `url` | your `facilitatorUrl` (e.g. a permissionless facilitator) |

Presence of *both* CDP credentials is the single, unambiguous "settle through Coinbase" signal —
it avoids the "explicit URL silently wins over my new keys" footgun. CDP credentials are **never
stored** on the returned config (so they can't leak via `describePaywall`); pass them to
`registerX402` / `createFacilitatorClient` at dispatch time.

## API

| Export | Kind | Purpose |
| --- | --- | --- |
| `buildX402Config(opts)` | pure | validate options → frozen config (`{enabled,recipient,network,facilitatorUrl,facilitatorMode,routes,premiumRoutes}` or `{enabled:false,reason}`) |
| `registerX402(app, cfg, creds?)` | async | install the paywall middleware on a Fastify app (lazy‑loads `@x402/*`) |
| `createFacilitatorClient(cfg, creds?)` | async | build the verify/settle client (CDP or permissionless) |
| `describePaywall(cfg)` | pure | JSON price/rails projection, or `null` when off |
| `discoveryConfigForRouteKey(key)` | pure | Bazaar discovery config for a `"METHOD /path"` key |
| `assertPrice(price, name)` | pure | guard a price string (`"$0.05"` or atomic `"50000"`) |
| `CDP_FACILITATOR_URL` | const | the Coinbase CDP facilitator endpoint |

### `buildX402Config(opts)` options

| Option | Default | Notes |
| --- | --- | --- |
| `recipient` | — | **required** `0x` address; unset ⇒ `{enabled:false}` |
| `routes` | — | **required** `[{ method, path, price?, description?, mimeType? }]` |
| `network` | `eip155:8453` | CAIP‑2 chain id (Base mainnet) |
| `facilitatorUrl` | `''` | permissionless URL; required unless CDP creds present |
| `cdpApiKeyId` / `cdpApiKeySecret` | `''` | both ⇒ CDP facilitator mode |
| `maxTimeoutSeconds` | `120` | per‑route settlement window |
| `defaultPrice` | `'$0.05'` | used for routes with no `price` |
| `defaultMimeType` | `'application/json'` | per‑route mime fallback |
| `enabled` | `true` | explicit off‑switch |

Prices are either **Money strings** (`"$0.05"`) or **atomic‑unit integer strings** (`"50000"` =
0.05 USDC at 6 decimals); the facilitator resolves the canonical USDC contract for the network.

## A note on dynamic imports

`registerX402` and `createFacilitatorClient` `await import('@x402/...')` on first use. This is
deliberate: it keeps the pure config/price helpers importable and testable without loading the
large `@x402` + wagmi/viem runtime, and lets an app that boots with the paywall disabled avoid
the cost entirely.

## Testing

```bash
npm install
npm test        # jest, ESM (node --experimental-vm-modules)
```

The suite covers config validation, the `describePaywall` projection, and the Bazaar discovery
wiring — all pure, no network. Wire `registerX402` into an integration test in your own app.

## License

[MIT](LICENSE)
