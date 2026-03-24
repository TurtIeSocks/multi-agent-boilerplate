import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "@octokit/rest";
import { executeGitHubTool, GITHUB_TOOLS } from "../tools/github.ts";
import type {
	AgentAction,
	AgentConfig,
	AgentInput,
	AgentOutput,
	RepoContext,
	ToolResult,
} from "../types.ts";

const MAX_TOOL_ROUNDS = 20; // safety ceiling — prevent runaway loops

// ─── Core agentic loop ────────────────────────────────────────────────────────
// Each agent shares this loop. It drives Claude through tool calls until
// Claude stops calling tools (i.e. it's done with the task).
//
// Before: you'd have to call Claude once, parse the response, run tools,
//         stitch results back in, call again — manually.
// After:  call runAgent(), it handles the full multi-turn tool loop for you.

export async function runAgent(
	client: Anthropic,
	octokit: Octokit,
	config: AgentConfig,
	input: AgentInput,
	repo: RepoContext,
): Promise<AgentOutput> {
	const actionsPerformed: AgentAction[] = [];
	const messages: Anthropic.MessageParam[] = [];
	let rounds = 0;

	// Build the initial user message from the webhook context + ticket
	const userMessage = buildUserMessage(input);
	messages.push({ role: "user", content: userMessage });

	console.log(`[${config.role}] Starting agent loop`);

	while (rounds < MAX_TOOL_ROUNDS) {
		rounds++;

		const response = await client.messages.create({
			model: config.model,
			max_tokens: config.maxTokens,
			system: config.systemPrompt,
			tools: GITHUB_TOOLS.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.input_schema,
			})),
			messages,
		});

		console.log(
			`[${config.role}] Round ${rounds}: stop_reason=${response.stop_reason}`,
		);

		// Append Claude's response to conversation history
		messages.push({ role: "assistant", content: response.content });

		// If Claude is done (no more tool calls), extract summary and exit
		if (response.stop_reason === "end_turn") {
			const summary = extractTextSummary(response.content);
			return {
				role: config.role,
				success: true,
				summary,
				actionsPerformed,
			};
		}

		// If Claude wants to call tools, execute them all and feed results back
		if (response.stop_reason === "tool_use") {
			const toolCalls = response.content.filter(
				(block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
			);

			const toolResults: ToolResult[] = [];

			for (const toolCall of toolCalls) {
				console.log(
					`[${config.role}] Tool call: ${toolCall.name}`,
					toolCall.input,
				);

				const result = await executeGitHubTool(octokit, repo, {
					id: toolCall.id,
					name: toolCall.name,
					input: toolCall.input as Record<string, unknown>,
				});

				toolResults.push(result);

				// Record what actions were taken for the output summary
				actionsPerformed.push(
					inferAction(toolCall.name, toolCall.input as Record<string, unknown>),
				);
			}

			// Feed tool results back to Claude as a user turn
			messages.push({
				role: "user",
				content: toolResults.map((r) => ({
					type: "tool_result" as const,
					tool_use_id: r.tool_use_id,
					content: r.content,
				})),
			});

			continue;
		}

		// Unexpected stop reason
		break;
	}

	return {
		role: config.role,
		success: false,
		summary: `Agent hit max rounds (${MAX_TOOL_ROUNDS}) or unexpected stop`,
		actionsPerformed,
		error: "Max tool rounds exceeded",
	};
}

// ─── Message builders ─────────────────────────────────────────────────────────

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

function extractTextSummary(content: Anthropic.ContentBlock[]): string {
	return (
		content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim() || "Agent completed with no summary."
	);
}

function inferAction(
	toolName: string,
	input: Record<string, unknown>,
): AgentAction {
	const map: Record<string, AgentAction["type"]> = {
		create_ticket: "created_ticket",
		update_ticket: "updated_ticket",
		close_ticket: "closed_ticket",
		open_pull_request: "opened_pr",
		comment_on_ticket: "commented",
		add_label: "labeled_ticket",
		list_open_tickets: "updated_ticket",
	};

	return {
		type: map[toolName] ?? "commented",
		description: `Called ${toolName}`,
		metadata: input,
	};
}
