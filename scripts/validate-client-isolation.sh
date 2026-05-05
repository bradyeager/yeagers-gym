#!/usr/bin/env bash
# validate-client-isolation.sh
#
# Zero-touch guardrail: ensure Michelle and Lisa client deploys never cross-contaminate.
#
# Invariants enforced:
#   michelle/index.html  -> MUST contain Supabase ref qfprpepqzckymbijeexw and bucket michelle-progress
#                           MUST NOT contain Supabase ref bxyiefzzqcgmnmjvnaax or bucket lisa-progress
#   lisa/index.html      -> MUST contain Supabase ref bxyiefzzqcgmnmjvnaax and bucket lisa-progress
#                           MUST NOT contain Supabase ref qfprpepqzckymbijeexw or bucket michelle-progress
#
# Also checks lisa/vercel.json (and michelle/vercel.json if present) for the wrong client's identifiers.
#
# Exits 0 if all checks pass, 1 on any violation. Designed to run in CI on every PR/push.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MICHELLE_REF="qfprpepqzckymbijeexw"
MICHELLE_BUCKET="michelle-progress"
LISA_REF="bxyiefzzqcgmnmjvnaax"
LISA_BUCKET="lisa-progress"

errors=0

fail() {
  echo "FAIL: $1"
  errors=$((errors + 1))
}

pass() {
  echo "OK:   $1"
}

check_must_contain() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if [[ ! -f "$file" ]]; then
    fail "$file is missing (required for $label check)"
    return
  fi
  if grep -q -- "$needle" "$file"; then
    pass "$file contains $label ($needle)"
  else
    fail "$file is MISSING required $label ($needle)"
  fi
}

check_must_not_contain() {
  local file="$1"
  local needle="$2"
  local label="$3"
  if [[ ! -f "$file" ]]; then
    return
  fi
  # Filter out HTML/JS comments containing the needle. A pragmatic check that
  # ignores lines like "// not lisa-progress" or "<!-- never use ... -->".
  local hits
  hits=$(grep -n -- "$needle" "$file" \
    | grep -v -E '^[0-9]+:\s*(//|<!--|/\*|\*)' \
    || true)
  if [[ -z "$hits" ]]; then
    pass "$file does not leak $label ($needle)"
  else
    fail "$file LEAKS $label ($needle):"
    echo "$hits" | sed 's/^/      /'
  fi
}

echo "==> Michelle invariants"
check_must_contain      "michelle/index.html" "$MICHELLE_REF"    "Michelle Supabase project ref"
check_must_contain      "michelle/index.html" "$MICHELLE_BUCKET" "Michelle storage bucket"
check_must_not_contain  "michelle/index.html" "$LISA_REF"        "Lisa Supabase project ref"
check_must_not_contain  "michelle/index.html" "$LISA_BUCKET"     "Lisa storage bucket"

echo
echo "==> Lisa invariants"
check_must_contain      "lisa/index.html" "$LISA_REF"        "Lisa Supabase project ref"
check_must_contain      "lisa/index.html" "$LISA_BUCKET"     "Lisa storage bucket"
check_must_not_contain  "lisa/index.html" "$MICHELLE_REF"    "Michelle Supabase project ref"
check_must_not_contain  "lisa/index.html" "$MICHELLE_BUCKET" "Michelle storage bucket"

echo
echo "==> Vercel/project config cross-checks"
if [[ -f "lisa/vercel.json" ]]; then
  check_must_not_contain "lisa/vercel.json" "$MICHELLE_REF"    "Michelle Supabase project ref"
  check_must_not_contain "lisa/vercel.json" "$MICHELLE_BUCKET" "Michelle storage bucket"
fi
if [[ -f "michelle/vercel.json" ]]; then
  check_must_not_contain "michelle/vercel.json" "$LISA_REF"    "Lisa Supabase project ref"
  check_must_not_contain "michelle/vercel.json" "$LISA_BUCKET" "Lisa storage bucket"
fi

# Catch any other file under michelle/ that names Lisa, or vice versa.
echo
echo "==> Stray cross-references in client directories"
stray=$(grep -rIl --exclude-dir=assets -- "$LISA_REF\|$LISA_BUCKET" michelle/ 2>/dev/null | grep -v '^michelle/index.html$' || true)
if [[ -n "$stray" ]]; then
  fail "Lisa identifiers found in michelle/ files:"
  echo "$stray" | sed 's/^/      /'
else
  pass "No stray Lisa identifiers in michelle/"
fi
stray=$(grep -rIl --exclude-dir=assets -- "$MICHELLE_REF\|$MICHELLE_BUCKET" lisa/ 2>/dev/null | grep -v '^lisa/index.html$' || true)
if [[ -n "$stray" ]]; then
  fail "Michelle identifiers found in lisa/ files:"
  echo "$stray" | sed 's/^/      /'
else
  pass "No stray Michelle identifiers in lisa/"
fi

echo
if [[ "$errors" -gt 0 ]]; then
  echo "client-isolation check FAILED with $errors violation(s)."
  exit 1
fi
echo "client-isolation check passed."
