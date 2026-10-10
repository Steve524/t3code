# Fork rules: Steve524/t3code

This repo is a fork of https://github.com/pingdotgg/t3code (upstream).
Upstream moves fast, and I regularly merge `upstream/main` into this fork.
Every change here must be structured so those merges stay easy. Before editing
any file, ask: "Will this conflict the next time upstream touches it?"

Everything in AGENTS.md still applies, with these overrides:

- "We", "us", and "maintainers" in AGENTS.md mean me (Steve), not the upstream team.
- PRs target Steve524/t3code, never pingdotgg/t3code, unless I explicitly say otherwise.
- "Hit every surface" still applies, but fork features may be scoped to fewer
  surfaces. Say which surfaces a feature supports and which it skips.

## Where fork code lives

Put fork-only code in dedicated `fork/` directories next to the upstream code
it extends, not mixed into upstream files:

- `apps/server/src/fork/` for server logic, reactors, and provider additions
- `apps/web/src/fork/` for web UI (components, routes, hooks)
- `apps/mobile/src/fork/` for mobile UI
- `apps/desktop/src/fork/` for Electron-only additions
- `packages/contracts/src/fork/` for new wire schemas
- `packages/client-runtime/src/fork/` for client logic shared by web and mobile
- `docs/fork/` for fork documentation (do not edit upstream docs to describe fork features)

If a directory doesn't exist yet, create it.

## Rules

1. **Add, don't modify.** New behavior goes in new files under `fork/`.
   Upstream files are only touched to wire fork code in.
2. **Wiring edits must be tiny.** When an upstream file must change, the edit
   should be a single import plus a single registration or call: adding a
   reactor to a layer, a route to the router, an entry to a union, a menu item
   that renders a fork component. Never inline feature logic into upstream files.
3. **Mark every edit to an upstream file** so it's easy to find in conflicts:
   `// FORK: <reason>` for single lines, or `// FORK-BEGIN: <reason>` ...
   `// FORK-END` for blocks.
4. **No drive-by changes to upstream code.** No reformatting, reordering
   imports, renames, lint fixes, refactors, or type tightening in upstream files
   unless that is the explicit task.
5. **Never rename, move, or delete upstream files**, and don't change existing
   upstream function signatures, schema fields, or event shapes. Extend them
   (new optional fields, new event types, new schemas under `fork/`) instead.
6. **Contracts and events.** Wire and event changes are the highest-conflict
   area. Prefer new schemas and new event/command types in
   `packages/contracts/src/fork/` over modifying existing ones. If an existing
   union must include a fork type, that's a one-line marked edit.
7. **Providers.** A new provider is a new adapter in fork directories. Changes
   to existing adapters must be minimal, marked, and justified.
8. **Dependencies.** Avoid adding dependencies to upstream `package.json` files
   when possible. If one is needed, note it in `FORK_CHANGES.md`. Don't hand-edit
   `pnpm-lock.yaml`; regenerate it with `vp i`.
9. **Never touch `.repos/`, upstream `.github/` workflows, or upstream agent
   config** (`.claude/`, `.codex/`, `.cursor/`, `.agents/`). Put fork-specific
   agent skills or config in new, fork-named files.
10. **Tests for fork features go in new test files** under `fork/`, not appended
    to upstream test files.
11. **Log every upstream touch point** in `FORK_CHANGES.md`: file path, what
    changed, and why. Keep it current. It's the checklist for resolving conflicts.

If a task can't be done without substantial changes to upstream files, stop
and explain the tradeoff and the smallest possible touch points before writing code.

## Syncing with upstream

When I ask you to sync:

1. `git fetch upstream && git merge upstream/main` (merge, don't rebase, unless I say otherwise).
2. Resolve conflicts by keeping upstream's version and re-applying the `FORK:`
   marked edits listed in `FORK_CHANGES.md`.
3. Run targeted typecheck and tests for `fork/` code and every touch point.
4. Update `FORK_CHANGES.md` if any touch point moved.
