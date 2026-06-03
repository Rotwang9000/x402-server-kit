// Unit tests for src/paywall.js. These cover the config validation, the
// describePaywall projection, and the Bazaar discovery wiring — all pure,
// no network. The dynamic @x402/fastify install (registerX402) is left
// for an integration test in the consuming app.

import { describe, test, expect } from '@jest/globals';
import {
	buildX402Config,
	describePaywall,
	discoveryConfigForRouteKey,
	createFacilitatorClient,
	CDP_FACILITATOR_URL
} from '../src/index.js';
import { declareDiscoveryExtension, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { checkIfBazaarNeeded } from '@x402/core/server';

const PAY_TO = '0x1234567890abcdef1234567890abcdef12345678';

// A vendor-neutral sample catalogue: one body route + one query route.
const SAMPLE_ROUTES = Object.freeze([
	{ method: 'POST', path: '/v1/things', description: 'Create a thing and return its id — a description long enough to be useful on a discovery surface.', mimeType: 'application/json' },
	{ method: 'GET', path: '/v1/facts/height', description: 'Single fact: the current height.' }
]);

function baseOpts(overrides = {}) {
	return {
		recipient: PAY_TO,
		network: 'eip155:8453',
		facilitatorUrl: 'https://x402.org/facilitator',
		routes: SAMPLE_ROUTES,
		defaultPrice: '$0.05',
		maxTimeoutSeconds: 120,
		...overrides
	};
}

describe('buildX402Config', () => {
	test('returns disabled when recipient is unset', () => {
		const cfg = buildX402Config(baseOpts({ recipient: '' }));
		expect(cfg.enabled).toBe(false);
		expect(cfg.reason).toMatch(/recipient/i);
	});

	test('returns disabled when explicitly disabled', () => {
		const cfg = buildX402Config(baseOpts({ enabled: false }));
		expect(cfg.enabled).toBe(false);
	});

	test('throws on malformed recipient', () => {
		expect(() => buildX402Config(baseOpts({ recipient: 'not-an-address' })))
			.toThrow(/0x-prefixed 20-byte hex/);
	});

	test('throws on malformed network', () => {
		expect(() => buildX402Config(baseOpts({ network: 'mainnet' })))
			.toThrow(/CAIP-2/);
	});

	test('throws on missing facilitator URL', () => {
		expect(() => buildX402Config(baseOpts({ facilitatorUrl: '' })))
			.toThrow(/http\(s\)/);
	});

	test('throws on non-http facilitator URL', () => {
		expect(() => buildX402Config(baseOpts({ facilitatorUrl: 'ipfs://something' })))
			.toThrow(/http\(s\)/);
	});

	test('throws on empty routes', () => {
		expect(() => buildX402Config(baseOpts({ routes: [] })))
			.toThrow(/non-empty array/);
	});

	test('builds a routes map for every supplied route, preserving order', () => {
		const cfg = buildX402Config(baseOpts());
		expect(cfg.enabled).toBe(true);
		expect(cfg.recipient).toBe(PAY_TO);
		expect(cfg.network).toBe('eip155:8453');
		expect(cfg.facilitatorUrl).toBe('https://x402.org/facilitator');
		const routeKeys = Object.keys(cfg.routes);
		expect(routeKeys.length).toBe(SAMPLE_ROUTES.length);
		expect(routeKeys[0]).toBe('POST /v1/things');
		const r = cfg.routes['POST /v1/things'];
		expect(r.accepts.scheme).toBe('exact');
		expect(r.accepts.payTo).toBe(PAY_TO);
		expect(r.accepts.network).toBe('eip155:8453');
		expect(r.accepts.price).toBe('$0.05');
		expect(r.accepts.maxTimeoutSeconds).toBe(120);
		expect(r.mimeType).toBe('application/json');
		expect(typeof r.description).toBe('string');
		expect(r.description.length).toBeGreaterThan(20);
	});

	test('rejects non-money, non-atomic price strings', () => {
		expect(() => buildX402Config(baseOpts({ defaultPrice: 'free' })))
			.toThrow(/=free must be.*atomic-unit integer/);
	});

	test('accepts atomic-unit price strings', () => {
		const cfg = buildX402Config(baseOpts({ defaultPrice: '50000' }));
		expect(cfg.routes['GET /v1/facts/height'].accepts.price).toBe('50000');
	});

	test('per-route price overrides the default', () => {
		const cfg = buildX402Config(baseOpts({
			routes: [{ method: 'GET', path: '/v1/facts/height', price: '$0.25', description: 'priced fact' }]
		}));
		expect(cfg.routes['GET /v1/facts/height'].accepts.price).toBe('$0.25');
	});

	test('defaults to url facilitator mode with no CDP creds', () => {
		const cfg = buildX402Config(baseOpts());
		expect(cfg.facilitatorMode).toBe('url');
		expect(cfg.facilitatorUrl).toBe('https://x402.org/facilitator');
	});

	test('switches to CDP facilitator mode when both CDP creds are present', () => {
		const cfg = buildX402Config(baseOpts({ cdpApiKeyId: 'key-id', cdpApiKeySecret: 'key-secret' }));
		expect(cfg.facilitatorMode).toBe('cdp');
		// CDP mode pins the Coinbase facilitator URL, ignoring the default.
		expect(cfg.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
	});

	test('stays in url mode when only one CDP cred is present (partial config is not CDP)', () => {
		const idOnly = buildX402Config(baseOpts({ cdpApiKeyId: 'key-id' }));
		expect(idOnly.facilitatorMode).toBe('url');
		expect(idOnly.facilitatorUrl).toBe('https://x402.org/facilitator');
		const secretOnly = buildX402Config(baseOpts({ cdpApiKeySecret: 'key-secret' }));
		expect(secretOnly.facilitatorMode).toBe('url');
	});

	test('does not store CDP secret on the returned config', () => {
		const cfg = buildX402Config(baseOpts({ cdpApiKeyId: 'key-id', cdpApiKeySecret: 'key-secret' }));
		expect(JSON.stringify(cfg)).not.toMatch(/key-secret/);
	});
});

describe('createFacilitatorClient', () => {
	test('rejects in cdp mode when credentials are missing (before loading the x402 stack)', async () => {
		await expect(createFacilitatorClient(
			{ enabled: true, facilitatorMode: 'cdp', facilitatorUrl: CDP_FACILITATOR_URL },
			{ cdpApiKeyId: '', cdpApiKeySecret: '' }
		)).rejects.toThrow(/CDP API credentials are missing/);
	});
});

describe('describePaywall', () => {
	test('returns null when disabled', () => {
		expect(describePaywall(buildX402Config(baseOpts({ recipient: '' })))).toBeNull();
	});

	test('exposes per-route price + endpoint for the agent surface', () => {
		const desc = describePaywall(buildX402Config(baseOpts()));
		expect(desc).not.toBeNull();
		expect(desc.protocol).toBe('x402');
		expect(desc.network).toBe('eip155:8453');
		expect(desc.payTo).toBe(PAY_TO);
		expect(desc.scheme).toMatch(/EIP-3009/);
		expect(desc.routes.length).toBe(SAMPLE_ROUTES.length);
		const route = desc.routes[0];
		expect(route.endpoint).toBe('POST /v1/things');
		expect(route.price).toBe('$0.05');
		expect(route.mime_type).toBe('application/json');
		expect(typeof route.description).toBe('string');
	});

	test('reports facilitator_mode for the discovery surface', () => {
		expect(describePaywall(buildX402Config(baseOpts())).facilitator_mode).toBe('url');
		const cdpDesc = describePaywall(buildX402Config(baseOpts({ cdpApiKeyId: 'a', cdpApiKeySecret: 'b' })));
		expect(cdpDesc.facilitator_mode).toBe('cdp');
		expect(cdpDesc.facilitator).toBe(CDP_FACILITATOR_URL);
	});
});

describe('discoveryConfigForRouteKey (Bazaar discovery wiring)', () => {
	test('query (GET/HEAD/DELETE) routes get an empty config', () => {
		expect(discoveryConfigForRouteKey('GET /v1/facts/height')).toEqual({});
		expect(discoveryConfigForRouteKey('GET /v1/things')).toEqual({});
	});

	test('body methods (POST/PUT/PATCH) declare bodyType json', () => {
		expect(discoveryConfigForRouteKey('POST /v1/things')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('PUT /x')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('PATCH /x')).toEqual({ bodyType: 'json' });
	});

	test('is tolerant of extra whitespace and case in the route key', () => {
		expect(discoveryConfigForRouteKey('post   /v1/things')).toEqual({ bodyType: 'json' });
		expect(discoveryConfigForRouteKey('  get /v1/facts/height ')).toEqual({});
	});

	test('every route key yields a Bazaar extension the middleware will catalogue', () => {
		const cfg = buildX402Config(baseOpts());
		const routesWithDiscovery = {};
		for (const [key, routeCfg] of Object.entries(cfg.routes)) {
			routesWithDiscovery[key] = {
				...routeCfg,
				extensions: { ...declareDiscoveryExtension(discoveryConfigForRouteKey(key)) }
			};
		}
		expect(checkIfBazaarNeeded(routesWithDiscovery)).toBe(true);
		for (const [key, routeCfg] of Object.entries(routesWithDiscovery)) {
			const bazaar = routeCfg.extensions.bazaar;
			expect(bazaar).toBeDefined();
			// Enrich the method the way the runtime server extension does,
			// then it must pass the facilitator's schema validation.
			bazaar.info.input.method = key.split(' ', 1)[0];
			expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
		}
	});
});
