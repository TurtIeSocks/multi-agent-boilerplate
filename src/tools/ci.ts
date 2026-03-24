import type { Octokit } from "@octokit/rest";
import type {
	RepoContext,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from "../types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKFLOW_FILE = "test.yml";
const POLL_INTERVAL_MS = 10_000; // 10 seconds between polls
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minute hard ceiling

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkflowConclusion =
	| "success"
	| "failure"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required"
	| "neutral"
	| null; // null = still in progress

export interface WorkflowRunResult {
	runId: number;
	runUrl: string;
	status: "queued" | "in_progress" | "completed" | "waiting";
	conclusion: WorkflowConclusion;
	jobResults: JobResult[];
	durationSeconds: number;
	logsUrl: string;
}

export interface JobResult {
	name: string;
	status: string;
	conclusion: WorkflowConclusion;
	steps: StepResult[];
}

export interface StepResult {
	name: string;
	conclusion: WorkflowConclusion;
	number: number;
}

export interface CheckResult {
	name: string;
	status: string;
	conclusion: WorkflowConclusion;
	detailsUrl: string;
	summary: string | null;
}

// ─── Workflow dispatch ────────────────────────────────────────────────────────

export async function triggerWorkflow(
	octokit: Octokit,
	repo: RepoContext,
	params: {
		branch: string;
		workflowFile?: string;
		triggeredBy?: string;
		issueNumber?: number;
	},
): Promise<number> {
	const workflowFile = params.workflowFile ?? WORKFLOW_FILE;

	await octokit.actions.createWorkflowDispatch({
		owner: repo.owner,
		repo: repo.repo,
		workflow_id: workflowFile,
		ref: params.branch,
		inputs: {
			branch: params.branch,
			triggered_by: params.triggeredBy ?? "qa-agent",
			issue_number: params.issueNumber?.toString() ?? "",
		},
	});

	// GitHub doesn't return the run ID from dispatch — we have to poll for the
	// run that just appeared. Wait a moment for it to register then find it.
	await sleep(3000);

	const runId = await findLatestRunId(
		octokit,
		repo,
		params.branch,
		workflowFile,
	);
	console.log(
		`[ci] Triggered workflow run ${runId} on branch ${params.branch}`,
	);
	return runId;
}

async function findLatestRunId(
	octokit: Octokit,
	repo: RepoContext,
	branch: string,
	workflowFile: string,
): Promise<number> {
	const { data } = await octokit.actions.listWorkflowRuns({
		owner: repo.owner,
		repo: repo.repo,
		workflow_id: workflowFile,
		branch,
		per_page: 5,
		// Filter to runs created in the last 2 minutes to avoid picking up stale runs
		created: `>=${new Date(Date.now() - 2 * 60 * 1000).toISOString()}`,
	});

	if (data.workflow_runs.length === 0) {
		throw new Error(
			`No recent workflow runs found for ${workflowFile} on branch ${branch}. ` +
				`The workflow may not be configured for workflow_dispatch, or the branch doesn't exist.`,
		);
	}

	// Most recent first
	const latestRun = data.workflow_runs[0];
	if (!latestRun) {
		throw new Error(
			`No workflow runs found after dispatch for ${workflowFile} on ${branch}`,
		);
	}
	return latestRun.id;
}

// ─── Run polling ──────────────────────────────────────────────────────────────
// Polls until the run reaches a terminal state or we hit the timeout.
//
// Before (naive): sleep(60000); check once; hope it's done
// After: tight poll loop with early exit on completion + hard timeout ceiling

export async function pollWorkflowRun(
	octokit: Octokit,
	repo: RepoContext,
	runId: number,
): Promise<WorkflowRunResult> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
		const result = await getWorkflowRunResult(octokit, repo, runId);

		console.log(
			`[ci] Run ${runId}: status=${result.status} conclusion=${result.conclusion}`,
		);

		if (result.status === "completed") {
			return result;
		}

		await sleep(POLL_INTERVAL_MS);
	}

	// Timed out — return what we have
	const partial = await getWorkflowRunResult(octokit, repo, runId);
	return { ...partial, conclusion: "timed_out" };
}

async function getWorkflowRunResult(
	octokit: Octokit,
	repo: RepoContext,
	runId: number,
): Promise<WorkflowRunResult> {
	const [runResponse, jobsResponse] = await Promise.all([
		octokit.actions.getWorkflowRun({
			owner: repo.owner,
			repo: repo.repo,
			run_id: runId,
		}),
		octokit.actions.listJobsForWorkflowRun({
			owner: repo.owner,
			repo: repo.repo,
			run_id: runId,
		}),
	]);

	const run = runResponse.data;
	const jobs = jobsResponse.data.jobs;

	const createdAt = new Date(run.created_at).getTime();
	const updatedAt = new Date(run.updated_at).getTime();

	return {
		runId,
		runUrl: run.html_url,
		status: run.status as WorkflowRunResult["status"],
		conclusion: run.conclusion as WorkflowConclusion,
		durationSeconds: Math.round((updatedAt - createdAt) / 1000),
		logsUrl: run.logs_url,
		jobResults: jobs.map((job) => ({
			name: job.name,
			status: job.status,
			conclusion: job.conclusion as WorkflowConclusion,
			steps: (job.steps ?? []).map((step) => ({
				name: step.name,
				conclusion: step.conclusion as WorkflowConclusion,
				number: step.number,
			})),
		})),
	};
}

// ─── Check results reader ─────────────────────────────────────────────────────
// Reads the Checks API for a given ref — works for any CI provider that reports
// to GitHub Checks (Actions, CircleCI, external tools, etc.)

export async function getCheckResults(
	octokit: Octokit,
	repo: RepoContext,
	ref: string, // branch name, commit SHA, or PR head SHA
): Promise<CheckResult[]> {
	const { data } = await octokit.checks.listForRef({
		owner: repo.owner,
		repo: repo.repo,
		ref,
		per_page: 50,
	});

	return data.check_runs.map((run) => ({
		name: run.name,
		status: run.status,
		conclusion: run.conclusion as WorkflowConclusion,
		detailsUrl: run.details_url ?? run.html_url ?? "",
		summary: run.output?.summary ?? null,
	}));
}

// ─── Formatted result summary ─────────────────────────────────────────────────
// Produces a markdown summary suitable for posting as a PR comment.

export function formatRunSummary(result: WorkflowRunResult): string {
	const icon = result.conclusion === "success" ? "✅" : "❌";
	const lines: string[] = [
		`## ${icon} Test Run #${result.runId}`,
		`**Conclusion:** ${result.conclusion ?? "in progress"}`,
		`**Duration:** ${result.durationSeconds}s`,
		`**Run URL:** ${result.runUrl}`,
		"",
		"### Job Results",
		"",
	];

	for (const job of result.jobResults) {
		const jobIcon =
			job.conclusion === "success"
				? "✅"
				: job.conclusion === "skipped"
					? "⏭️"
					: job.conclusion === null
						? "🔄"
						: "❌";
		lines.push(`#### ${jobIcon} ${job.name} — ${job.conclusion ?? job.status}`);

		// Only show failed steps — passing steps are noise
		const failedSteps = job.steps.filter(
			(s) =>
				s.conclusion &&
				s.conclusion !== "success" &&
				s.conclusion !== "skipped",
		);
		if (failedSteps.length > 0) {
			lines.push("Failed steps:");
			for (const step of failedSteps) {
				lines.push(`  - \`${step.name}\` (${step.conclusion})`);
			}
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────

export const CI_TOOLS: ToolDefinition[] = [
	{
		name: "trigger_tests",
		description:
			"Trigger the test suite workflow on a specific branch via workflow_dispatch. " +
			"Returns a run ID you can use with wait_for_tests. Use this when you want to " +
			"actively run tests rather than just read existing results.",
		input_schema: {
			type: "object",
			properties: {
				branch: {
					type: "string",
					description: "Branch to run tests on. Usually the PR's head branch.",
				},
				issue_number: {
					type: "number",
					description:
						"Related issue or PR number for traceability (optional).",
				},
			},
			required: ["branch"],
		},
	},
	{
		name: "wait_for_tests",
		description:
			"Poll a workflow run until it completes (or times out after 10 minutes). " +
			"Returns the full result including per-job pass/fail. Call this after trigger_tests.",
		input_schema: {
			type: "object",
			properties: {
				run_id: {
					type: "number",
					description: "Workflow run ID returned by trigger_tests.",
				},
			},
			required: ["run_id"],
		},
	},
	{
		name: "get_check_results",
		description:
			"Read existing CI check results for a branch, commit SHA, or PR head. " +
			"Use this to see what CI already reported without triggering a new run. " +
			"Useful for reading results that were triggered by a push event.",
		input_schema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Branch name, full commit SHA, or PR head SHA to check.",
				},
			},
			required: ["ref"],
		},
	},
];

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeCITool(
	octokit: Octokit,
	repo: RepoContext,
	toolCall: ToolCall,
): Promise<ToolResult> {
	const input = toolCall.input;

	try {
		switch (toolCall.name) {
			case "trigger_tests": {
				const runId = await triggerWorkflow(octokit, repo, {
					branch: input.branch as string,
					issueNumber: input.issue_number as number | undefined,
					triggeredBy: "qa-agent",
				});
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({
						success: true,
						run_id: runId,
						message: `Workflow triggered on branch "${input.branch}". Call wait_for_tests with run_id: ${runId} to get results.`,
					}),
				};
			}

			case "wait_for_tests": {
				const result = await pollWorkflowRun(
					octokit,
					repo,
					input.run_id as number,
				);
				const summary = formatRunSummary(result);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ ...result, formattedSummary: summary }),
				};
			}

			case "get_check_results": {
				const checks = await getCheckResults(
					octokit,
					repo,
					input.ref as string,
				);
				const allPassed = checks.every(
					(c) =>
						c.conclusion === "success" ||
						c.conclusion === "skipped" ||
						c.conclusion === "neutral",
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ checks, allPassed }),
				};
			}

			default:
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({
						error: `Unknown CI tool: ${toolCall.name}`,
					}),
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
