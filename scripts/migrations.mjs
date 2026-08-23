#!/usr/bin/env node
// projectstore — migrations.mjs
// The registry: an ordered list of named, idempotent transforms that bring an
// EXISTING vault forward. Pure — every entry reads and returns a plan; the
// runner (migrate.mjs) is the only thing that applies one.
//
// SPEC-PS-11. The two rules that keep this a mechanism rather than a pile of
// one-off scripts:
//
//   1. A migration MUST detect its own completion from vault state. Nothing
//      records "applied": after it runs there is nothing left to change, and
//      that is the only fact worth trusting. An entry that cannot tell whether
//      it already ran does not belong here.
//   2. Every plan MUST be total against any vault state. `--only` and
//      per-target declines both make "an earlier migration already ran" false,
//      and a chain that corrupts a file without erroring is worse than one that
//      cannot be expressed.
//
// A target is one of three states, never two: `pending` (a change), `skipped`
// (a stated reason it cannot act), or absent from the plan entirely (done).
// Collapsing `skipped` into either of the others gives you a permanent warning
// nobody can clear, or a half-migrated vault nobody is told about.
//
// Plan entry shape:
//   { rel, path, kind: "modify", before, transform }   — actionable
//   { rel, path, skipped: "<reason>" }                 — reported, never counted
// `transform` is `(bytes) => bytes | { skip: reason }` and must be PURE: the
// runner re-runs it against the bytes on disk at write time and compares.

import { join } from "node:path";
import {
  loadTemplate,
  renderFolderReadme,
  findManagedIndex,
  purposeMarkerState,
  bundledLocales,
} from "./lib.mjs";

// Which bundled language a README is already written in — asked of the file,
// not of the reader's config. A teammate bound to `en` migrating a `ru` vault
// must not staple an English preamble above `## Индекс`.
function readmeLanguage(before, layout, folder, fallback) {
  // The index heading alone does not identify a language — `## Index` is the
  // form in de, en AND fr — so a heading lookup hands whichever binding the
  // READER happens to have to a vault written in another. Score each locale by
  // how much of its folder-readme template is literally present instead: the
  // footer and the index comment differ in all six, which separates the three
  // that share a heading. The binding only breaks ties.
  const text = String(before ?? "");
  let best = fallback;
  let bestScore = -1;
  for (const lang of bundledLocales()) {
    let tpl;
    try {
      tpl = loadTemplate(lang, "folder-readme");
    } catch {
      continue;
    }
    let score = 0;
    for (const line of tpl.split("\n")) {
      const t = line.trim();
      if (!t || t.includes("{{")) continue;
      if (text.includes(t)) score += 1;
    }
    if (lang === fallback) score += 0.5;
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return best;
}

// Everything the layout renders above the index heading, then the original
// from ITS index heading down, byte for byte. NOT the first `## ` — that is
// `## Not this`, so cutting there would delete the boundary section this
// migration exists to install and leave a managed marker above nothing.
function spliceFolderReadme(bytes, layout, folder, lang) {
  const original = findManagedIndex(bytes);
  if (original.unusable) return { skip: original.unusable };
  if (original.sectionStart == null) {
    return { skip: "the index table has no `## ` heading above it to splice at" };
  }
  let rendered;
  try {
    rendered = findManagedIndex(renderFolderReadme(layout, folder, lang));
  } catch (e) {
    return { skip: `cannot render the layout README: ${e.message}` };
  }
  if (rendered.unusable || rendered.sectionStart == null) {
    return { skip: `the ${lang} folder-readme template has no recognisable index table` };
  }
  const head = rendered.lines.slice(0, rendered.sectionStart);
  const tail = original.lines.slice(original.sectionStart);
  return [...head, ...tail].join("\n");
}

export const MIGRATIONS = [
  {
    id: "folder-readme-purpose",
    since: "0.25.0",
    title: "Folder READMEs state the layout's purpose and boundary",
    why:
      "Before v0.25 a folder's stated purpose was prose the model composed at "
      + "scaffold time, and SessionStart injects that prose every session as what "
      + "the folder is for. This replaces the preamble with the layout's own text "
      + "and adds the `Not this` boundary section, leaving the index table and "
      + "every line below it untouched.",
    plan(ctx) {
      const out = [];
      for (const folder of ctx.layout.folders) {
        // All three conditions, matching checkFolderPurpose: a folder that does
        // not declare a README is not ours even if one happens to be there, and
        // a MISSING README is checkIndexes' business — creating one here would
        // bypass /projectstore:scaffold's gate.
        if (folder.readme !== true) continue;
        const rel = `${folder.path}/README.md`;
        const path = join(ctx.vault, folder.path, "README.md");
        const before = ctx.read(path);
        if (before == null) continue;
        // `mine` — the owner claimed this wording; never plan over it.
        if (purposeMarkerState(before) === "mine") continue;
        const lang = readmeLanguage(before, ctx.layout, folder, ctx.lang);
        const after = spliceFolderReadme(before, ctx.layout, folder, lang);
        if (after && after.skip) {
          out.push({ rel, path, skipped: after.skip });
          continue;
        }
        // Convergence on layout state, NOT presence of the marker this same
        // migration plants. Detecting its own stamp would make the marker an
        // "applied" record wearing a comment's clothes — and would leave a
        // `managed` README whose preamble drifted permanently warned at by
        // doctor with no repair path, which is the steady state of every vault
        // a year from now.
        if (after === before) continue;
        out.push({
          rel,
          path,
          kind: "modify",
          lang,
          before,
          transform: (bytes) => spliceFolderReadme(bytes, ctx.layout, folder, lang),
        });
      }
      return out;
    },
  },
];

// `create` and `delete` are both rejected: neither is exercised by any entry,
// and an unexercised write path is worse than an absent one. The first entry
// that needs one adds it together with its tests.
export const SUPPORTED_KINDS = ["modify"];

export function assertRegistryShape(list = MIGRATIONS) {
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m.id !== "string" || !m.id) throw new Error("migration without an id");
    if (seen.has(m.id)) throw new Error(`duplicate migration id: ${m.id}`);
    seen.add(m.id);
    if (typeof m.plan !== "function") throw new Error(`${m.id}: plan is not a function`);
    if (typeof m.since !== "string") throw new Error(`${m.id}: since is not a string`);
    // Declared up front, so an unsupported kind is a load-time error the author
    // sees once — not a per-invocation throw that reaches users as a permanent
    // doctor warning and a nonzero exit on every otherwise-successful run.
    for (const k of m.kinds || ["modify"]) {
      if (!SUPPORTED_KINDS.includes(k)) {
        throw new Error(`${m.id}: unsupported change kind "${k}" — supported: ${SUPPORTED_KINDS.join(", ")}`);
      }
    }
  }
  return list;
}

// Per TARGET, and it degrades that target rather than throwing: contract 8 says
// siblings still apply, and a throw from inside a .map over the plan discards
// every one of them.
export function checkChangeShape(id, entry) {
  if (!entry || typeof entry.rel !== "string" || !entry.rel) {
    return { rel: String(entry && entry.rel), skipped: `${id}: change without a rel` };
  }
  if (entry.rel.startsWith("/") || entry.rel.split(/[/\\]/).includes("..")) {
    return { rel: entry.rel, skipped: `${id}: rel must be vault-relative and contain no ".."` };
  }
  if (entry.skipped) return entry;
  if (!SUPPORTED_KINDS.includes(entry.kind)) {
    return { rel: entry.rel, skipped: `unsupported change kind "${entry.kind}" — supported: ${SUPPORTED_KINDS.join(", ")}` };
  }
  if (typeof entry.transform !== "function") {
    return { rel: entry.rel, skipped: `${id}: change for ${entry.rel} carries no transform` };
  }
  return entry;
}
