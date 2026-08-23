---
description: Bring an existing vault forward — preview and apply the pending migrations.
argument-hint: [--only <id>[:<path>]]
---

You are bringing an already-scaffolded vault up to date with the plugin it is
bound to. This is the path for vaults created by an older version: `scaffold`
only ever writes a folder README that does not exist yet, so nothing else
updates one.

Not this: regenerating a derived view (the board, an index, the code map) is
`/projectstore:reconcile`. A migration changes content that is *not* derived —
it needs your approval and it archives what it replaces.

Steps:

1. **Check config**: `test -f .claude/projectstore.json` — if missing, tell the
   user to run `/projectstore:bind <path>` and stop.

2. **Plan** — this writes nothing:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/migrate.mjs" $ARGUMENTS
   ```

   The JSON is `{ vault, write: false, migrations: [{ id, since, title, why,
   pending: [{ rel, path, lang, before, after }], skipped: [{ rel, reason }] }] }`.

3. **If every `pending` array is empty**: say so in one line — "nothing pending;
   this vault matches the plugin" — list any `skipped` entries with their
   reasons, and stop. Do not offer to write.

4. **Preview**: for each pending file print the path and a diff of `before` →
   `after`. Show the **whole** replaced region, not a summary — the user is
   approving the loss of that text and cannot approve what they cannot see.
   Then print each `skipped` entry with its reason, so the user knows which
   files this cannot help.

5. **Check the undo before asking.** Run
   `git -C "<vault>" status --porcelain` (and note a nonzero exit, which means
   the vault is not a git repository at all). State plainly in the approval
   question which of these holds:
   - clean repo → "your vault is committed; `git diff` will show exactly this";
   - **uncommitted changes** → "your vault has uncommitted edits, so git will
     not give them back";
   - **not a repository** → "your vault is not under git".
   In all three cases add: "the previous contents of every replaced file are
   copied to `<vault>/.projectstore/migrations/<id>/` first" — that directory is
   machine-local and git-ignored, and it is the undo that always exists.

6. **Ask approval** via AskUserQuestion: "Apply these N change(s)? [Yes / Only
   some / No]". On **Only some**, ask which files and pass them through as
   `--only <id>:<rel>[,<id>:<rel>…]`.

7. **Apply**:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/migrate.mjs" --write [--only …]
   ```

   Every write goes through the core's atomic replace, and each file is
   re-checked against your preview immediately before it lands. A `conflict`
   entry means another session changed that file underneath you in the region
   the migration owns: report it, do not retry blindly, and offer to re-run
   step 2 so the user approves a fresh preview. The command exits nonzero when
   anything conflicted or errored.

8. **Report**: which files changed, which were skipped and why, and where the
   pre-images went. Then suggest `/projectstore:doctor` to confirm the vault is
   clean.

## Declining

If the user wants to keep their own wording for a folder, there are two ways and
they mean different things:

- **Keep this preamble, permanently** — change the word `managed` to `mine` on
  the `<!-- projectstore:purpose … -->` line in that README. The doctor stops
  linting it and every future migration leaves it alone.
- **Stop offering this migration for this file** — 
  `node "$CLAUDE_PLUGIN_ROOT/scripts/migrate.mjs" --decline <id>:<rel>`. Use
  this for a file the migration reports as `skipped`, which has nowhere to carry
  a marker. It records the path under
  `<vault>/.projectstore/migrations/<id>/declined`; deleting that line undoes it.
