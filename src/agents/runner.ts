import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Octokit } from "@octokit/rest";
import { createAgentMcpServer } from "../tools/mcp-server.ts";
import type {
	AgentConfig,
	AgentInput,
	AgentOutput,
	RepoContext,
} from "../types.ts";

// ─── Core agent runner ────────────────────────────────────────────────────────
// Replaces the manual multi-turn Claude API loop with the Agent SDK's query().
// The SDK handles the tool-calling loop internally; our custom GitHub/Git/CI
// tools are exposed as an in-process MCP server so the agent can call them.

export async function runAgent(
	octokit: Octokit,
	config: AgentConfig,
	input: AgentInput,
	repo: RepoContext,
): Promise<AgentOutput> {
	const prompt = buildUserMessage(input);
	const mcpServer = createAgentMcpServer(octokit, repo, config.role);

	console.log(`[${config.role}] Starting agent loop`);

	for await (const message of query({
		prompt,
		options: {
			systemPrompt: config.systemPrompt,
			maxTurns: config.maxTurns ?? 30,
			model: config.model,
			mcpServers: { tools: mcpServer },
			settingSources: ["user"],
		},
	})) {
		if ("result" in message) {
			const summary =
				typeof message.result === "string"
					? message.result
					: JSON.stringify(message.result);
			const success = message.stop_reason === "end_turn";

			console.log(
				`[${config.role}] Done: stop_reason=${message.stop_reason}`,
			);

			return {
				role: config.role,
				success,
				summary: summary || "Agent completed with no summary.",
				actionsPerformed: [],
				error: success ? undefined : `Stopped: ${message.stop_reason}`,
			};
		}
	}

	// Stream ended without a result message
	return {
		role: config.role,
		success: false,
		summary: "Agent stream ended without a result.",
		actionsPerformed: [],
		error: "No result message received from query()",
	};
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildUserMessage(input: AgentInput): string {
	const parts: string[] = [
		`## Webhook Event: ${input.context.event}`,
		`Repository: ${input.context.repo.owner}/${input.context.repo.repo}`,
	];

	if (input.ticket) {
		parts.push(
			`\n## Ticket #${input.ticket.number}: ${input.ticket.title}`,
			`**Status:** ${input.ticket.status}`,
			`**Labels:** ${input.ticket.labels.join(", ")}`,
			`**Priority:** ${input.ticket.priority}`,
			`\n${input.ticket.body}`,
		);
	}

	if (input.additionalContext) {
		parts.push(`\n## Additional Context\n${input.additionalContext}`);
	}

	parts.push(
		"\n## Payload",
		"```json",
		JSON.stringify(input.context.payload, null, 2).slice(0, 3000), // truncate massive payloads
		"```",
	);

	return parts.join("\n");
}
