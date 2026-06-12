// x402-server-kit — receive x402 (HTTP 402) micropayments in a Fastify
// app on an EVM network (Base mainnet by default).
//
// x402 (docs.x402.org): an unpaid request to a gated route gets HTTP 402
// + signed PaymentRequirements; the client retries with an EIP-3009
// `transferWithAuthorization` signature; the server delegates
// verification + settlement to a facilitator. The heavy lifting is done
// by the official `@x402/*` packages — this kit adds the bits every
// server reimplements:
//
//   • facilitator selection (Coinbase CDP vs a permissionless URL),
//   • a validated, frozen paywall config built from a plain routes array,
//   • Bazaar discovery wiring,
//   • `describePaywall()` — a JSON projection for agent/discovery surfaces.
//
// Design notes:
//   * Nothing here reads process.env or holds shared mutable state.
//     Everything is passed in; callers own their config + secrets.
//   * The `@x402/*` runtime (which drags in the wagmi/viem stack) is
//     loaded **lazily** inside `registerX402` / `createFacilitatorClient`,
//     so the pure config + price helpers (`buildX402Config`,
//     `describePaywall`, `assertPrice`, `discoveryConfigForRouteKey`) stay
//     usable and unit-testable without paying that cost. This is a
//     deliberate, documented use of dynamic import.
//   * CDP credentials are never stored on the returned config object, so
//     they can't leak through `describePaywall`; pass them to
//     `registerX402` / `createFacilitatorClient` at dispatch time.

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const NETWORK_RE = /^eip155:\d+$/u;
const HTTP_URL_RE = /^https?:\/\//u;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

const DEFAULTS = Object.freeze({
	network: 'eip155:8453',
	price: '$0.05',
	mimeType: 'application/json',
	maxTimeoutSeconds: 120
});

// Coinbase Developer Platform hosted facilitator. Selected automatically
// when both CDP API credentials are supplied. Lands the service in
// Coinbase's x402 Bazaar and gives a free settlement tier. `exact` on
// eip155:8453 (Base) is supported.
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

/**
 * Validate operator-supplied x402 options and return the normalised,
 * frozen config the rest of the kit consumes. Fails fast at boot — the
 * worst outcome is a paywall that accepts payments but never delivers.
 *
 * @param {object} opts
 * @param {string} opts.recipient            0x EVM address that receives funds (required when enabled)
 * @param {Array}  opts.routes               [{ method, path, price?, description?, mimeType? }]
 * @param {string} [opts.network]            CAIP-2 id, default 'eip155:8453' (Base)
 * @param {string} [opts.facilitatorUrl]     permissionless facilitator URL (used when no CDP creds)
 * @param {string} [opts.cdpApiKeyId]        Coinbase CDP key id  — both id+secret ⇒ CDP facilitator
 * @param {string} [opts.cdpApiKeySecret]    Coinbase CDP key secret
 * @param {number} [opts.maxTimeoutSeconds]  per-route settlement window, default 120
 * @param {string} [opts.defaultPrice]       fallback price for routes with no `price`, default '$0.05'
 * @param {string} [opts.defaultMimeType]    fallback mime, default 'application/json'
 * @param {boolean}[opts.enabled]            explicit off-switch, default true
 * @returns {Readonly<object>} `{ enabled:false, reason }` or the full frozen config
 */
export function buildX402Config({
	recipient,
	routes,
	network = DEFAULTS.network,
	facilitatorUrl = '',
	cdpApiKeyId = '',
	cdpApiKeySecret = '',
	maxTimeoutSeconds = DEFAULTS.maxTimeoutSeconds,
	defaultPrice = DEFAULTS.price,
	defaultMimeType = DEFAULTS.mimeType,
	enabled = true
} = {}) {
	const payTo = String(recipient ?? '').trim();
	if (!enabled || !payTo) {
		return Object.freeze({
			enabled: false,
			reason: payTo ? 'paywall explicitly disabled' : 'recipient address not set'
		});
	}
	if (!ADDRESS_RE.test(payTo)) {
		throw new TypeError(`x402: recipient=${payTo} is not a 0x-prefixed 20-byte hex address`);
	}
	const net = String(network ?? '').trim();
	if (!NETWORK_RE.test(net)) {
		throw new TypeError(`x402: network=${net} must be a CAIP-2 identifier such as 'eip155:8453'`);
	}
	if (!Array.isArray(routes) || routes.length === 0) {
		throw new TypeError('x402: routes must be a non-empty array of { method, path, price?, description?, mimeType? }');
	}
	// Facilitator selection. Presence of *both* CDP credentials is the
	// single, unambiguous "settle through Coinbase" signal: it pins the
	// CDP facilitator URL + auth mode. With no (or partial) creds we use
	// the configured permissionless URL. Keeping the rule this simple
	// avoids the "explicit URL silently wins over my new keys" footgun.
	const cdpConfigured = Boolean(String(cdpApiKeyId ?? '').trim() && String(cdpApiKeySecret ?? '').trim());
	const facilitatorMode = cdpConfigured ? 'cdp' : 'url';
	const resolvedFacilitatorUrl = cdpConfigured
		? CDP_FACILITATOR_URL
		: String(facilitatorUrl ?? '').trim();
	if (!HTTP_URL_RE.test(resolvedFacilitatorUrl)) {
		throw new TypeError(`x402: facilitator URL "${resolvedFacilitatorUrl}" must be an http(s) URL`);
	}
	// Build the per-route table the @x402/fastify middleware wants.
	// Pattern is `"<METHOD> <path>"` per the package docs (exact match,
	// no wildcards).
	const routeTable = {};
	const normalised = [];
	for (const r of routes) {
		const method = String(r?.method ?? '').trim().toUpperCase();
		const path = String(r?.path ?? '').trim();
		if (!method || !path) {
			throw new TypeError(`x402: each route needs a method + path (got ${JSON.stringify(r)})`);
		}
		const price = String(r?.price ?? defaultPrice).trim();
		assertPrice(price, `${method} ${path}`);
		const mimeType = r?.mimeType ?? defaultMimeType;
		const description = r?.description ?? '';
		// Optional per-route Bazaar discovery enrichment: JSON-schema
		// fragments (`inputSchema`, `output.schema`, `output.example`,
		// `pathParamsSchema`…) matching @x402/extensions' Declare*Config
		// shapes. Indexers grade listings on these — x402scan flags a
		// missing output schema as an error — so catalogue authors should
		// supply them for any route they want ranked well. Deep validation
		// is left to declareDiscoveryExtension at registration time.
		const discovery = (r?.discovery && typeof r.discovery === 'object') ? r.discovery : null;
		routeTable[`${method} ${path}`] = {
			accepts: { scheme: 'exact', network: net, price, payTo, maxTimeoutSeconds },
			description,
			mimeType,
			...(discovery ? { discovery } : {})
		};
		normalised.push(Object.freeze({ method, path, price, description, mimeType, ...(discovery ? { discovery } : {}) }));
	}
	return Object.freeze({
		enabled: true,
		recipient: payTo,
		network: net,
		facilitatorUrl: resolvedFacilitatorUrl,
		// 'cdp' → authenticate verify/settle with the operator's CDP key;
		// 'url' → plain permissionless facilitator. The secret is never
		// stored here (it would leak via describePaywall); pass it to
		// registerX402/createFacilitatorClient at dispatch time.
		facilitatorMode,
		routes: routeTable,
		premiumRoutes: Object.freeze(normalised)
	});
}

/**
 * Build the facilitator client the paywall dispatches verify/settle to.
 * Shared by `registerX402` and any custom/dynamic route, so the
 * CDP-vs-URL decision lives in exactly one place.
 *
 * `facilitatorMode === 'cdp'` authenticates each call with the operator's
 * CDP API key via @coinbase/x402's `createFacilitatorConfig` (a peer dep,
 * only needed in CDP mode). Otherwise returns a plain unauthenticated
 * client against `x402Cfg.facilitatorUrl`. The missing-creds guard runs
 * *before* any dynamic import, so the failure is cheap and testable
 * without loading the payment stack.
 */
export async function createFacilitatorClient(x402Cfg, { cdpApiKeyId = '', cdpApiKeySecret = '' } = {}) {
	if (x402Cfg?.facilitatorMode === 'cdp') {
		const id = String(cdpApiKeyId ?? '').trim();
		const secret = String(cdpApiKeySecret ?? '').trim();
		if (!id || !secret) {
			throw new Error('x402: facilitatorMode=cdp but CDP API credentials are missing — pass { cdpApiKeyId, cdpApiKeySecret } (install the @coinbase/x402 peer dependency)');
		}
		const [{ HTTPFacilitatorClient }, { createFacilitatorConfig }] = await Promise.all([
			import('@x402/core/server'),
			import('@coinbase/x402')
		]);
		return new HTTPFacilitatorClient(createFacilitatorConfig(id, secret));
	}
	const { HTTPFacilitatorClient } = await import('@x402/core/server');
	return new HTTPFacilitatorClient({ url: x402Cfg.facilitatorUrl });
}

/**
 * Map a route key ("METHOD /path") to the Bazaar-discovery config handed
 * to `declareDiscoveryExtension`. Body methods need an explicit
 * `bodyType`; query methods need nothing. A route's own `discovery`
 * object (inputSchema / output / pathParamsSchema…) is merged over the
 * defaults so catalogue authors can enrich listings without the kit
 * hard-coding their schemas. Pure + exported so the wiring is
 * unit-testable without loading the payment stack.
 */
export function discoveryConfigForRouteKey(routeKey, discovery = null) {
	const method = String(routeKey).trim().split(/\s+/u, 1)[0].toUpperCase();
	const base = BODY_METHODS.has(method) ? { bodyType: 'json' } : {};
	return discovery ? { ...base, ...discovery } : base;
}

/**
 * Cheap sanity check on a price string. Accepts either Money strings
 * ("$0.05") or atomic-unit integer strings ("50000" = 0.05 USDC at 6
 * decimals) — the facilitator handles both. Guards against shipping a
 * price that's secretly NaN.
 */
export function assertPrice(price, name) {
	if (typeof price !== 'string' || price.length === 0) {
		throw new TypeError(`x402: ${name} is not a non-empty string (got ${price})`);
	}
	const money = /^\$\d+(\.\d+)?$/u.test(price);
	const atomic = /^\d+$/u.test(price);
	if (!money && !atomic) {
		throw new TypeError(`x402: ${name}=${price} must be "$<dollars>" or a positive atomic-unit integer`);
	}
}

/**
 * Install the paywall on an existing Fastify app. Isolates the dynamic
 * `await import(...)` so config-layer use/tests don't load the wagmi/viem
 * stack. Returns the route table that was registered (with discovery
 * extensions attached) for inspection/logging.
 *
 * CDP credentials (only needed in CDP mode) are passed here at dispatch
 * time, never stored on `x402Cfg`.
 */
export async function registerX402(app, x402Cfg, { cdpApiKeyId = '', cdpApiKeySecret = '' } = {}) {
	if (!x402Cfg?.enabled) {
		throw new Error(`registerX402: paywall disabled (${x402Cfg?.reason ?? 'unknown'})`);
	}
	const [{ paymentMiddlewareFromConfig }, { ExactEvmScheme }, { declareDiscoveryExtension }] = await Promise.all([
		import('@x402/fastify'),
		import('@x402/evm/exact/server'),
		import('@x402/extensions/bazaar')
	]);
	const facilitatorClient = await createFacilitatorClient(x402Cfg, { cdpApiKeyId, cdpApiKeySecret });
	const schemes = [{ network: x402Cfg.network, server: new ExactEvmScheme() }];
	// Decorate each route with a Bazaar discovery extension. Additive
	// metadata only — @x402/fastify enriches the HTTP method at request
	// time and the facilitator soft-drops anything malformed, so this
	// can't break verification/settlement.
	const routesWithDiscovery = {};
	for (const [key, routeCfg] of Object.entries(x402Cfg.routes)) {
		// `discovery` is kit-internal metadata, not part of the
		// @x402/fastify route config — strip it after folding it into
		// the declared extension.
		const { discovery, ...middlewareCfg } = routeCfg;
		routesWithDiscovery[key] = {
			...middlewareCfg,
			extensions: {
				...(routeCfg.extensions ?? {}),
				...declareDiscoveryExtension(discoveryConfigForRouteKey(key, discovery))
			}
		};
	}
	// `syncFacilitatorOnStart: true` fetches the /supported manifest so
	// the resource server knows which (scheme, network) tuples it can
	// issue PaymentRequirements for. Without it the middleware throws on
	// the first 402-eligible request: "Facilitator does not support exact".
	paymentMiddlewareFromConfig(
		app,
		routesWithDiscovery,
		facilitatorClient,
		schemes,
		/* paywallConfig */ undefined,
		/* paywall */ undefined,
		/* syncFacilitatorOnStart */ true
	);
	return routesWithDiscovery;
}

/**
 * Public-facing description of the paywall, suitable for a `/` index or
 * an agent/MCP surface so callers can introspect cost + payment rails
 * without first making a 402-receiving request. Returns `null` when the
 * paywall is off so callers can hide the section.
 */
export function describePaywall(x402Cfg) {
	if (!x402Cfg?.enabled) return null;
	const routes = Object.entries(x402Cfg.routes).map(([key, value]) => ({
		endpoint: key,
		price: value.accepts.price,
		description: value.description,
		mime_type: value.mimeType
	}));
	return {
		protocol: 'x402',
		spec: 'https://docs.x402.org',
		network: x402Cfg.network,
		facilitator: x402Cfg.facilitatorUrl,
		// 'cdp' = Coinbase hosted facilitator (also catalogues in Bazaar);
		// 'url' = permissionless.
		facilitator_mode: x402Cfg.facilitatorMode ?? 'url',
		payTo: x402Cfg.recipient,
		scheme: 'exact (EIP-3009 transferWithAuthorization)',
		asset_note: 'Network resolves the canonical USDC contract; clients should consult the facilitator /supported endpoint for the address.',
		routes
	};
}
