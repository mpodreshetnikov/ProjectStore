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
   pending: [{ rel, path, lang, sha, before, after }], skipped: [{ rel, reason }] }] }`.
   **Keep each `sha`** — step 7 passes them back, and they are what ties the
   write to the bytes the user actually looked at.

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
   node "$CLAUDE_PLUGIN_ROOT/scripts/migrate.mjs" --write [--only …] \
     --expect "<rel>=<sha>" [--expect "<rel>=<sha>" …]
   ```

   Pass one `--expect` per file you previewed, with the `sha` from step 2.
   Without them the write is a second, independent read: everything that
   changed while the user was reading and deciding would be invisible, and that
   window is the whole reason this command has a gate. Every write goes through
   the core's atomic replace, and the previous contents are archived first.

   A `conflict` entry means that file changed after the preview the user
   approved. Report it, do not retry blindly, and offer to re-run step 2 so they
   approve a fresh one. The command exits nonzero when anything conflicted or
   errored.

8. **Report**: which files changed, which were skipped and why, and where the
   pre-images went. Then suggest `/projectstore:doctor` to confirm the vault is
   clean.

## Declining

If the user wants to keep their own wording for a folder, there are two ways and
they mean different things:

`node "$CLAUDE_PLUGIN_ROOT/scripts/migrate.mjs" --decline <id>:<rel>` — or the
equivalent by hand: change the word `managed` to `mine` on the
`<!-- projectstore:purpose … -->` line of that README.

Both do the same thing, because the decline is written **into the file**. The
vault travels with the repo, so a decline recorded only on this machine would be
invisible to whoever clones it next and migrates the file away. The doctor stops
linting a `mine` preamble and every future migration leaves it alone; changing
the word back to `managed` un-declines it.

**The marker line must stay in the file.** Removing it altogether leaves a
README indistinguishable from one in a vault nobody has brought forward, so the
next run offers to replace exactly the wording its owner wanted to keep. Change
the word; do not remove the line.

The one exception is a target the plan reports as `skipped` — it has nowhere to
put a marker, so `--decline` falls back to recording the path under
`<vault>/.projectstore/migrations/<id>/declined`. That record is machine-local;
say so when you use it.
