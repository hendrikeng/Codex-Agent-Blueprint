# Git Safety

Status: canonical
Owner: {{DOC_OWNER}}
Last Updated: {{LAST_UPDATED_ISO_DATE}}
Source of Truth: docs/design-docs/git-safety.md

## File and Git Safety Rules

- Never revert/delete work you did not author unless explicitly requested in-thread.
- Never run destructive git/file commands without explicit written instruction.
- Never use `git stash` unless explicitly requested in-thread.
- Never switch branches or create/remove/modify git worktrees unless explicitly requested in-thread.
- Avoid repo-wide blind search/replace scripts; keep edits path-scoped and reviewable.
- Never edit `.env` or environment variable files.
- Keep commits atomic and path-explicit.
- Never use `git add .` or `git commit -am`.
- For tracked files, commit path-explicit: `git commit -m "<scoped message>" -- path/to/file1 path/to/file2`.
- For new files, stage explicitly: `git restore --staged :/ && git add "path/to/file1" "path/to/file2" && git commit -m "<scoped message>" -- path/to/file1 path/to/file2`.
- `git restore --staged :/` is allowed only for index cleanup in the commit flow above, never for content rollback.
- Never use `git restore`/`git checkout` to revert files you did not author.
- Quote git paths containing brackets/parentheses when staging or committing.
- One logical change per commit; no mixed concerns.
- Do not amend commits unless explicitly approved in this conversation.
- For multi-line GitHub issue/PR comments via `gh`, use heredoc (`-F - <<'EOF'`) to preserve newlines and avoid shell escaping corruption.
