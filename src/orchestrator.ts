import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { backendAgentConfig } from "./agents/backend.ts";
import { frontendAgentConfig } from "./agents/frontend.ts";
import { pmAgentConfig } from "./agents/pm.ts";
import { qaAgentConfig } from "./agents/qa.ts";
import { refactorAgentConfig } from "./agents/refactor.ts";
import { runAgent } from "./agents/runner.ts";
import { getTicket } from "./tools/github.ts";
import type {
	AgentConfig,
	AgentInput,
	AgentOutput,
	RepoContext,
	Ticket,
	WebhookContext,
	WebhookEventType,
} from "./types.ts";

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
	private anthropic: Anthropic;
	private octokit: Octokit;
	private repo: RepoContext;

	constructor(anthropicKey: string, githubToken: string, repo: RepoContext) {
		this.anthropic = new Anthropic({ apiKey: anthropicKey });
		this.octokit = new Octokit({ auth: githubToken });
		this.repo = repo;
	}

	async handleWebhook(context: WebhookContext): Promise<AgentOutput | null> {
		console.log(`[orchestrator] Received event: ${context.event}`);

		const route = this.routeEvent(context);

		if (!route) {
			console.log(
				`[orchestrator] No handler for event: ${context.event} — skipping`,
			);
			return null;
		}

		console.log(`[orchestrator] Routing to agent: ${route.config.role}`);

		const input = await this.buildAgentInput(context, route);
		return runAgent(
			this.anthropic,
			this.octokit,
			route.config,
			input,
			this.repo,
		);
	}

	// ─── Event router ───────────────────────────────────────────────────────────
	// Maps incoming webhook events to the right agent config.
	//
	// Before: one giant if/else chain you'd add to forever
	// After:  one routing table — add a new agent by adding a row

	private routeEvent(
		context: WebhookContext,
	): { config: AgentConfig; needsTicket: boolean } | null {
		const payload = context.payload as Record<string, unknown>;

		switch (context.event) {
			// New issue opened → PM triages it
			case "issues.opened":
				return { config: pmAgentConfig, needsTicket: true };

			// Issue labeled → if it's "in-progress", route to the right dev agent
			case "issues.labeled": {
				const label = (payload.label as { name?: string })?.name;
				if (label === "in-progress") {
					const agentConfig = this.resolveDevAgent(context);
					return agentConfig
						? { config: agentConfig, needsTicket: true }
						: null;
				}
				return null;
			}

			// PR opened → QA reviews it
			case "pull_request.opened":
				return { config: qaAgentConfig, needsTicket: false };

			// PR merged → Refactor agent looks for cleanup opportunities
			case "pull_request.merged":
				return { config: refactorAgentConfig, needsTicket: false };

			// Project item created/moved → PM re-triages if needed
			case "project_v2_item.created":
				return { config: pmAgentConfig, needsTicket: false };

			default:
				return null;
		}
	}

	// ─── Dev agent resolver ─────────────────────────────────────────────────────
	// Looks at ticket labels to decide backend vs frontend.

	private resolveDevAgent(context: WebhookContext): AgentConfig | null {
		const payload = context.payload as Record<string, unknown>;
		const issue = payload.issue as Record<string, unknown> | undefined;
		const labels =
			(issue?.labels as Array<{ name?: string }>)?.map((l) => l.name ?? "") ??
			[];

		if (labels.includes("backend")) return backendAgentConfig;
		if (labels.includes("frontend")) return frontendAgentConfig;

		// Both? Run backend first (frontend typically depends on API)
		// In the future this could fan out to both in parallel
		if (labels.includes("backend") && labels.includes("frontend"))
			return backendAgentConfig;

		console.log(
			"[orchestrator] in-progress ticket has no backend/frontend label — skipping dev dispatch",
		);
		return null;
	}

	// ─── Input builder ──────────────────────────────────────────────────────────
	// Enriches the webhook context with ticket data before passing to the agent.

	private async buildAgentInput(
		context: WebhookContext,
		route: { config: AgentConfig; needsTicket: boolean },
	): Promise<AgentInput> {
		const payload = context.payload as Record<string, unknown>;
		let ticket: Ticket | undefined;
		let additionalContext = "";

		// Hydrate ticket from issue payload if present
		if (route.needsTicket) {
			const issue = payload.issue as Record<string, unknown> | undefined;
			if (issue?.number) {
				try {
					ticket = await getTicket(
						this.octokit,
						this.repo,
						issue.number as number,
					);
				} catch (err) {
					console.warn("[orchestrator] Failed to hydrate ticket:", err);
				}
			}
		}

		// For PR events, add some extra context
		if (
			context.event === "pull_request.opened" ||
			context.event === "pull_request.merged"
		) {
			const pr = payload.pull_request as Record<string, unknown> | undefined;
			additionalContext = [
				`PR #${pr?.number}: ${pr?.title}`,
				`Branch: ${(pr?.head as Record<string, unknown>)?.ref} → ${(pr?.base as Record<string, unknown>)?.ref}`,
				`Author: ${(pr?.user as Record<string, unknown>)?.login}`,
				`\n${pr?.body ?? "No PR description provided."}`,
			].join("\n");
		}

		return {
			role: route.config.role,
			context,
			ticket,
			additionalContext: additionalContext || undefined,
		};
	}
}

// ─── Webhook event normalizer ─────────────────────────────────────────────────
// GitHub sends event type in headers + action in payload body.
// This merges them into our WebhookEventType union.

export function normalizeGitHubEvent(
	eventHeader: string,
	payload: Record<string, unknown>,
): WebhookEventType | null {
	const action = payload.action as string | undefined;
	const key = action ? `${eventHeader}.${action}` : eventHeader;

	// Handle PR merged (GitHub sends action: "closed" with merged: true)
	if (
		eventHeader === "pull_request" &&
		action === "closed" &&
		(payload.pull_request as Record<string, unknown>)?.merged === true
	) {
		return "pull_request.merged";
	}

	const validEvents: WebhookEventType[] = [
		"issues.opened",
		"issues.labeled",
		"issues.closed",
		"pull_request.opened",
		"pull_request.merged",
		"pull_request.closed",
		"project_v2_item.created",
		"project_v2_item.edited",
	];

	return validEvents.includes(key as WebhookEventType)
		? (key as WebhookEventType)
		: null;
}
