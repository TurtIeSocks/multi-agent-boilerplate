import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import type {
	RepoContext,
	Ticket,
	TicketLabel,
	TicketPriority,
	TicketStatus,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from "../types.ts";

// ─── Client factory ───────────────────────────────────────────────────────────

export function createGitHubClients(token: string) {
	const octokit = new Octokit({ auth: token });
	const gql = graphql.defaults({
		headers: { authorization: `token ${token}` },
	});
	return { octokit, gql };
}

// ─── Ticket helpers ───────────────────────────────────────────────────────────

export async function getTicket(
	octokit: Octokit,
	repo: RepoContext,
	issueNumber: number,
): Promise<Ticket> {
	const { data } = await octokit.issues.get({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
	});

	return {
		id: data.node_id,
		number: data.number,
		title: data.title,
		body: data.body ?? "",
		status: extractStatus(data.labels),
		labels: extractLabels(data.labels),
		priority: extractPriority(data.labels),
		assignee: data.assignee?.login,
		createdAt: data.created_at,
		updatedAt: data.updated_at,
	};
}

export async function createTicket(
	octokit: Octokit,
	repo: RepoContext,
	params: {
		title: string;
		body: string;
		labels: TicketLabel[];
		priority: TicketPriority;
	},
): Promise<Ticket> {
	const { data } = await octokit.issues.create({
		owner: repo.owner,
		repo: repo.repo,
		title: params.title,
		body: params.body,
		labels: [...params.labels, `priority:${params.priority}`],
	});

	return {
		id: data.node_id,
		number: data.number,
		title: data.title,
		body: data.body ?? "",
		status: "Backlog",
		labels: params.labels,
		priority: params.priority,
		createdAt: data.created_at,
		updatedAt: data.updated_at,
	};
}

export async function updateTicket(
	octokit: Octokit,
	repo: RepoContext,
	issueNumber: number,
	params: {
		title?: string;
		body?: string;
		labels?: TicketLabel[];
		state?: "open" | "closed";
	},
): Promise<void> {
	await octokit.issues.update({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		...(params.title && { title: params.title }),
		...(params.body && { body: params.body }),
		...(params.labels && { labels: params.labels }),
		...(params.state && { state: params.state }),
	});
}

export async function closeTicket(
	octokit: Octokit,
	repo: RepoContext,
	issueNumber: number,
	comment: string,
): Promise<void> {
	await octokit.issues.createComment({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		body: comment,
	});
	await octokit.issues.update({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		state: "closed",
		state_reason: "completed",
	});
}

export async function commentOnTicket(
	octokit: Octokit,
	repo: RepoContext,
	issueNumber: number,
	body: string,
): Promise<void> {
	await octokit.issues.createComment({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		body,
	});
}

export async function addLabelToTicket(
	octokit: Octokit,
	repo: RepoContext,
	issueNumber: number,
	labels: string[],
): Promise<void> {
	await octokit.issues.addLabels({
		owner: repo.owner,
		repo: repo.repo,
		issue_number: issueNumber,
		labels,
	});
}

export async function listOpenTickets(
	octokit: Octokit,
	repo: RepoContext,
	label?: string,
): Promise<Ticket[]> {
	const { data } = await octokit.issues.listForRepo({
		owner: repo.owner,
		repo: repo.repo,
		state: "open",
		...(label && { labels: label }),
		per_page: 50,
	});

	return data.map((issue) => ({
		id: issue.node_id,
		number: issue.number,
		title: issue.title,
		body: issue.body ?? "",
		status: extractStatus(issue.labels),
		labels: extractLabels(issue.labels),
		priority: extractPriority(issue.labels),
		assignee: issue.assignee?.login,
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
	}));
}

// ─── PR helpers ───────────────────────────────────────────────────────────────

export async function createPR(
	octokit: Octokit,
	repo: RepoContext,
	params: {
		title: string;
		body: string;
		head: string;
		base: string;
		linkedIssue?: number;
	},
): Promise<number> {
	const body = params.linkedIssue
		? `${params.body}\n\nCloses #${params.linkedIssue}`
		: params.body;

	const { data } = await octokit.pulls.create({
		owner: repo.owner,
		repo: repo.repo,
		title: params.title,
		body,
		head: params.head,
		base: params.base,
	});

	return data.number;
}

export async function getPRFiles(
	octokit: Octokit,
	repo: RepoContext,
	prNumber: number,
): Promise<string[]> {
	const { data } = await octokit.pulls.listFiles({
		owner: repo.owner,
		repo: repo.repo,
		pull_number: prNumber,
	});
	return data.map((f) => f.filename);
}

// ─── GitHub Project (V2) helpers via GraphQL ─────────────────────────────────

export async function moveTicketToColumn(
	gql: typeof graphql,
	projectId: string,
	itemId: string,
	fieldId: string,
	optionId: string,
): Promise<void> {
	await gql(
		`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
  `,
		{ projectId, itemId, fieldId, optionId },
	);
}

export async function addIssueToProject(
	gql: typeof graphql,
	projectId: string,
	issueNodeId: string,
): Promise<string> {
	const result = await gql<{ addProjectV2ItemById: { item: { id: string } } }>(
		`
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `,
		{ projectId, contentId: issueNodeId },
	);

	return result.addProjectV2ItemById.item.id;
}

export async function getProjectMetadata(
	gql: typeof graphql,
	owner: string,
	projectNumber: number,
): Promise<{
	projectId: string;
	statusFieldId: string;
	statusOptions: Record<string, string>;
}> {
	const result = await gql<{
		user: {
			projectV2: {
				id: string;
				fields: {
					nodes: Array<{
						__typename: string;
						id: string;
						name: string;
						options?: Array<{ id: string; name: string }>;
					}>;
				};
			};
		};
	}>(
		`
    query($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 20) {
            nodes {
              __typename
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
  `,
		{ owner, number: projectNumber },
	);

	const project = result.user.projectV2;
	const statusField = project.fields.nodes.find(
		(f) => f.__typename === "ProjectV2SingleSelectField" && f.name === "Status",
	);

	if (!statusField?.options)
		throw new Error("Status field not found in project");

	const statusOptions: Record<string, string> = {};
	for (const opt of statusField.options) {
		statusOptions[opt.name] = opt.id;
	}

	return {
		projectId: project.id,
		statusFieldId: statusField.id,
		statusOptions,
	};
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────
// These are the tools Claude agents can invoke during their agentic loop.

export const GITHUB_TOOLS: ToolDefinition[] = [
	{
		name: "create_ticket",
		description: "Create a new GitHub issue and add it to the project board",
		input_schema: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "Short, imperative ticket title",
				},
				body: {
					type: "string",
					description:
						"Full description in markdown. Include acceptance criteria.",
				},
				labels: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"backend",
							"frontend",
							"qa",
							"refactor",
							"regression",
							"bug",
							"chore",
						],
					},
					description: "Labels to apply",
				},
				priority: {
					type: "string",
					enum: ["critical", "high", "medium", "low"],
					description: "Ticket priority",
				},
			},
			required: ["title", "body", "labels", "priority"],
		},
	},
	{
		name: "update_ticket",
		description: "Update an existing GitHub issue's title, body, or labels",
		input_schema: {
			type: "object",
			properties: {
				issue_number: { type: "number", description: "GitHub issue number" },
				title: { type: "string" },
				body: { type: "string" },
				labels: { type: "array", items: { type: "string" } },
			},
			required: ["issue_number"],
		},
	},
	{
		name: "close_ticket",
		description: "Close a GitHub issue with a completion comment",
		input_schema: {
			type: "object",
			properties: {
				issue_number: { type: "number" },
				comment: { type: "string", description: "Summary of what was done" },
			},
			required: ["issue_number", "comment"],
		},
	},
	{
		name: "comment_on_ticket",
		description: "Add a comment to an existing GitHub issue",
		input_schema: {
			type: "object",
			properties: {
				issue_number: { type: "number" },
				body: { type: "string" },
			},
			required: ["issue_number", "body"],
		},
	},
	{
		name: "list_open_tickets",
		description: "List open issues, optionally filtered by label",
		input_schema: {
			type: "object",
			properties: {
				label: {
					type: "string",
					description: "Filter by this label (optional)",
				},
			},
			required: [],
		},
	},
	{
		name: "open_pull_request",
		description: "Open a pull request from a feature branch",
		input_schema: {
			type: "object",
			properties: {
				title: { type: "string" },
				body: { type: "string" },
				head: { type: "string", description: "Feature branch name" },
				base: { type: "string", description: "Target branch (usually main)" },
				linked_issue: {
					type: "number",
					description: "Issue number to auto-close on merge",
				},
			},
			required: ["title", "body", "head", "base"],
		},
	},
	{
		name: "add_label",
		description: "Add labels to an existing issue",
		input_schema: {
			type: "object",
			properties: {
				issue_number: { type: "number" },
				labels: { type: "array", items: { type: "string" } },
			},
			required: ["issue_number", "labels"],
		},
	},
];

// ─── Tool executor ────────────────────────────────────────────────────────────
// Receives a tool call from Claude and dispatches it to the right GitHub method.

export async function executeGitHubTool(
	octokit: Octokit,
	repo: RepoContext,
	toolCall: ToolCall,
): Promise<ToolResult> {
	const input = toolCall.input;

	try {
		switch (toolCall.name) {
			case "create_ticket": {
				const ticket = await createTicket(octokit, repo, {
					title: input.title as string,
					body: input.body as string,
					labels: input.labels as TicketLabel[],
					priority: input.priority as TicketPriority,
				});
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({
						success: true,
						issue_number: ticket.number,
						url: `https://github.com/${repo.owner}/${repo.repo}/issues/${ticket.number}`,
					}),
				};
			}

			case "update_ticket": {
				await updateTicket(octokit, repo, input.issue_number as number, {
					title: input.title as string | undefined,
					body: input.body as string | undefined,
					labels: input.labels as TicketLabel[] | undefined,
				});
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true }),
				};
			}

			case "close_ticket": {
				await closeTicket(
					octokit,
					repo,
					input.issue_number as number,
					input.comment as string,
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true }),
				};
			}

			case "comment_on_ticket": {
				await commentOnTicket(
					octokit,
					repo,
					input.issue_number as number,
					input.body as string,
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true }),
				};
			}

			case "list_open_tickets": {
				const tickets = await listOpenTickets(
					octokit,
					repo,
					input.label as string | undefined,
				);
				return { tool_use_id: toolCall.id, content: JSON.stringify(tickets) };
			}

			case "open_pull_request": {
				const prNumber = await createPR(octokit, repo, {
					title: input.title as string,
					body: input.body as string,
					head: input.head as string,
					base: input.base as string,
					linkedIssue: input.linked_issue as number | undefined,
				});
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({
						success: true,
						pr_number: prNumber,
						url: `https://github.com/${repo.owner}/${repo.repo}/pull/${prNumber}`,
					}),
				};
			}

			case "add_label": {
				await addLabelToTicket(
					octokit,
					repo,
					input.issue_number as number,
					input.labels as string[],
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true }),
				};
			}

			default:
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
				};
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			tool_use_id: toolCall.id,
			content: JSON.stringify({ error: message }),
		};
	}
}

// ─── Label extraction helpers ─────────────────────────────────────────────────

type RawLabel = string | { name?: string };

function extractLabels(raw: RawLabel[]): TicketLabel[] {
	const valid: TicketLabel[] = [
		"backend",
		"frontend",
		"qa",
		"refactor",
		"regression",
		"epic",
		"bug",
		"chore",
	];
	return raw
		.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
		.filter((name): name is TicketLabel => valid.includes(name as TicketLabel));
}

function extractStatus(raw: RawLabel[]): TicketStatus {
	const names = raw.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
	if (names.includes("in-progress")) return "In Progress";
	if (names.includes("in-review")) return "In Review";
	if (names.includes("blocked")) return "Blocked";
	if (names.includes("done")) return "Done";
	return "Backlog";
}

function extractPriority(raw: RawLabel[]): TicketPriority {
	const names = raw.map((l) => (typeof l === "string" ? l : (l.name ?? "")));
	if (names.includes("priority:critical")) return "critical";
	if (names.includes("priority:high")) return "high";
	if (names.includes("priority:low")) return "low";
	return "medium";
}
