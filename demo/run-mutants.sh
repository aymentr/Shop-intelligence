#!/usr/bin/env bash
# Negative control for the demonstration itself: with a critical authorization or retention check
# disabled in the disposable database, the demonstration must FAIL — and fail in the expected scenarios.
set -uo pipefail
cd "$(dirname "$0")/.."
declare -A expect=([grant]='N1|H11|N10' [retention]='N7' [verdict]='N6')
status=0
for m in grant retention verdict; do
  out="$(DEMO_SKIP_DEADLINE=1 DEMO_MUTANT="$m" DEMO_REPORT="${RUNNER_TEMP:-/tmp}/demo-mutant-$m.json" bash demo/run.sh 2>&1)"
  rc=$?
  failed="$(printf '%s\n' "$out" | sed -n 's/^FAIL \([A-Z][0-9]*\) .*/\1/p' | tr '\n' ' ')"
  if [[ $rc -ne 0 ]] && printf '%s\n' "$failed" | grep -Eq "(^| )(${expect[$m]})( |$)"; then
    echo "DEMO-MUTANT $m: KILLED (demonstration failed in: ${failed})"
  else
    echo "DEMO-MUTANT $m: SURVIVED (exit ${rc}; failed: ${failed:-none})"; status=1
  fi
done
exit $status
