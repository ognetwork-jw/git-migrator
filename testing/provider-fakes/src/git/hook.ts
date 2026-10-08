/**
 * pre-receive hook installed for the target side (TST-013). It rejects pushes that contain a blob
 * larger than `GM_FAKE_MAX_BLOB_BYTES`, with the wording GitHub prints for "Large files detected"
 * (ADR-0071). The hook only uses POSIX sh, git and awk.
 */
export const PRE_RECEIVE_HOOK = `#!/bin/sh
max="\${GM_FAKE_MAX_BLOB_BYTES:-}"
[ -z "$max" ] && exit 0
limit_mb=$(awk -v s="$max" 'BEGIN{printf "%.2f", s/1048576}')
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
# During the push git quarantines new objects; the repository's own store is the original one.
orig="$(cd "\${GIT_DIR:-.}" && pwd)/objects"
while read -r old new ref; do
  case "$new" in *[!0]*) ;; *) continue ;; esac
  git rev-list --objects "$new" --not --all |
    git cat-file --batch-check='%(objecttype) %(objectsize) %(objectname) %(rest)' |
    awk -v max="$max" '$1 == "blob" && $2 + 0 > max + 0 && !seen[$3]++ {
      p = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ ?/, "", p); printf "%s\\t%s\\t%s\\n", $2, $3, p
    }' >> "$tmp"
done
found=0
out=$(mktemp)
trap 'rm -f "$tmp" "$out"' EXIT
while IFS="$(printf '\\t')" read -r size oid path; do
  # A blob that is already in the repository's own store (for example after a branch delete) is not new.
  if (unset GIT_ALTERNATE_OBJECT_DIRECTORIES; GIT_OBJECT_DIRECTORY="$orig" git cat-file -e "$oid" 2>/dev/null); then
    continue
  fi
  found=1
  mb=$(awk -v s="$size" 'BEGIN{printf "%.2f", s/1048576}')
  [ -n "$path" ] || path="$oid"
  echo "error: File $path is $mb MB; this exceeds GitHub's file size limit of $limit_mb MB" >> "$out"
done < "$tmp"
[ "$found" = 1 ] || exit 0
echo "error: Trace: 0000000000000000000000000000000000000000000000000000000000000000" >&2
echo "error: See https://gh.io/lfs for more information." >&2
cat "$out" >&2
echo "error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com." >&2
exit 1
`;
