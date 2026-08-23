#!/usr/bin/env node
// projectstore — migrate.mjs
// Brings an EXISTING vault forward. Shaped like reconcile.mjs on purpose: with
// no flags it computes a plan and changes nothing, so the command can preview
// before its approval gate; `--write` applies.
//
// CLI:
//   migrate.mjs                       plan every migration, JSON on stdout
//   migrate.mjs --write               apply the plan
//   migrate.mjs --only <sel>[,…]      narrow to <id> or <id>:<vault-relative-path>
//   migrate.mjs --decline <id>:<rel>  stop offering one target, permanently
//
// Exit code 0 when everything applied or there was nothing to do; nonzero when
// any target reported a conflict or an error, so a headless caller can tell.
// "Nothing pending" is a success, with `pending: []` and no drama.
//
// Applying re-runs each transform against the bytes on disk at write time and
// compares the result to what was previewed. That is reconcile's recompute
// discipline rather than a frozen compare-and-swap: since v0.22 every artifact
// creation regenerates its folder index automatically, so a sibling session
// adding one row is the likeliest thing to happen between plan and write, and
// the comparison is scoped to the region above the index heading — the part the
// transform owns and the user actually consented to.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readConfig,
  readVaultConfig,
  loadLayout,
  projectRoot,
  pluginRoot,
  writeFileAtomic,
  ensureMigrationsDir,
  findManagedIndex,
} from "./lib.mjs";
import { MIGRATIONS, assertRegistryShape, assertChangeShape } from "./migrations.mjs";

function die(msg, code = 1) {
  process.stderr.write(`projectstore/migrate: ${msg}\n`);
  process.exit(code);
}

const declinedPath = (vault, id) =>
  join(vault, ".projectstore", "migrations", id, "declined");

function readDeclined(vault, id) {
  try {
    return new Set(readFileSync(declinedPath(vault, id), "utf8")
      .split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// The region a folder-README transform owns: everything above the index
// heading. Below it the bytes are copied through by construction, so a change
// there cannot invalidate the consent the preview obtained.
function ownedRegion(bytes) {
  const f = findManagedIndex(bytes);
  if (f.unusable || f.sectionStart == null) return String(bytes ?? "");
  return f.lines.slice(0, f.sectionStart).join("\n");
}

export function buildMigrationContext(cfg) {
  const cache = new Map();
  return {
    vault: cfg.vault_path,
    project: projectRoot(),
    plugin: pluginRoot(),
    layout: loadLayout(cfg.layout),
    vaultCfg: readVaultConfig(cfg.vault_path),
    lang: cfg.language || "en",
    // Memoized for THIS invocation only, so a registry of twenty entries walks
    // the vault once. Nothing survives the process, so nothing can go stale.
    read(path) {
      if (cache.has(path)) return cache.get(path);
      let text = null;
      try {
        text = existsSync(path) ? readFileSync(path, "utf8") : null;
      } catch {
        text = null;
      }
      cache.set(path, text);
      return text;
    },
  };
}

function parseSelection(only) {
  if (!only) return null;
  const sel = new Map();
  for (const part of String(only).split(",").map((p) => p.trim()).filter(Boolean)) {
    const [id, target] = part.split(":");
    if (!MIGRATIONS.some((m) => m.id === id)) {
      die(`unknown migration "${id}" — known: ${MIGRATIONS.map((m) => m.id).join(", ")}`);
    }
    if (!sel.has(id)) sel.set(id, new Set());
    if (target) sel.get(id).add(target);
  }
  return sel;
}

export function planAll(ctx, selection = null) {
  assertRegistryShape();
  const report = [];
  for (const m of MIGRATIONS) {
    if (selection && !selection.has(m.id)) continue;
    const wanted = selection ? selection.get(m.id) : null;
    const declined = readDeclined(ctx.vault, m.id);
    let entries;
    try {
      entries = m.plan(ctx).map((e) => assertChangeShape(m.id, e));
    } catch (e) {
      report.push({ id: m.id, since: m.since, title: m.title, error: e.message,
        pending: [], skipped: [] });
      continue;
    }
    const pending = [];
    const skipped = [];
    for (const e of entries) {
      if (wanted && wanted.size && !wanted.has(e.rel)) continue;
      if (declined.has(e.rel)) { skipped.push({ rel: e.rel, reason: "declined" }); continue; }
      if (e.skipped) { skipped.push({ rel: e.rel, reason: e.skipped }); continue; }
      pending.push(e);
    }
    report.push({ id: m.id, since: m.since, title: m.title, why: m.why, pending, skipped });
  }
  return report;
}

function preview(entry) {
  const after = entry.transform(entry.before);
  return after && after.skip ? { skip: after.skip } : { after };
}

// Exported for the same reason writeIndexWithRetry is: the conflict path is
// only reachable by injecting a stale `before`, and a path nothing can reach
// from a test is a path nothing checks.
export function applyOne(ctx, id, entry) {
  const shown = preview(entry);
  if (shown.skip) return { rel: entry.rel, applied: false, skipped: shown.skip };
  let current;
  try {
    current = readFileSync(entry.path, "utf8");
  } catch (e) {
    return { rel: entry.rel, applied: false, error: e.message };
  }
  const recomputed = entry.transform(current);
  if (recomputed && recomputed.skip) {
    return { rel: entry.rel, applied: false, skipped: recomputed.skip };
  }
  if (ownedRegion(recomputed) !== ownedRegion(shown.after)) {
    return {
      rel: entry.rel,
      applied: false,
      conflict: "the file changed under us in the region this migration owns — re-run to see a fresh preview",
    };
  }
  if (recomputed === current) return { rel: entry.rel, applied: false, unchanged: true };
  // Archive first: a failed archive aborts this file rather than proceeding
  // with no way back. The directory carries its own `*` ignore.
  try {
    const dir = ensureMigrationsDir(ctx.vault, id);
    writeFileAtomic(join(dir, entry.rel.replace(/[/\\]/g, "__")), current);
  } catch (e) {
    return { rel: entry.rel, applied: false, error: `pre-image not archived: ${e.message}` };
  }
  try {
    writeFileAtomic(entry.path, recomputed);
  } catch (e) {
    return { rel: entry.rel, applied: false, error: e.message };
  }
  return { rel: entry.rel, applied: true };
}

export function runMigrate({ write = false, only = null, decline = null } = {}) {
  const cfg = readConfig();
  if (!cfg) die("No projectstore config. Run /projectstore:bind <vault-path> first.");
  if (!cfg.vault_path || !existsSync(cfg.vault_path)) {
    die(`Vault not found at ${cfg.vault_path}`);
  }
  const ctx = buildMigrationContext(cfg);

  if (decline) {
    const [id, rel] = String(decline).split(":");
    if (!MIGRATIONS.some((m) => m.id === id)) die(`unknown migration "${id}"`);
    if (!rel) die(`--decline needs <id>:<vault-relative-path>`);
    const current = readDeclined(ctx.vault, id);
    current.add(rel);
    const dir = ensureMigrationsDir(ctx.vault, id);
    writeFileAtomic(join(dir, "declined"), [...current].sort().join("\n") + "\n");
    return { declined: { id, rel }, path: declinedPath(ctx.vault, id) };
  }

  const selection = parseSelection(only);
  const report = planAll(ctx, selection);
  if (!write) {
    return {
      vault: ctx.vault,
      write: false,
      migrations: report.map((r) => ({
        id: r.id, since: r.since, title: r.title, why: r.why, error: r.error,
        skipped: r.skipped,
        pending: r.pending.map((e) => {
          const shown = preview(e);
          return shown.skip
            ? { rel: e.rel, skipped: shown.skip }
            : { rel: e.rel, path: e.path, lang: e.lang, before: e.before, after: shown.after };
        }),
      })),
    };
  }
  const results = report.map((r) => ({
    id: r.id,
    skipped: r.skipped,
    error: r.error,
    results: r.pending.map((e) => applyOne(ctx, r.id, e)),
  }));
  const failed = results.some((r) => r.error
    || r.results.some((x) => x.error || x.conflict));
  return { vault: ctx.vault, write: true, migrations: results, failed };
}

function main() {
  const argv = process.argv.slice(2);
  let write = false;
  let only = null;
  let decline = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") write = true;
    else if (a === "--only") only = argv[++i];
    else if (a.startsWith("--only=")) only = a.slice("--only=".length);
    else if (a === "--decline") decline = argv[++i];
    else if (a.startsWith("--decline=")) decline = a.slice("--decline=".length);
    else die(`unknown flag: ${a}`);
  }
  if (only === undefined) die("--only requires a value");
  if (decline === undefined) die("--decline requires a value");
  const out = runMigrate({ write, only, decline });
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (out.failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
