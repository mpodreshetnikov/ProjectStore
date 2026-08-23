# Extending projectstore

## Adding a new artifact kind — the honest checklist

Since v0.14 the kind machinery is layout-driven: `draft.mjs` builds ANY kind
declared in the layout, and doctor's template check follows the layout instead
of a hardcoded list. A new kind needs **six touch points** — note that **all
six live inside the plugin installation**, not in your vault (there is no
vault-side layout or template override):

1. **Layout folder entry** — `scaffold/layouts/<name>.json` → `folders`:

   ```jsonc
   { "path": "specs", "kind": "spec", "readme": true, "numbered": true, "prefix": "SPEC-", "pad": 3 }
   ```

   Since v0.18 every kind creates **slug-only filenames** (`<slug>.md`;
   stories keep the `story-` marker: `story-<slug>.md`) — identity lives in
   the slug, sequence numbers are no longer allocated (ADR-010), which makes
   concurrent creation collision-free by construction. `numbered` + `prefix`
   + `pad` stay declared for **grandfathered** vaults: the prefix drives
   legacy-number stripping in identity matching and the index label badge
   (`SPEC-002` rows keep their labels; slug rows are labelled by slug).
   `date_prefix: true` gives `YYYY-MM-DD-slug.md`. The epic folder
   additionally accepts `story_prefix` (default `story-`) for its stories'
   kind marker; `story_pad` remains recognized but only describes legacy
   files.

2. **Layout command entry** — the same file's `commands` array. A command
   needs a template only if it maps to a declared folder kind (`story` maps
   through the `epic` folder; `kanban` through the `kanban` block). A folder
   without a command needs no template — but it is also a folder no supported
   path can fill, which is what `diagrams` was until v0.25. If you declare a
   folder, prefer giving it a command.

3. **Template** — `templates/en/<kind>.md.tmpl` (and `templates/ru/…`).
   Variables filled by `scripts/draft.mjs`: `{{date}}`, `{{author}}`,
   `{{tags}}`, `{{title}}`, `{{slug}}`, `{{id}}` (the exact machine id: the
   slug itself; `story-<slug>` for stories), `{{epic_id}}` (stories). Use
   `{{x_json}}` for any frontmatter scalar — it renders as a valid YAML
   double-quoted string. Frontmatter should carry `id:` and an inline-flow
   `external_refs: {}` (the designed home for Jira/YouTrack-style keys —
   ADR-010); `number:` is optional display metadata, never identity. The
   template's own frontmatter `status:` is what the index row shows at
   creation (derived, never hardcoded), and its `date:` (or `created:`) is
   the index row's date. Carry one of them: with neither, the date cell
   renders empty — consistently, in both the preview and the written row —
   but an empty date sorts first, so the kind's rows pile up at the top of
   its index and stay there.

4. **Checklist entry** — `scaffold/checklists.json`, consumed by
   `/projectstore:review` and the peer-reviewer skill. English-only by design.

5. **Command prompt** — `commands/<kind>.md`, a prompt (not code) that calls
   `node "$CLAUDE_PLUGIN_ROOT/scripts/draft.mjs" <kind> "$ARGUMENTS"`, previews,
   and gates every write behind AskUserQuestion. Copy `commands/research.md`
   for a plain kind, `commands/adr.md` for one that renders the draft's
   `collision`/`warnings` fields and updates an index, `commands/spec.md`
   for one with status transitions. Its role paragraph must also carry a
   **`Not this:`** clause naming the adjacent kind and pointing at that
   command — a kind whose boundary is not written down is a kind the model
   will guess at, differently each session.

6. **Folder purpose and boundary** — the folder entry's `purpose` and
   `not_this` fields are string **ids**, and the text lives in
   `scaffold/layouts/<layout>.strings.json`, keyed `id -> language -> text`.
   Every bundled language needs an entry: a missing one falls back to `en`,
   and a missing `purpose` falls back to the bare kind — `adr` meaning "adr",
   which is what these fields exist to stop. `purpose` becomes the folder
   README's preamble AND the folder's Purpose cell in the SessionStart
   navigation skeleton, so keep it one sentence, comfortably under 160
   characters once whitespace is collapsed. `not_this` becomes the README's
   own boundary section and is not competing for that cell, so it can be
   longer. Both are checked by doctor's `folder-purpose` check — but only on
   READMEs carrying the `<!-- projectstore:purpose -->` marker that
   `renderFolderReadme` emits, so a hand-written README is never linted.

If the kind introduces **new section headings or inline keywords** that
deterministic checks must recognize (doctor, reconcile, story-section),
register a form per bundled language (en, ru, es, de, fr, zh) in
`scaffold/headings.json` — matchers accept every registered language, so a
ru-headed file lints in an en-bound vault.

## Adding a migration

A migration brings an **existing** vault forward. `scaffold` only writes files
that do not exist, so anything that changes an already-created file needs one.
The registry is `scripts/migrations.mjs`; the runner is `scripts/migrate.mjs`
and `/projectstore:migrate`.

An entry is `{ id, since, title, why, plan(ctx) }`. Two rules decide whether
yours belongs there at all:

1. **It must detect its own completion from vault state.** Nothing records
   "applied": after your migration runs there must be nothing left for `plan` to
   return. That is what makes the mechanism work for a vault three releases
   behind, a vault already current, and a vault someone fixed by hand — with no
   bookkeeping to fall out of step. If you cannot tell whether your change is
   already in place, you do not have a migration; you have a script.
2. **`plan` must be total against any vault state.** Never assume an earlier
   migration ran: `--only` and per-target declines both make that false.

`plan(ctx)` receives `{ vault, project, plugin, layout, vaultCfg, lang, read }`
— `read(path)` is memoized for the invocation, so twenty entries read the vault
once. It returns one entry per target:

```jsonc
{ "rel": "adr/README.md", "path": "…", "kind": "modify",
  "before": "<bytes on disk>", "transform": "(bytes) => bytes | { skip }" }
{ "rel": "ops/README.md", "skipped": "no recognised index-table header" }
```

`transform` must be pure — the runner re-runs it against the file at write time
and applies the result only if it still matches the preview the user approved.
Return a `{ skip: reason }` rather than throwing when you meet a shape you do
not recognize: a skipped target is reported once and never counted as pending,
which is what keeps an unfixable file from becoming a permanent warning.

`kind` is `"modify"`. `create` and `delete` are rejected when the registry
loads — no entry exercises them, and an unexercised write path is worse than an
absent one. Add one together with the tests that cover it.

## Adding a new layout

A layout is a JSON file at `scaffold/layouts/<name>.json` declaring folders,
kinds, commands, agents and (optionally) a kanban block — see
`engineering.json` for the full shape. Every command that maps to a folder
kind needs its template per the checklist above.

A layout also ships its own strings sidecar, `scaffold/layouts/<name>.strings.json`,
holding the `purpose` / `not_this` text its folders reference. It is a sidecar of
the LAYOUT rather than of `templates/<lang>/strings.json` precisely so that a
layout you add can carry its own folder meanings without editing bundled
per-locale files that the next plugin upgrade overwrites. Doctor reports a
missing or empty sidecar as an install issue, because without it every folder's
stated purpose silently degrades to its bare kind.

## Adding a new command

Create `commands/<name>.md` with frontmatter:

```yaml
---
description: One-line summary shown in `/help`.
argument-hint: <expected args>
---
```

Body is a **prompt** for Claude — instructions, not code. To do real work, call
the plugin's scripts via Bash. Always gate writes through `AskUserQuestion`
after showing a preview. Scripts are pure compute (they never write); the
command writes after approval — keep that split.

## Adding a new skill

Skills passively watch the conversation and suggest commands. Create
`skills/<name>/SKILL.md`:

```yaml
---
description: When [trigger condition], suggest [the relevant /projectstore:* command]. Never write to disk directly.
---
```

The `description` field is what Claude uses to decide activation. Be specific
about triggers, and include an Anti-patterns section.

## Adding a new language

Bundled: `en`, `ru`, `es`, `de`, `fr`, `zh`. To add another:

Mirror `templates/en/` to `templates/<lang>/` and translate the bodies.
Frontmatter keys **and their values** stay English (`status: planned` is
machine-read; only prose and table labels get translated). Then register the
language's heading/keyword/index-column forms in `scaffold/headings.json`.
Nothing else is needed to be covered by the suite: `LOCALES` is derived from
`templates/` (via `bundledLocales()` in `lib.mjs`), so creating the directory is
enough to be held to every contract. `templates/<lang>/strings.json` localizes
render-only chrome that no script parses back — the statusline's labels and the
folder README's boundary heading — and every locale must carry the SAME key set
as `en`; the suite asserts it. Folder purposes and boundary rules do NOT live
there: they belong to the layout, in `scaffold/layouts/<layout>.strings.json`.

Skipping the registry does not produce one clean error — it degrades *unevenly*,
which is why the spec exists: an unregistered index header raises a doctor
`index-header` warn while reconcile drops the same index silently; an
unregistered `acceptance` heading is silent everywhere; an unregistered
`implementation_plan` is misdiagnosed as "this done story has no Implementation
Plan"; and `heading(id, lang)` falls back to English, so the lifecycle gates
write English headings into an otherwise translated story.

Constraints the deterministic scripts impose on the translation:

- **Every heading must match *some* registered form.** `insertSection` guards on
  `headingLineRe`, which accepts every registered form of every language — so a
  heading in another locale's form is filled, not duplicated. Only a spelling
  registered nowhere makes the gate append a second section beside it.
- **Use the FIRST form of your language** — that is what `story-section` writes
  when it has to insert, so agreeing with it keeps written and rendered
  documents identical. This is a convention; the gate does not enforce it.
- **No form may match two ids.** Keep the `acceptance` ("Acceptance Criteria")
  and `spec_acceptance` ("Acceptance") headings distinct in your language;
  matching is whole-line, so a prefix relationship is fine but equality is not.
- **The folder-README index header must use the registered column names —
  exactly those four, and no more** — and the separator row under it must stay
  a plain `|---|---|---|---|`. Matching is end-anchored: adding a fifth column
  of your own does not extend the managed table, it stops being one. That is
  deliberate — an unanchored match let the regeneration rewrite your extra
  column away. An unrecognized header is now loud in both directions: doctor
  warns, and a creation into that folder fails its index step on stderr
  (the artifact still lands — see the failure prose in the create commands).
- **Inline grammars carry a keyword and a colon**: the evidence suffix on a
  checked criterion and the `stories:` attribution on a spec acceptance item.
  Both accept the CJK-width colon (`evidenceSuffixRe` / `storiesAttributionRe`
  in `lib.mjs`); if your language punctuates differently, widen them there
  rather than working around it in the template.

Where two spellings are realistic (Russian `ё`/`е`, a French typographic vs
ASCII apostrophe), register both: the first is written, all are accepted. No
test can decide "realistic" — have someone who reads the language check it.

Domain terms follow the language's practitioners, not the dictionary. `epic`
and `story` are localized where the field localizes them (`ru` "Эпик", `es`
"Épica") and left in English where teams say the English word (`de`, `fr`,
`zh`). Nothing reads these table labels, so the only cost of getting it wrong
is that the document reads like a translation.

The bundled set used to be spelled out by hand in four places with nothing
checking they agree. `bundledLocales()` in `lib.mjs` is now the one derivation,
consumed by both the test suite and doctor's `folder-purpose` check; the
remaining prose copies (the registry's `_description`, this page,
`commands/bind.md`) are documentation, not behaviour.

## Vault-side policy

`<vault>/.projectstore.json` (vault root — committed with the vault, survives
clones) carries `spec_policy: required|optional`, `lifecycle_gates: on|off`,
and `spec_policy_since` (ISO-8601). See ADR-007 in the project vault and
`commands/doctor.md` for which checks each key activates.

## Contributing back

PRs welcome at https://github.com/SmartAndPoint/ProjectStore. Prefer one
focused PR per layout / template / skill. Include a sample output in your PR
description.
