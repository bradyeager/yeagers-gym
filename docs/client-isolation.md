# Client Isolation Invariant

This repo hosts two independent client apps under sibling directories. They MUST NOT share Supabase backends or storage buckets, ever. A guardrail script + GitHub Actions workflow enforce this on every PR and push to `main`.

## The two clients

| Client   | Directory   | Supabase project ref     | Storage bucket      | Live URL                                  |
|----------|-------------|--------------------------|---------------------|-------------------------------------------|
| Michelle | `michelle/` | `qfprpepqzckymbijeexw`   | `michelle-progress` | Vercel project `michelle-muscle-mission`  |
| Lisa     | `lisa/`     | `bxyiefzzqcgmnmjvnaax`   | `lisa-progress`     | `lisa.yeagersgym.com`                     |

## The invariant

For every commit on `main` and every PR:

1. `michelle/index.html` **MUST** contain `qfprpepqzckymbijeexw` and `michelle-progress`.
2. `michelle/index.html` **MUST NOT** contain `bxyiefzzqcgmnmjvnaax` or `lisa-progress` (except in single-line comments).
3. `lisa/index.html` **MUST** contain `bxyiefzzqcgmnmjvnaax` and `lisa-progress`.
4. `lisa/index.html` **MUST NOT** contain `qfprpepqzckymbijeexw` or `michelle-progress` (except in single-line comments).
5. No file under `michelle/` may reference Lisa's identifiers; no file under `lisa/` may reference Michelle's.
6. `vercel.json` files in either client directory must not reference the other client's identifiers.

A violation means a deploy could write Michelle's data into Lisa's bucket — or worse, expose one client's data to the other. The CI gate fails the PR before merge so it cannot ship.

## How it's enforced

- `scripts/validate-client-isolation.sh` — bash, no dependencies, runs anywhere `grep` exists.
- `.github/workflows/client-isolation.yml` — runs the script on every PR and every push to `main`.

To run locally before pushing:

```bash
bash scripts/validate-client-isolation.sh
```

Exit code `0` = clean, `1` = at least one violation (printed with file/line).

## What the script ignores

The "must not contain" check tolerates the wrong identifier appearing on a comment-only line (`//`, `<!-- -->`, `/* */`, ` *`). That's so a doc warning like `// never use lisa-progress here` doesn't trip the gate. Real code or string literals containing the wrong identifier will fail.

## When you add a third client

Update `scripts/validate-client-isolation.sh` to add the new client's required/forbidden identifiers, and update this doc. The script is intentionally short and explicit — copy the existing Michelle/Lisa block.

## What this does NOT cover

- Runtime checks. If someone hand-edits the deployed file in Vercel's dashboard, this guardrail can't see it. Always deploy from `main`.
- Secrets. Anon keys are inline in each `index.html` by design (RLS-protected). The guardrail only checks project refs and bucket names.
- Cross-environment leaks. Staging/preview URLs aren't checked — if a separate staging Supabase project is added, extend the script.
