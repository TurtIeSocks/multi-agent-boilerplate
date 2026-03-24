// ─── Agent identities ────────────────────────────────────────────────────────

export type AgentRole = "pm" | "backend" | "frontend" | "qa" | "refactor";

export interface AgentConfig {
	role: AgentRole;
	model: string;
	systemPrompt: string;
	maxTokens: number;   // kept for documentation; no longer passed to the SDK
	maxTurns?: number;   // controls query() maxTurns; defaults to 30 in runner
}

// ─── GitHub Project types ─────────────────────────────────────────────────────

export type TicketStatus =
	| "Backlog"
	| "In Progress"
	| "In Review"
	| "Done"
	| "Blocked";

export type TicketLabel =
	| "backend"
	| "frontend"
	| "qa"
	| "refactor"
	| "regression"
	| "epic"
	| "bug"
	| "chore";

export type TicketPriority = "critical" | "high" | "medium" | "low";

export interface Ticket {
	id: string; // GitHub issue node ID
	number: number; // GitHub issue number
	title: string;
	body: string;
	status: TicketStatus;
	labels: TicketLabel[];
	priority: TicketPriority;
	assignee?: string;
	projectItemId?: string; // GitHub ProjectV2 item ID
	linkedPR?: number;
	createdAt: string;
	updatedAt: string;
}

export interface Sprint {
	id: string;
	title: string;
	goal: string;
	startDate: string;
	endDate: string;
	tickets: Ticket[];
	status: "planning" | "active" | "complete";
}

// ─── Webhook event payloads ───────────────────────────────────────────────────

export type WebhookEventType =
	| "issues.opened"
	| "issues.labeled"
	| "issues.closed"
	| "pull_request.opened"
	| "pull_request.merged"
	| "pull_request.closed"
	| "project_v2_item.created"
	| "project_v2_item.edited";

export interface WebhookContext {
	event: WebhookEventType;
	payload: Record<string, unknown>;
	repo: RepoContext;
}

export interface RepoContext {
	owner: string;
	repo: string;
	defaultBranch: string;
}

// ─── Agent I/O ────────────────────────────────────────────────────────────────

export interface AgentInput {
	role: AgentRole;
	context: WebhookContext;
	ticket?: Ticket;
	additionalContext?: string;
}

export interface AgentOutput {
	role: AgentRole;
	success: boolean;
	summary: string;
	actionsPerformed: AgentAction[];
	error?: string;
}

export interface AgentAction {
	type:
		| "created_ticket"
		| "updated_ticket"
		| "closed_ticket"
		| "opened_pr"
		| "commented"
		| "committed_code"
		| "created_sprint"
		| "labeled_ticket";
	description: string;
	metadata?: Record<string, unknown>;
}

// ─── Tool definitions (passed to Claude) ─────────────────────────────────────

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: {
		type: "object";
		properties: Record<string, unknown>;
		required: string[];
	};
}

export interface ToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolResult {
	tool_use_id: string;
	content: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AppConfig {
	github: {
		token: string;
		owner: string;
		repo: string;
		projectNumber: number;
		webhookSecret: string;
	};
	anthropic: {
		apiKey: string;
	};
	server: {
		port: number;
		webhookPath: string;
	};
}
