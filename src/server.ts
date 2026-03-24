import { Hono } from "hono";
import { normalizeGitHubEvent, Orchestrator } from "./orchestrator.ts";
import type { AppConfig, RepoContext } from "./types.ts";

// ─── Config loader ────────────────────────────────────────────────────────────

function loadConfig(): AppConfig {
	const required = [
		"GITHUB_TOKEN",
		"GITHUB_OWNER",
		"GITHUB_REPO",
		"GITHUB_PROJECT_NUMBER",
		"GITHUB_WEBHOOK_SECRET",
		"ANTHROPIC_API_KEY",
	];

	for (const key of required) {
		if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
	}

	return {
		github: {
			token: process.env.GITHUB_TOKEN!,
			owner: process.env.GITHUB_OWNER!,
			repo: process.env.GITHUB_REPO!,
			projectNumber: parseInt(process.env.GITHUB_PROJECT_NUMBER!, 10),
			webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
		},
		anthropic: {
			apiKey: process.env.ANTHROPIC_API_KEY!,
		},
		server: {
			port: parseInt(process.env.PORT ?? "3000", 10),
			webhookPath: process.env.WEBHOOK_PATH ?? "/webhook",
		},
	};
}

// ─── GitHub signature verification ───────────────────────────────────────────
// Verifies HMAC-SHA256 signature from GitHub's X-Hub-Signature-256 header.
// If this fails, someone is sending fake webhooks to your server.

async function verifyGitHubSignature(
	body: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = `sha256=${Array.from(new Uint8Array(mac))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;

	// Constant-time comparison to prevent timing attacks
	if (expected.length !== signature.length) return false;
	let mismatch = 0;
	for (let i = 0; i < expected.length; i++) {
		mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	}
	return mismatch === 0;
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────

async function main() {
	const config = loadConfig();
	const app = new Hono();

	const repo: RepoContext = {
		owner: config.github.owner,
		repo: config.github.repo,
		defaultBranch: process.env.DEFAULT_BRANCH ?? "main",
	};

	const orchestrator = new Orchestrator(config.github.token, repo);

	// ── Health check ──────────────────────────────────────────────────────────
	app.get("/health", (c) =>
		c.json({ status: "ok", timestamp: new Date().toISOString() }),
	);

	// ── Webhook endpoint ──────────────────────────────────────────────────────
	app.post(config.server.webhookPath, async (c) => {
		const rawBody = await c.req.text();
		const signature = c.req.header("x-hub-signature-256") ?? "";
		const eventHeader = c.req.header("x-github-event") ?? "";
		const deliveryId = c.req.header("x-github-delivery") ?? "unknown";

		// 1. Verify signature
		const isValid = await verifyGitHubSignature(
			rawBody,
			signature,
			config.github.webhookSecret,
		);

		if (!isValid) {
			console.warn(`[webhook] Invalid signature for delivery ${deliveryId}`);
			return c.json({ error: "Invalid signature" }, 401);
		}

		// 2. Parse payload
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "Invalid JSON payload" }, 400);
		}

		// 3. Normalize event type
		const eventType = normalizeGitHubEvent(eventHeader, payload);
		if (!eventType) {
			console.log(
				`[webhook] Ignoring unhandled event: ${eventHeader}.${payload.action}`,
			);
			return c.json({ status: "ignored", event: eventHeader });
		}

		console.log(`[webhook] Processing delivery ${deliveryId}: ${eventType}`);

		// 4. Ack immediately — GitHub expects a fast 200, agent work is async
		//    We kick off the agent work in the background without awaiting it.
		const context = { event: eventType, payload, repo };
		orchestrator
			.handleWebhook(context)
			.then((result) => {
				if (result) {
					console.log(
						`[webhook] Agent ${result.role} completed: ${result.summary.slice(0, 120)}`,
					);
				}
			})
			.catch((err) => {
				console.error(`[webhook] Agent error for delivery ${deliveryId}:`, err);
			});

		return c.json({
			status: "accepted",
			event: eventType,
			delivery: deliveryId,
		});
	});

	// ── Start ─────────────────────────────────────────────────────────────────
	console.log(`[server] Starting on port ${config.server.port}`);
	console.log(`[server] Webhook endpoint: ${config.server.webhookPath}`);
	console.log(`[server] Repo: ${repo.owner}/${repo.repo}`);

	Bun.serve({
		port: config.server.port,
		fetch: app.fetch,
	});
}

main().catch((err) => {
	console.error("[server] Fatal startup error:", err);
	process.exit(1);
});
