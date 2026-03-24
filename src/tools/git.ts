import type { Octokit } from "@octokit/rest";
import type {
	RepoContext,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from "../types.ts";

// ─── Branch helpers ───────────────────────────────────────────────────────────

export async function createBranch(
	octokit: Octokit,
	repo: RepoContext,
	branchName: string,
	fromRef?: string,
): Promise<void> {
	// Get the SHA of the base ref (defaults to the repo's default branch)
	const base = fromRef ?? repo.defaultBranch;
	const { data: refData } = await octokit.git.getRef({
		owner: repo.owner,
		repo: repo.repo,
		ref: `heads/${base}`,
	});

	await octokit.git.createRef({
		owner: repo.owner,
		repo: repo.repo,
		ref: `refs/heads/${branchName}`,
		sha: refData.object.sha,
	});
}

export async function branchExists(
	octokit: Octokit,
	repo: RepoContext,
	branchName: string,
): Promise<boolean> {
	try {
		await octokit.git.getRef({
			owner: repo.owner,
			repo: repo.repo,
			ref: `heads/${branchName}`,
		});
		return true;
	} catch {
		return false;
	}
}

// ─── File read/write ──────────────────────────────────────────────────────────

export interface FileContent {
	path: string;
	content: string; // decoded UTF-8 string
	sha: string; // required for updates — GitHub rejects writes without current SHA
	encoding: string;
}

export async function readFile(
	octokit: Octokit,
	repo: RepoContext,
	filePath: string,
	branch?: string,
): Promise<FileContent> {
	const { data } = await octokit.repos.getContent({
		owner: repo.owner,
		repo: repo.repo,
		path: filePath,
		...(branch && { ref: branch }),
	});

	// getContent can return array (directory) or single file
	if (Array.isArray(data)) {
		throw new Error(`Path "${filePath}" is a directory, not a file`);
	}

	if (data.type !== "file" || !("content" in data)) {
		throw new Error(`Path "${filePath}" is not a readable file`);
	}

	const content = Buffer.from(data.content, "base64").toString("utf-8");
	return { path: filePath, content, sha: data.sha, encoding: data.encoding };
}

export async function writeFile(
	octokit: Octokit,
	repo: RepoContext,
	params: {
		path: string;
		content: string; // UTF-8 string — we handle base64 encoding
		message: string;
		branch: string;
		sha?: string; // required when updating an existing file, omit for new files
	},
): Promise<{ sha: string; url: string }> {
	const encoded = Buffer.from(params.content, "utf-8").toString("base64");

	const { data } = await octokit.repos.createOrUpdateFileContents({
		owner: repo.owner,
		repo: repo.repo,
		path: params.path,
		message: params.message,
		content: encoded,
		branch: params.branch,
		...(params.sha && { sha: params.sha }),
	});

	return {
		sha: data.content?.sha ?? "",
		url: data.content?.html_url ?? "",
	};
}

// ─── Directory listing ────────────────────────────────────────────────────────

export interface TreeEntry {
	path: string;
	type: "file" | "dir";
	size?: number;
}

export async function listDirectory(
	octokit: Octokit,
	repo: RepoContext,
	dirPath: string,
	branch?: string,
): Promise<TreeEntry[]> {
	const { data } = await octokit.repos.getContent({
		owner: repo.owner,
		repo: repo.repo,
		path: dirPath,
		...(branch && { ref: branch }),
	});

	if (!Array.isArray(data)) {
		throw new Error(`Path "${dirPath}" is a file, not a directory`);
	}

	return data.map((entry) => ({
		path: entry.path,
		type: entry.type === "dir" ? "dir" : "file",
		size: entry.size,
	}));
}

// ─── Multi-file write (sequential, atomic per-file) ───────────────────────────
// Agents often need to write several files in one task. This helper handles
// the read-then-write SHA dance automatically for each file.
//
// Before: agent had to call read_file → grab SHA → write_file for every single file
// After:  agent calls write_files with an array; we handle SHA resolution internally

export interface FileWrite {
	path: string;
	content: string;
	commitMessage: string;
}

export async function writeFiles(
	octokit: Octokit,
	repo: RepoContext,
	files: FileWrite[],
	branch: string,
): Promise<Array<{ path: string; sha: string; url: string }>> {
	const results: Array<{ path: string; sha: string; url: string }> = [];

	for (const file of files) {
		// Try to get the existing SHA — if file doesn't exist yet, omit SHA (creates new)
		let existingSha: string | undefined;
		try {
			const existing = await readFile(octokit, repo, file.path, branch);
			existingSha = existing.sha;
		} catch {
			// File doesn't exist yet — that's fine, we'll create it
		}

		const result = await writeFile(octokit, repo, {
			path: file.path,
			content: file.content,
			message: file.commitMessage,
			branch,
			sha: existingSha,
		});

		results.push({ path: file.path, ...result });
		console.log(
			`[git] Wrote ${file.path} to ${branch} (sha: ${result.sha.slice(0, 7)})`,
		);
	}

	return results;
}

// ─── Branch name sanitizer ────────────────────────────────────────────────────
// Agents pass human-readable names — this cleans them to valid git branch names.
//
// Before: "feat/Add JWT refresh token endpoint!!" → git rejects it
// After:  "feat/add-jwt-refresh-token-endpoint"

export function sanitizeBranchName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9/_-]/g, "-") // replace invalid chars with -
		.replace(/-+/g, "-") // collapse multiple dashes
		.replace(/^[-/]+|[-/]+$/g, "") // trim leading/trailing - and /
		.slice(0, 100); // git has a ~250 char limit, 100 is plenty
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────

export const GIT_TOOLS: ToolDefinition[] = [
	{
		name: "create_branch",
		description:
			"Create a new git branch from the default branch (or a specified base ref)",
		input_schema: {
			type: "object",
			properties: {
				branch_name: {
					type: "string",
					description:
						"Branch name. Use format: feat/<short-description> or fix/<short-description>. Will be sanitized automatically.",
				},
				from_ref: {
					type: "string",
					description:
						"Base branch to fork from. Defaults to the repo's default branch.",
				},
			},
			required: ["branch_name"],
		},
	},
	{
		name: "read_file",
		description: "Read the contents of a file from the repository",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to repo root, e.g. src/main.rs",
				},
				branch: {
					type: "string",
					description: "Branch to read from. Defaults to the default branch.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description:
			"Write or update a single file on a branch. Creates the file if it doesn't exist.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File path relative to repo root, e.g. src/handlers/auth.rs",
				},
				content: {
					type: "string",
					description: "Full file content as a UTF-8 string",
				},
				commit_message: {
					type: "string",
					description:
						"Commit message. Be specific: 'Add JWT refresh token handler' not 'update file'.",
				},
				branch: {
					type: "string",
					description:
						"Branch to write to. Must exist — create it first with create_branch.",
				},
			},
			required: ["path", "content", "commit_message", "branch"],
		},
	},
	{
		name: "write_files",
		description:
			"Write multiple files in sequence on a branch. More efficient than multiple write_file calls when creating a feature.",
		input_schema: {
			type: "object",
			properties: {
				branch: {
					type: "string",
					description: "Branch to write to. Must exist.",
				},
				files: {
					type: "array",
					description: "List of files to write",
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string" },
							commit_message: { type: "string" },
						},
						required: ["path", "content", "commit_message"],
					},
				},
			},
			required: ["branch", "files"],
		},
	},
	{
		name: "list_directory",
		description: "List files and subdirectories at a path in the repository",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory path. Use empty string or '.' for repo root.",
				},
				branch: {
					type: "string",
					description: "Branch to read from. Defaults to the default branch.",
				},
			},
			required: ["path"],
		},
	},
];

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeGitTool(
	octokit: Octokit,
	repo: RepoContext,
	toolCall: ToolCall,
): Promise<ToolResult> {
	const input = toolCall.input;

	try {
		switch (toolCall.name) {
			case "create_branch": {
				const rawName = input.branch_name as string;
				const branchName = sanitizeBranchName(rawName);

				// Idempotent — skip if branch already exists
				const exists = await branchExists(octokit, repo, branchName);
				if (exists) {
					return {
						tool_use_id: toolCall.id,
						content: JSON.stringify({
							success: true,
							branch: branchName,
							note: "Branch already existed",
						}),
					};
				}

				await createBranch(
					octokit,
					repo,
					branchName,
					input.from_ref as string | undefined,
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true, branch: branchName }),
				};
			}

			case "read_file": {
				const file = await readFile(
					octokit,
					repo,
					input.path as string,
					input.branch as string | undefined,
				);
				return {
					tool_use_id: toolCall.id,
					// Return content + sha so agent has what it needs for a follow-up write
					content: JSON.stringify({
						path: file.path,
						content: file.content,
						sha: file.sha,
					}),
				};
			}

			case "write_file": {
				// Auto-resolve SHA so agents don't have to manually read before writing
				let existingSha: string | undefined;
				try {
					const existing = await readFile(
						octokit,
						repo,
						input.path as string,
						input.branch as string,
					);
					existingSha = existing.sha;
				} catch {
					// New file — no SHA needed
				}

				const result = await writeFile(octokit, repo, {
					path: input.path as string,
					content: input.content as string,
					message: input.commit_message as string,
					branch: input.branch as string,
					sha: existingSha,
				});
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true, ...result }),
				};
			}

			case "write_files": {
				const files = (
					input.files as Array<{
						path: string;
						content: string;
						commit_message: string;
					}>
				).map((f) => ({
					path: f.path,
					content: f.content,
					commitMessage: f.commit_message,
				}));

				const results = await writeFiles(
					octokit,
					repo,
					files,
					input.branch as string,
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({ success: true, files: results }),
				};
			}

			case "list_directory": {
				const entries = await listDirectory(
					octokit,
					repo,
					input.path as string,
					input.branch as string | undefined,
				);
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify(entries),
				};
			}

			default:
				return {
					tool_use_id: toolCall.id,
					content: JSON.stringify({
						error: `Unknown git tool: ${toolCall.name}`,
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
