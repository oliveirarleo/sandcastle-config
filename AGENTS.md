# Tools

- Use ripgrep to search inside files.
- Use fd to find files.

# Bash commands

- Always output stdio to files inside `.scratch/outputs`.
- When writing scripts, istead of running them directly, write them to `.scratch/scripts` first, then run them.

# When to delegate to a subagent

 If you encounter any of the following, spawn a subagent rather than investigating alone:

 - Uncertainty about scope, architecture, or product decisions → delegate to oracle (forked context)
 - Need to explore unfamiliar code across multiple modules → delegate to scout (fresh context)
 - Need external docs, API behavior, or ecosystem research → delegate to researcher (fresh context)
 - Want adversarial review before committing to a direction → delegate to reviewer (fresh context)
 - Task is complex enough that a separate execution thread reduces error → delegate to worker (forked context, only after direction is approved)

 How to delegate

 For each subagent, provide a compact contract:

 1. Goal: the concrete outcome you need (e.g., "Map the auth flow and list every file that validates tokens")
 2. Context: relevant file paths, plan links, decisions already made, or constraints
 3. Success criteria: what must be true before the child finishes
 4. Hard constraints: invariants like "do not edit files," "do not spawn subagents," or "escalate unapproved decisions via contact_supervisor"
 5. Output: expected summary shape, artifact path, or finding format
 6. Stop rules: when to stop searching and report back

 Authority rule: You own orchestration. Subagents must not spawn their own subagents, must not run orchestration loops, and must escalate decisions rather than making scope/architecture choices alone.

 When to use handoff instead

 Use the handoff skill only when you are ending the session and want a future agent session to continue your work. Save it via mktemp -t handoff-XXXXXX.md, summarize current state, reference existing
 artifacts by path, and note what the next session should focus on.

## Agent skills

### Issue tracker

Issues tracked via beads (`bd`) global database. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout — `CONTEXT-MAP.md` at root pointing to per-context `CONTEXT.md` files (root + `foreman/`). See `docs/agents/domain.md`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
