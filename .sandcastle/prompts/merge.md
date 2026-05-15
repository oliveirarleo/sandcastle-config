# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
   - **If `.beads/issues.jsonl` has conflicts**: solve them normally.
   - If tree is dirty with `.bead/` files, just `jj squash` them and solve the conflicts
3. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

# CLOSE ISSUES (BEFORE COMMIT)

For each branch that was merged, close its issue **before committing** using the following command:

`bd close <ID> --reason "Completed by Sandcastle"`

`bd close` updates both the Dolt database and `.beads/issues.jsonl`, which prevents merge conflicts on the issue database in future merges.

Here are all the issues:

{{ISSUES}}

5. After closing all issues, make a single commit summarizing the merge.

Once you've merged everything you can, output <promise>COMPLETE</promise>.
