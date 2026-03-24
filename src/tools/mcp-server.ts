import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import type { AgentRole, RepoContext, ToolCall } from "../types.ts";
import { executeCITool } from "./ci.ts";
import { executeGitTool } from "./git.ts";
import { executeGitHubTool } from "./github.ts";

// ─── MCP server factory ───────────────────────────────────────────────────────
// Creates an in-process MCP server scoped to a single agent invocation.
// Octokit and repo context are captured in closures so tool handlers can
// call the existing executor functions without any global state.

export function createAgentMcpServer(
	octokit: Octokit,
	repo: RepoContext,
	role: AgentRole,
) {
	// ── Helper: bridge Zod-validated args to the existing executor functions ──
	// The executors expect a ToolCall with { id, name, input }. We generate a
	// throwaway UUID for the id since the Agent SDK handles correlation itself.
	function call(name: string, args: Record<string, unknown>): ToolCall {
		return { id: globalThis.crypto.randomUUID(), name, input: args };
	}

	function mcpText(content: string) {
		return { content: [{ type: "text" as const, text: content }] };
	}

	// ── GitHub tools ──────────────────────────────────────────────────────────

	const createTicket = tool(
		"create_ticket",
		"Create a new GitHub issue and add it to the project board",
		{
			title: z.string().describe("Short, imperative ticket title"),
			body: z
				.string()
				.describe("Full description in markdown. Include acceptance criteria."),
			labels: z
				.array(
					z.enum([
						"backend",
						"frontend",
						"qa",
						"refactor",
						"regression",
						"bug",
						"chore",
					]),
				)
				.describe("Labels to apply"),
			priority: z
				.enum(["critical", "high", "medium", "low"])
				.describe("Ticket priority"),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("create_ticket", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const updateTicket = tool(
		"update_ticket",
		"Update an existing GitHub issue's title, body, or labels",
		{
			issue_number: z.number().describe("GitHub issue number"),
			title: z.string().optional(),
			body: z.string().optional(),
			labels: z.array(z.string()).optional(),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("update_ticket", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const closeTicket = tool(
		"close_ticket",
		"Close a GitHub issue with a completion comment",
		{
			issue_number: z.number(),
			comment: z.string().describe("Summary of what was done"),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("close_ticket", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const commentOnTicket = tool(
		"comment_on_ticket",
		"Add a comment to an existing GitHub issue",
		{
			issue_number: z.number(),
			body: z.string(),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("comment_on_ticket", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const listOpenTickets = tool(
		"list_open_tickets",
		"List open issues, optionally filtered by label",
		{
			label: z.string().describe("Filter by this label (optional)").optional(),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("list_open_tickets", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const openPullRequest = tool(
		"open_pull_request",
		"Open a pull request from a feature branch",
		{
			title: z.string(),
			body: z.string(),
			head: z.string().describe("Feature branch name"),
			base: z.string().describe("Target branch (usually main)"),
			linked_issue: z
				.number()
				.describe("Issue number to auto-close on merge")
				.optional(),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("open_pull_request", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const addLabel = tool(
		"add_label",
		"Add labels to an existing issue",
		{
			issue_number: z.number(),
			labels: z.array(z.string()),
		},
		async (args) => {
			const result = await executeGitHubTool(
				octokit,
				repo,
				call("add_label", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const githubTools = [
		createTicket,
		updateTicket,
		closeTicket,
		commentOnTicket,
		listOpenTickets,
		openPullRequest,
		addLabel,
	];

	// ── Git tools ─────────────────────────────────────────────────────────────

	const createBranch = tool(
		"create_branch",
		"Create a new git branch from the default branch (or a specified base ref)",
		{
			branch_name: z
				.string()
				.describe(
					"Branch name. Use format: feat/<short-description> or fix/<short-description>. Will be sanitized automatically.",
				),
			from_ref: z
				.string()
				.describe(
					"Base branch to fork from. Defaults to the repo's default branch.",
				)
				.optional(),
		},
		async (args) => {
			const result = await executeGitTool(
				octokit,
				repo,
				call("create_branch", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const readFile = tool(
		"read_file",
		"Read the contents of a file from the repository",
		{
			path: z
				.string()
				.describe("File path relative to repo root, e.g. src/main.rs"),
			branch: z
				.string()
				.describe("Branch to read from. Defaults to the default branch.")
				.optional(),
		},
		async (args) => {
			const result = await executeGitTool(
				octokit,
				repo,
				call("read_file", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const writeFile = tool(
		"write_file",
		"Write or update a single file on a branch. Creates the file if it doesn't exist.",
		{
			path: z
				.string()
				.describe("File path relative to repo root, e.g. src/handlers/auth.rs"),
			content: z.string().describe("Full file content as a UTF-8 string"),
			commit_message: z
				.string()
				.describe(
					"Commit message. Be specific: 'Add JWT refresh token handler' not 'update file'.",
				),
			branch: z
				.string()
				.describe(
					"Branch to write to. Must exist — create it first with create_branch.",
				),
		},
		async (args) => {
			const result = await executeGitTool(
				octokit,
				repo,
				call("write_file", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const writeFiles = tool(
		"write_files",
		"Write multiple files in sequence on a branch. More efficient than multiple write_file calls when creating a feature.",
		{
			branch: z.string().describe("Branch to write to. Must exist."),
			files: z
				.array(
					z.object({
						path: z.string(),
						content: z.string(),
						commit_message: z.string(),
					}),
				)
				.describe("List of files to write"),
		},
		async (args) => {
			const result = await executeGitTool(
				octokit,
				repo,
				call("write_files", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const listDirectory = tool(
		"list_directory",
		"List files and subdirectories at a path in the repository",
		{
			path: z
				.string()
				.describe("Directory path. Use empty string or '.' for repo root."),
			branch: z
				.string()
				.describe("Branch to read from. Defaults to the default branch.")
				.optional(),
		},
		async (args) => {
			const result = await executeGitTool(
				octokit,
				repo,
				call("list_directory", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const gitTools = [
		createBranch,
		readFile,
		writeFile,
		writeFiles,
		listDirectory,
	];

	// ── CI tools ──────────────────────────────────────────────────────────────

	const triggerTests = tool(
		"trigger_tests",
		"Trigger the test suite workflow on a specific branch via workflow_dispatch. " +
			"Returns a run ID you can use with wait_for_tests.",
		{
			branch: z
				.string()
				.describe("Branch to run tests on. Usually the PR's head branch."),
			issue_number: z
				.number()
				.describe("Related issue or PR number for traceability (optional).")
				.optional(),
		},
		async (args) => {
			const result = await executeCITool(
				octokit,
				repo,
				call("trigger_tests", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const waitForTests = tool(
		"wait_for_tests",
		"Poll a workflow run until it completes (or times out after 10 minutes). " +
			"Returns the full result including per-job pass/fail. Call this after trigger_tests.",
		{
			run_id: z.number().describe("Workflow run ID returned by trigger_tests."),
		},
		async (args) => {
			const result = await executeCITool(
				octokit,
				repo,
				call("wait_for_tests", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const getCheckResults = tool(
		"get_check_results",
		"Read existing CI check results for a branch, commit SHA, or PR head. " +
			"Use this to see what CI already reported without triggering a new run.",
		{
			ref: z
				.string()
				.describe("Branch name, full commit SHA, or PR head SHA to check."),
		},
		async (args) => {
			const result = await executeCITool(
				octokit,
				repo,
				call("get_check_results", args as Record<string, unknown>),
			);
			return mcpText(result.content);
		},
	);

	const ciTools = [triggerTests, waitForTests, getCheckResults];

	// ── Role-based tool selection (mirrors runner.ts DEV_ROLES logic) ─────────

	const DEV_ROLES = new Set<AgentRole>(["backend", "frontend"]);
	const tools = DEV_ROLES.has(role)
		? [...githubTools, ...gitTools]
		: role === "qa"
			? [...githubTools, ...ciTools]
			: githubTools;

	return createSdkMcpServer({ name: `${role}-tools`, tools });
}
