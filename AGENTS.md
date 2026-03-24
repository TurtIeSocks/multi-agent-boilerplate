# Agent Forge — Standing Orders

This repo is managed by a fleet of AI agents orchestrated via GitHub webhooks.
Humans and agents collaborate through GitHub Issues, PRs, and the Project board.

---

## The Team

| Agent        | Role                                    | Triggered by                               |
| ------------ | --------------------------------------- | ------------------------------------------ |
| **PM**       | Triage, sprint planning, ticket writing | `issues.opened`, `project_v2_item.created` |
| **Backend**  | Rust implementation                     | Issue labeled `in-progress` + `backend`    |
| **Frontend** | TypeScript/React implementation         | Issue labeled `in-progress` + `frontend`   |
| **QA**       | Review PRs, file regression tickets     | `pull_request.opened`                      |
| **Refactor** | Post-merge cleanup tickets              | `pull_request.merged`                      |

---

## Workflow

```
You open an issue
    ↓
PM agent triages it — adds labels, priority, acceptance criteria
    ↓
You move it to "In Progress" on the board (or label it "in-progress")
    ↓
Backend or Frontend agent picks it up — comments with plan, opens PR
    ↓
QA agent reviews the PR — leaves review comment, files regression tickets if needed
    ↓
You merge the PR
    ↓
Refactor agent scans for cleanup opportunities — files low-priority tickets
```

---

## Board Columns

| Column          | Meaning                                     |
| --------------- | ------------------------------------------- |
| **Backlog**     | Triaged and ready to be picked up           |
| **In Progress** | An agent or human is actively working on it |
| **In Review**   | PR is open, waiting for QA                  |
| **Done**        | Merged and closed                           |
| **Blocked**     | Needs human attention before it can move    |

---

## Labels

### Routing labels (tell agents who owns this)

- `backend` — Rust work
- `frontend` — TypeScript/React work
- `qa` — Testing or QA work
- `refactor` — Code cleanup

### Status labels

- `in-progress` — Triggers dev agent dispatch
- `blocked` — PM agent will comment with why
- `regression` — Filed by QA agent, always needs review

### Type labels

- `bug` — Something broken
- `chore` — Maintenance, deps, infra
- `epic` — Large feature, PM will break it down

### Priority labels

- `priority:critical` — Production down
- `priority:high` — Blocking users
- `priority:medium` — Normal planned work
- `priority:low` — Nice to have

---

## Ticket Format

All tickets created by the PM agent follow this structure:

```markdown
## Context

Why this work is needed and what problem it solves.

## Acceptance Criteria

- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2

## Out of Scope

What this ticket explicitly does NOT cover (prevents scope creep).

## Notes

Any technical constraints, links, or additional context.
```

---

## For Humans

- **To start a sprint:** Open an issue describing your goal. The PM agent will break it down.
- **To assign work to an agent:** Add the `in-progress` label + `backend` or `frontend`.
- **To override an agent:** Just edit the ticket or PR — agents won't fight you.
- **To block an agent loop:** Add the `blocked` label. Agents skip blocked tickets.
- **To give feedback:** Comment on the PR or issue. Agents read comments on their next trigger.

---

## Environment Variables

See `.env.example` for the full list. Never commit `.env`.

---

## Architecture

```
src/
├── agents/
│   ├── runner.ts       ← shared agentic loop (tool-call ↔ Claude)
│   ├── pm.ts           ← PM agent config + system prompt
│   ├── backend.ts      ← Backend agent config + system prompt
│   ├── frontend.ts     ← Frontend agent config + system prompt
│   ├── qa.ts           ← QA agent config + system prompt
│   └── refactor.ts     ← Refactor agent config + system prompt
├── tools/
│   └── github.ts       ← GitHub API wrappers + tool definitions for Claude
├── orchestrator.ts     ← webhook event router
├── server.ts           ← Hono HTTP server + signature verification
├── setup.ts            ← one-time repo/project bootstrap
└── types.ts            ← shared TypeScript interfaces
```
