// Gate routes behind an x402 paywall with Fastify.
//
// Prerequisites:
//   npm i fastify                 # peer dependency (your app)
//   npm i @coinbase/x402          # only if you use CDP facilitator mode
//
// Run (permissionless facilitator):
//   X402_RECIPIENT=0xYourAddress \
//   X402_FACILITATOR_URL=https://facilitator.openx402.ai \
//   node examples/fastify-server.mjs
//
// Run (Coinbase CDP facilitator — auto-selected when BOTH creds are set):
//   X402_RECIPIENT=0xYourAddress \
//   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... \
//   node examples/fastify-server.mjs

import Fastify from 'fastify';
import { buildX402Config, registerX402, describePaywall } from '../src/index.js';

// You own your config + secrets — the kit reads no env on its own.
const x402 = buildX402Config({
	recipient: process.env.X402_RECIPIENT,
	facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://facilitator.openx402.ai',
	cdpApiKeyId: process.env.CDP_API_KEY_ID,
	cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
	routes: [
		{ method: 'GET', path: '/v1/premium/quote', price: '$0.01', description: 'A premium quote.' },
		{ method: 'POST', path: '/v1/premium/job', price: '$0.10', description: 'Submit a premium job.' }
	]
});

const app = Fastify({ logger: true });

// Install the paywall BEFORE the routes it should protect, so the
// payment hook is in place when those routes run. Only routes present in
// the config are gated; everything else stays free.
if (x402.enabled) {
	await registerX402(app, x402, {
		cdpApiKeyId: process.env.CDP_API_KEY_ID,
		cdpApiKeySecret: process.env.CDP_API_KEY_SECRET
	});
	app.log.info(`x402 paywall ON (${x402.facilitatorMode}) → ${x402.facilitatorUrl}`);
}
else {
	app.log.warn(`x402 paywall OFF: ${x402.reason} — set X402_RECIPIENT to enable`);
}

// Free introspection endpoint: agents can read price + rails up front.
app.get('/', async () => ({ service: 'demo', paywall: describePaywall(x402) }));

// Premium handlers — only reached after a payment settles.
app.get('/v1/premium/quote', async () => ({ quote: 42 }));
app.post('/v1/premium/job', async () => ({ accepted: true }));

await app.listen({ port: Number(process.env.PORT || 8080), host: '127.0.0.1' });
