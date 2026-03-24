#!/usr/bin/env bun

/**
 * setup.ts — run once to bootstrap the GitHub repo and project board.
 *
 * Usage:
 *   bun run setup
 *
 * What it does:
 *   1. Creates the GitHub repo (if it doesn't exist)
 *   2. Creates a GitHub ProjectV2 board with the right columns
 *   3. Creates all required labels
 *   4. Sets up branch protection on main
 *   5. Prints the values you need for your .env file
 */

import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";

// ─── Config from env ──────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO ?? "agent-forge-project";
const PROJECT_TITLE = process.env.PROJECT_TITLE ?? "Agent Forge Board";

if (!GITHUB_TOKEN || !GITHUB_OWNER) {
	console.error(
		"❌  GITHUB_TOKEN and GITHUB_OWNER must be set before running setup.",
	);
	process.exit(1);
}

// After the guard above, these are guaranteed to be strings.
const token = GITHUB_TOKEN as string;
const owner = GITHUB_OWNER as string;

const octokit = new Octokit({ auth: token });
const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });

// ─── Labels ───────────────────────────────────────────────────────────────────

const LABELS = [
	{ name: "backend", color: "0075ca", description: "Backend / Rust work" },
	{
		name: "frontend",
		color: "e4e669",
		description: "Frontend / TypeScript work",
	},
	{ name: "qa", color: "d93f0b", description: "QA or testing work" },
	{
		name: "refactor",
		color: "bfd4f2",
		description: "Code cleanup / tech debt",
	},
	{
		name: "regression",
		color: "e11d48",
		description: "Regression found by QA agent",
	},
	{ name: "bug", color: "d73a4a", description: "Something isn't working" },
	{ name: "chore", color: "c5def5", description: "Maintenance, deps, config" },
	{
		name: "epic",
		color: "7057ff",
		description: "Large feature spanning multiple tickets",
	},
	{
		name: "in-progress",
		color: "0e8a16",
		description: "Actively being worked on",
	},
	{
		name: "blocked",
		color: "b60205",
		description: "Blocked — needs attention",
	},
	{
		name: "priority:critical",
		color: "b60205",
		description: "Production down",
	},
	{ name: "priority:high", color: "e4502b", description: "Blocking users" },
	{ name: "priority:medium", color: "f9d0c4", description: "Planned work" },
	{ name: "priority:low", color: "fef2c0", description: "Nice to have" },
];

// ─── Project board columns ────────────────────────────────────────────────────

const STATUS_OPTIONS = [
	"Backlog",
	"In Progress",
	"In Review",
	"Done",
	"Blocked",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function step(label: string, fn: () => Promise<void>) {
	process.stdout.write(`  ${label}... `);
	try {
		await fn();
		console.log("✓");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// 422 = already exists — not a real error for idempotent setup
		if (
			msg.includes("422") ||
			msg.includes("already exists") ||
			msg.includes("Name already exists")
		) {
			console.log("(already exists, skipping)");
		} else {
			console.log("✗");
			throw err;
		}
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	console.log("\n🤖  Agent Forge — GitHub Setup\n");

	// 1. Create or verify repo
	let repoNodeId = "";
	console.log("1. Repository");
	await step(`Creating ${owner}/${REPO_NAME}`, async () => {
		const { data } = await octokit.repos.createForAuthenticatedUser({
			name: REPO_NAME,
			description: "Managed by Agent Forge — multi-agent engineering system",
			auto_init: true,
			private: false,
		});
		repoNodeId = data.node_id;
		console.log(`\n     URL: ${data.html_url}`);
	});

	// Fetch node ID if repo already existed
	if (!repoNodeId) {
		const { data } = await octokit.repos.get({ owner: owner, repo: REPO_NAME });
		repoNodeId = data.node_id;
	}

	// 2. Create labels
	console.log("\n2. Labels");
	for (const label of LABELS) {
		await step(label.name, async () => {
			await octokit.issues.createLabel({
				owner: owner,
				repo: REPO_NAME,
				name: label.name,
				color: label.color,
				description: label.description,
			});
		});
	}

	// 3. Create GitHub ProjectV2
	console.log("\n3. GitHub Project board");
	let projectId = "";
	let projectNumber = 0;

	await step(`Creating project "${PROJECT_TITLE}"`, async () => {
		// Get the authenticated user's node ID
		const userResult = await gql<{ viewer: { id: string } }>(`
      query { viewer { id } }
    `);

		const result = await gql<{
			createProjectV2: {
				projectV2: { id: string; number: number; url: string };
			};
		}>(
			`
      mutation($ownerId: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $ownerId, title: $title }) {
          projectV2 { id number url }
        }
      }
    `,
			{ ownerId: userResult.viewer.id, title: PROJECT_TITLE },
		);

		projectId = result.createProjectV2.projectV2.id;
		projectNumber = result.createProjectV2.projectV2.number;
		console.log(`\n     URL: ${result.createProjectV2.projectV2.url}`);
	});

	// Fetch project ID if it already existed (we can't easily dedupe project names,
	// so we'll warn the user if this step was skipped)
	if (!projectId) {
		console.log(
			"     ⚠️  Project may already exist — check GitHub and set GITHUB_PROJECT_NUMBER manually.",
		);
	}

	// 4. Update the Status field options on the project
	if (projectId) {
		console.log("\n4. Project status columns");
		await step("Fetching Status field", async () => {
			const result = await gql<{
				node: {
					fields: {
						nodes: Array<{
							__typename: string;
							id: string;
							name: string;
							options?: Array<{ id: string; name: string }>;
						}>;
					};
				};
			}>(
				`
        query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              fields(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2SingleSelectField {
                    id name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `,
				{ projectId },
			);

			const statusField = result.node.fields.nodes.find(
				(f) =>
					f.__typename === "ProjectV2SingleSelectField" && f.name === "Status",
			);

			if (statusField) {
				const existingNames = statusField.options?.map((o) => o.name) ?? [];
				const missing = STATUS_OPTIONS.filter(
					(s) => !existingNames.includes(s),
				);

				if (missing.length > 0) {
					console.log(`\n     Adding columns: ${missing.join(", ")}`);
					// GitHub Projects API doesn't allow bulk-adding options via GraphQL easily —
					// the default Status field already has Todo/In Progress/Done.
					// The user should rename/add columns manually in the GitHub UI.
					console.log(
						"     ℹ️  Please rename/add columns in GitHub Projects UI to match:",
					);
					STATUS_OPTIONS.forEach((s) => console.log(`        - ${s}`));
				} else {
					console.log(" columns already correct");
				}
			}
		});

		// 5. Link repo to project
		console.log("\n5. Link repo to project");
		await step("Linking repository", async () => {
			await gql(
				`
        mutation($projectId: ID!, $repoId: ID!) {
          linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repoId }) {
            repository { name }
          }
        }
      `,
				{ projectId, repoId: repoNodeId },
			);
		});
	}

	// 6. Branch protection on main
	console.log("\n6. Branch protection");
	await step("Protecting main branch", async () => {
		await octokit.repos.updateBranchProtection({
			owner: owner,
			repo: REPO_NAME,
			branch: "main",
			required_status_checks: null,
			enforce_admins: false,
			required_pull_request_reviews: {
				required_approving_review_count: 0, // solo dev — just need the PR flow
			},
			restrictions: null,
		});
	});

	// 7. Print .env values
	console.log("\n─────────────────────────────────────────");
	console.log("✅  Setup complete! Add these to your .env:\n");
	console.log(`GITHUB_TOKEN=${token}`);
	console.log(`GITHUB_OWNER=${owner}`);
	console.log(`GITHUB_REPO=${REPO_NAME}`);
	console.log(`GITHUB_PROJECT_NUMBER=${projectNumber || "<check GitHub>"}`);
	console.log(`GITHUB_WEBHOOK_SECRET=<generate with: openssl rand -hex 32>`);
	console.log(`ANTHROPIC_API_KEY=<your key>`);
	console.log(`PORT=3000`);
	console.log(`WEBHOOK_PATH=/webhook`);
	console.log(`DEFAULT_BRANCH=main`);
	console.log("─────────────────────────────────────────\n");

	console.log("Next steps:");
	console.log("  1. Fill in .env with the values above");
	console.log("  2. Run: bun run dev");
	console.log("  3. Expose localhost with: npx localtunnel --port 3000");
	console.log("     or: ngrok http 3000");
	console.log(`  4. Add webhook in GitHub repo settings:`);
	console.log(`     URL: https://<your-tunnel>/webhook`);
	console.log(`     Content type: application/json`);
	console.log(`     Secret: your GITHUB_WEBHOOK_SECRET`);
	console.log(`     Events: Issues, Pull requests, Projects (v2)`);
	console.log("");
}

main().catch((err) => {
	console.error("\n❌  Setup failed:", err.message ?? err);
	process.exit(1);
});
