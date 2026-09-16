#!/usr/bin/env bash
# Hits the endpoint N times and reports the distribution, to tell a steady block from an
# intermittent one. Sends no credential, so every reply is a rejection and no job runs.
#
#   ./test/probe.sh                       20 probes, 1s apart, against UAT
#   ./test/probe.sh 50 0.5                50 probes, 0.5s apart
#   URL=https://host/ctx/ws-cj/job/due ./test/probe.sh
URL="${URL:-https://www-uat-33.mhcasia.net/mhc/ws-cj/job/due}"
N="${1:-20}"
GAP="${2:-1}"

echo "probing $URL"
echo "source IP: $(curl -s --max-time 8 https://ifconfig.me 2>/dev/null || echo unknown)"
echo "$N probes, ${GAP}s apart, 10s timeout each"
echo

ok=0; fail=0; times=""
for i in $(seq 1 "$N"); do
    out=$(curl -sS -o /dev/null -w "%{http_code} %{time_total} %{time_connect}" \
          --max-time 10 -X POST -H "Content-Length: 0" "$URL" 2>&1)
    code=$(echo "$out" | awk '{print $1}')
    tot=$(echo  "$out" | awk '{print $2}')
    con=$(echo  "$out" | awk '{print $3}')
    if [ "$code" = "000" ] || [ -z "$code" ]; then
        fail=$((fail+1)); printf "%3d  FAIL  %s\n" "$i" "$(echo "$out" | tr '\n' ' ' | cut -c1-70)"
    else
        ok=$((ok+1)); times="$times $tot"
        printf "%3d  HTTP %s  total=%ss connect=%ss\n" "$i" "$code" "$tot" "$con"
    fi
    sleep "$GAP"
done

echo
echo "reached $ok / $N     failed $fail / $N"
[ -n "$times" ] && echo "$times" | tr ' ' '\n' | grep -v '^$' | sort -n | \
  awk '{a[NR]=$1} END {printf "latency  min=%ss  median=%ss  max=%ss\n", a[1], a[int((NR+1)/2)], a[NR]}'
