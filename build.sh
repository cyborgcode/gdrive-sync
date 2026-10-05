#!/usr/bin/env bash
# Builds dist/gdrive-sync-installer.sh: one self-extracting file containing everything in src/.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/dist/gdrive-sync-installer.sh"
mkdir -p "$HERE/dist"

PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$HERE/tests" -p "test_*.py" -q
bash -n "$HERE/src/install.sh"
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$HERE/src/gdrive-sync"

{
    cat <<'STUB'
#!/usr/bin/env bash
# gdrive-sync installer: keeps starred Google Drive folders offline on Ubuntu.
# Usage: bash gdrive-sync-installer.sh [--help]
set -euo pipefail
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
sed -n '/^__PAYLOAD_BELOW__$/,$p' "$0" | tail -n +2 | base64 -d | tar -xzf - -C "$WORK"
status=0
GDS_INSTALLER_NAME="$(basename "$0")" bash "$WORK/install.sh" "$@" || status=$?
exit "$status"
__PAYLOAD_BELOW__
STUB
    tar -C "$HERE/src" --exclude=__pycache__ --owner=0 --group=0 --numeric-owner --sort=name -czf - . | base64 -w 76
} > "$OUT.tmp"
chmod 755 "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1)), sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
