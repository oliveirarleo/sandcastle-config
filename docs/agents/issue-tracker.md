# Issue tracker: beads (bd)

Issues for this repo are tracked via the **beads** CLI (`bd`), using the global shared-server database (`beads_global`).

## Conventions

- Create issues with `bd create --title "..." --body "..."`
- Use `bd label` to manage labels (including triage labels)
- Query issues with `bd list`, `bd query`, or `bd search`
- Show issue details with `bd show <id>`
- Close issues with `bd close <id>`
- Link dependencies with `bd link <child> <parent>`

## When a skill says "publish to the issue tracker"

Run `bd create` (or `bd create-form` for interactive) to create the issue. Capture the returned issue ID and reference it in follow-up work.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>` or `bd list` with appropriate filters to retrieve the issue.
