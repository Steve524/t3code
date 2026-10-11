# Fork changes

Every edit this fork makes to an upstream file (`FORK.md` rule 11). This is the
checklist for resolving conflicts after `git merge upstream/main`: keep
upstream's version, then re-apply each row.

Files that only exist in the fork (`FORK.md`, this file, anything under a
`fork/` directory, `docs/fork/`) are not listed.

## Touch points

| File        | What changed                                   | Why                                                         |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `AGENTS.md` | Fork notice at the top, pointing to `FORK.md`. | Agents read `AGENTS.md` first and must load the fork rules. |

## Added dependencies

Dependencies added to upstream `package.json` files (`FORK.md` rule 8).

| Package file | Dependency | Why |
| ------------ | ---------- | --- |
|              |            |     |
