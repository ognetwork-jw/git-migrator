/**
 * pre-receive hook installed for the target side (TST-013). It rejects pushes that contain a blob
 * larger than `GM_FAKE_MAX_BLOB_BYTES`, with the wording GitHub prints for "Large files detected"
 * (ADR-0071). The hook only uses POSIX sh, git and awk.
 */
/** File in the bare repository whose presence turns the ref policy call on (see `refPolicyFlag`). */
export const POLICY_FLAG_FILE = 'gm-policy-active';

export const PRE_RECEIVE_HOOK = `#!/bin/sh
refs= body= tmp= out=
# One trap set for every temp file, installed before any of them is created.
trap 'rm -f "$refs" "$body" "$tmp" "$out"' EXIT
trap 'exit 1' HUP INT TERM
refs=$(mktemp)
body=$(mktemp)
tmp=$(mktemp)
out=$(mktemp)
cat > "$refs"
# Hidden refs (refs/pull/*) are read-only whenever a ref policy is configured, protected or not.
if [ -n "\${GM_FAKE_POLICY_URL:-}" ]; then
  while read -r old new ref; do
    case "$ref" in
      refs/pull/*) echo "error: deny updating a hidden ref: $ref" >&2; exit 1 ;;
    esac
  done < "$refs"
fi
# Ref policy (branch protection): ask the server, which asks the fake provider. Skipped when not set.
if [ -n "\${GM_FAKE_POLICY_URL:-}" ] && { [ -z "\${GM_FAKE_POLICY_FLAG:-}" ] || [ -e "\${GIT_DIR:-.}/$GM_FAKE_POLICY_FLAG" ]; }; then
  while read -r old new ref; do
    ff=1
    case "$old" in *[!0]*) case "$new" in *[!0]*) git merge-base --is-ancestor "$old" "$new" 2>/dev/null || ff=0 ;; esac ;; esac
    printf '%s %s %s %s\\n' "$old" "$new" "$ref" "$ff" >> "$body"
  done < "$refs"
  "$GM_FAKE_NODE" -e '
    const fs = require("node:fs");
    fetch(process.argv[1], { method: "POST", headers: { "x-policy-key": process.env.GM_FAKE_POLICY_KEY }, body: fs.readFileSync(process.argv[2]) })
      .then(async (r) => { const t = await r.text(); if (r.status !== 200) { console.error(t.split("\\n").map((m) => "error: " + m).join("\\n")); process.exit(1); } })
      .catch((e) => { console.error("error: ref policy unreachable: " + e.message); process.exit(1); });
  ' "$GM_FAKE_POLICY_URL" "$body" || exit 1
fi
max="\${GM_FAKE_MAX_BLOB_BYTES:-}"
[ -z "$max" ] && exit 0
limit_mb=$(awk -v s="$max" 'BEGIN{printf "%.2f", s/1048576}')
# During the push git quarantines new objects; the repository's own store is the original one.
orig="$(cd "\${GIT_DIR:-.}" && pwd)/objects"
while read -r old new ref; do
  case "$new" in *[!0]*) ;; *) continue ;; esac
  git rev-list --objects "$new" --not --all |
    git cat-file --batch-check='%(objecttype) %(objectsize) %(objectname) %(rest)' |
    awk -v max="$max" '$1 == "blob" && $2 + 0 > max + 0 && !seen[$3]++ {
      p = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ ?/, "", p); printf "%s\\t%s\\t%s\\n", $2, $3, p
    }' >> "$tmp"
done < "$refs"
found=0
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
