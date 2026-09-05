#!/bin/sh
# Install Orrery's shipped custom-agent templates without changing Codex config.

set -eu

usage() {
  cat <<'EOF'
Usage: install-agents.sh [--target-dir PATH] [--check]

Install Orrery's three current custom-agent templates into the target directory.
Normal mode also migrates only exact superseded companion files: it replaces a
recognised legacy Terra template and removes the legacy Luna template. It never
overwrites a modified, nonregular, or symlinked destination.

Without --target-dir, the target is "$CODEX_HOME/agents" when CODEX_HOME is already
set, otherwise "$HOME/.codex/agents".

Options:
  --target-dir PATH  Explicit destination directory (absolute or relative).
  --check            Verify that Astra, Sol, and Terra match exactly and no legacy
                     Luna file remains; do not create, replace, or remove anything.
  --help             Show this help text.
EOF
}

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

report_preflight_error() {
  printf '%s\n' "ERROR: $*" >&2
  preflight_failed=1
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

sha256_file() {
  shasum -a 256 "$1" 2>/dev/null | awk 'NF >= 1 && length($1) == 64 { print $1; exit }'
}

# $3 is a space-separated set of accepted superseded digests. A destination that
# matches any of them is migratable; anything else that differs is a conflict. It is
# a set because each shipped revision of a template adds one: a user upgrading from
# any prior exact release must still migrate, and matching only the newest would
# refuse every older install.
classify_current_or_legacy() {
  destination=$1
  template=$2
  legacy_digests=$3

  if ! path_exists "$destination"; then
    printf '%s\n' missing
  elif [ -L "$destination" ] || [ ! -f "$destination" ]; then
    printf '%s\n' unsafe
  elif cmp -s "$template" "$destination"; then
    printf '%s\n' current
  else
    digest=$(sha256_file "$destination")
    matched_legacy=0
    if [ -n "$digest" ]; then
      for candidate in $legacy_digests; do
        [ "$digest" = "$candidate" ] || continue
        matched_legacy=1
        break
      done
    fi
    if [ "$matched_legacy" -eq 1 ]; then
      printf '%s\n' legacy
    elif [ -z "$digest" ]; then
      printf '%s\n' unreadable
    else
      printf '%s\n' conflict
    fi
  fi
}

classify_legacy_luna() {
  destination=$1

  if ! path_exists "$destination"; then
    printf '%s\n' missing
  elif [ -L "$destination" ] || [ ! -f "$destination" ]; then
    printf '%s\n' unsafe
  else
    digest=$(sha256_file "$destination")
    if [ "$digest" = "$legacy_luna_sha256" ]; then
      printf '%s\n' legacy
    elif [ -z "$digest" ]; then
      printf '%s\n' unreadable
    else
      printf '%s\n' conflict
    fi
  fi
}

same_state() {
  label=$1
  expected=$2
  actual=$3
  [ "$expected" = "$actual" ] || fail "$label changed after preflight; no further destination files were changed."
}

install_missing() {
  template=$1
  destination=$2
  staged=''

  if path_exists "$destination"; then
    fail "destination changed after preflight and will not be overwritten: $destination"
  fi

  staged=$(mktemp "$target_dir/.orrery-agent.XXXXXX") || fail "could not stage template for installation: $destination"
  if ! cp "$template" "$staged"; then
    rm -f "$staged"
    fail "could not stage template for installation: $destination"
  fi

  if ! ln "$staged" "$destination"; then
    rm -f "$staged"
    fail "destination changed after preflight and will not be overwritten: $destination"
  fi

  rm -f "$staged" || fail "could not remove staged template after installation: $staged"
  printf '%s\n' "INSTALLED: $destination"
}

replace_legacy_terra() {
  staged=''

  [ "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256")" = legacy ] ||
    fail "legacy Terra destination changed after preflight and will not be replaced: $terra_destination"

  staged=$(mktemp "$target_dir/.orrery-agent.XXXXXX") || fail "could not stage migrated Terra template: $terra_destination"
  if ! cp "$terra_template" "$staged"; then
    rm -f "$staged"
    fail "could not stage migrated Terra template: $terra_destination"
  fi

  [ "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256")" = legacy ] || {
    rm -f "$staged"
    fail "legacy Terra destination changed after preflight and will not be replaced: $terra_destination"
  }

  if ! mv -f "$staged" "$terra_destination"; then
    rm -f "$staged"
    fail "could not replace exact legacy Terra template: $terra_destination"
  fi

  printf '%s\n' "MIGRATED: $terra_destination"
}

remove_legacy_luna() {
  [ "$(classify_legacy_luna "$luna_destination")" = legacy ] ||
    fail "legacy Luna destination changed after preflight and will not be removed: $luna_destination"
  rm "$luna_destination" || fail "could not remove exact legacy Luna template: $luna_destination"
  printf '%s\n' "REMOVED LEGACY: $luna_destination"
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
template_dir=$script_dir/../agents

if [ -n "${CODEX_HOME-}" ]; then
  target_dir=$CODEX_HOME/agents
else
  [ -n "${HOME-}" ] || fail "HOME is unset and CODEX_HOME was not supplied; pass --target-dir explicitly."
  target_dir=$HOME/.codex/agents
fi

check_only=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      [ "$#" -ge 2 ] || fail "--target-dir requires a path."
      [ -n "$2" ] || fail "--target-dir requires a non-empty path."
      case "$2" in
        --*) fail "--target-dir path must be explicit; prefix an option-like relative name with ./ or use an absolute path." ;;
      esac
      target_dir=$2
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1 (run with --help for usage)."
      ;;
  esac
done

case "$target_dir" in
  /*) ;;
  *) target_dir=$(pwd -P)/$target_dir ;;
esac

case "$target_dir" in
  /|//) fail "refusing to use the filesystem root as an agent target directory." ;;
esac

astra_file=orrery-astra-implementer.toml
terra_file=orrery-terra-implementer.toml
sol_file=orrery-sol-reviewer.toml
luna_file=orrery-luna-implementer.toml
astra_template=$template_dir/$astra_file
terra_template=$template_dir/$terra_file
sol_template=$template_dir/$sol_file
astra_destination=$target_dir/$astra_file
terra_destination=$target_dir/$terra_file
sol_destination=$target_dir/$sol_file
luna_destination=$target_dir/$luna_file

# Immutable byte digests of superseded shipped templates, each calculated from the
# tag that shipped it:
#   git show v0.2.0:plugins/orrery/agents/orrery-luna-implementer.toml | shasum -a 256
#   git show v0.2.0:plugins/orrery/agents/orrery-terra-implementer.toml | shasum -a 256
#   git show v0.6.0:plugins/orrery/agents/orrery-terra-implementer.toml | shasum -a 256
# The v0.6.0 Terra digest is listed because Terra was rewritten from the sole
# implementation lane into the routine lane when Astra took high-complexity work.
# Without it every existing exact install would classify as conflict and be refused.
legacy_luna_sha256=95ed97eadcf914963629ac30ffb20996e436851007eecab33d7ef958223ec320
legacy_terra_sha256="73cde2e7656fa1967baecdab38d2d89b2f73c6054097cf445351eb5f54678cb5 76affd32678c812d3c6e6b855467917536f412bd987e58ab6b52ac26700c9e1b"

for template in "$astra_template" "$terra_template" "$sol_template"; do
  [ -f "$template" ] && [ ! -L "$template" ] ||
    fail "shipped template is missing or not a regular file: $template"
done

preflight_failed=0
if path_exists "$target_dir"; then
  if [ -L "$target_dir" ] || [ ! -d "$target_dir" ]; then
    report_preflight_error "target directory is not a real directory: $target_dir"
  fi
fi

astra_state=$(classify_current_or_legacy "$astra_destination" "$astra_template" '')
terra_state=$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256")
sol_state=$(classify_current_or_legacy "$sol_destination" "$sol_template" '')
luna_state=$(classify_legacy_luna "$luna_destination")

if [ "$check_only" -eq 1 ]; then
  [ "$astra_state" = current ] ||
    report_preflight_error "Astra template is $astra_state, not the current exact file: $astra_destination"
  [ "$terra_state" = current ] ||
    report_preflight_error "Terra template is $terra_state, not the current exact file: $terra_destination"
  [ "$sol_state" = current ] ||
    report_preflight_error "Sol template is $sol_state, not the current exact file: $sol_destination"
  [ "$luna_state" = missing ] ||
    report_preflight_error "legacy Luna file remains or is unsafe: $luna_destination"
else
  case "$astra_state" in
    current|missing) ;;
    *) report_preflight_error "Astra destination is $astra_state and will not be replaced: $astra_destination" ;;
  esac
  case "$terra_state" in
    current|legacy|missing) ;;
    *) report_preflight_error "Terra destination is $terra_state and will not be replaced: $terra_destination" ;;
  esac
  case "$sol_state" in
    current|missing) ;;
    *) report_preflight_error "Sol destination is $sol_state and will not be replaced: $sol_destination" ;;
  esac
  case "$luna_state" in
    missing|legacy) ;;
    *) report_preflight_error "legacy Luna destination is $luna_state and will not be removed: $luna_destination" ;;
  esac
fi

[ "$preflight_failed" -eq 0 ] || exit 1

if [ "$check_only" -eq 1 ]; then
  printf '%s\n' "CHECK PASSED: Astra, Sol, and Terra exactly match $template_dir; no legacy Luna file remains."
  exit 0
fi

if [ ! -d "$target_dir" ]; then
  mkdir -p "$target_dir" || fail "could not create target directory: $target_dir"
fi
[ -d "$target_dir" ] && [ ! -L "$target_dir" ] ||
  fail "target directory changed after preflight: $target_dir"

same_state Astra "$astra_state" "$(classify_current_or_legacy "$astra_destination" "$astra_template" '')"
same_state Terra "$terra_state" "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256")"
same_state Sol "$sol_state" "$(classify_current_or_legacy "$sol_destination" "$sol_template" '')"
same_state "legacy Luna" "$luna_state" "$(classify_legacy_luna "$luna_destination")"

case "$astra_state" in
  missing) install_missing "$astra_template" "$astra_destination" ;;
  current) printf '%s\n' "ALREADY CURRENT: $astra_destination" ;;
esac

case "$terra_state" in
  missing) install_missing "$terra_template" "$terra_destination" ;;
  legacy) replace_legacy_terra ;;
  current) printf '%s\n' "ALREADY CURRENT: $terra_destination" ;;
esac

case "$sol_state" in
  missing) install_missing "$sol_template" "$sol_destination" ;;
  current) printf '%s\n' "ALREADY CURRENT: $sol_destination" ;;
esac

if [ "$luna_state" = legacy ]; then
  remove_legacy_luna
fi

[ "$(classify_current_or_legacy "$astra_destination" "$astra_template" '')" = current ] ||
  fail "post-install exactness check failed: $astra_destination"
[ "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256")" = current ] ||
  fail "post-install exactness check failed: $terra_destination"
[ "$(classify_current_or_legacy "$sol_destination" "$sol_template" '')" = current ] ||
  fail "post-install exactness check failed: $sol_destination"
[ "$(classify_legacy_luna "$luna_destination")" = missing ] ||
  fail "post-install legacy removal check failed: $luna_destination"

printf '%s\n' "INSTALL PASSED: Astra, Sol, and Terra exactly match $template_dir; no legacy Luna file remains."
