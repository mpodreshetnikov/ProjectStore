---
description: Scaffold the bound vault with the layout's folder structure and README index files.
argument-hint: [layout-name]
---

You are creating the folder structure of the projectstore layout inside the bound vault.

Steps:

1. **Read config**: `cat .claude/projectstore.json`. If missing, tell user to run `/projectstore:bind <path>` and stop.
2. **Determine layout**: use `$ARGUMENTS` if provided, else `config.layout`.
3. **Load layout spec**: `cat "$CLAUDE_PLUGIN_ROOT/scaffold/layouts/<layout>.json"`. Parse it.
4. **Show plan**: list every folder that will be created and which folders already exist. Mark new ones with `(create)`, existing with `(exists)`.
5. **Ask approval** via AskUserQuestion: "Create the missing folders and READMEs? [Yes / Skip READMEs / No]".
6. **Execute**:
   - Render every folder README in ONE call — their text is layout data, not
     yours to compose: `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" folder-readmes`.
     It returns `{ language, entries: [{ folder, kind, path, exists, content }] }`,
     one entry per folder that declares a README.
     **Never write your own wording into a folder README.** Two vaults on the
     same layout must get byte-identical text, and that preamble is what
     SessionStart injects every session as the folder's stated purpose — prose
     invented here would become the vault's canonical answer to "what goes in
     this folder", differently in every vault.
   - For each folder in `layout.folders`:
     - Create directory via `mkdir -p <vault>/<folder.path>`.
     - If `folder.readme === true` and its entry's `exists` is `false`, Write
       `entry.content` to `entry.path` **verbatim**.
     - An entry whose `exists` is `true` is left untouched: an existing README
       carries index rows and prose a human owns.
   - Also create a top-level `<vault>/README.md` if missing — a simple index pointing to each folder.
7. **Print result**: tree of newly created files and a one-line "next step" suggestion.
