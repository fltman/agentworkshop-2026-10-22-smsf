#!/usr/bin/env bash
# smsf-hao NRF smoke test. Any team can run this to see that the NRF behaves.
#
#   projects/smsf-hao/smoke.sh
#   BASE=http://localhost:8080/t/smsf-hao projects/smsf-hao/smoke.sh
set -u

BASE="${BASE:-https://smsf.torget.bjarby.com/t/smsf-hao}"
ID="${ID:-smoke-$(date +%s)}"
fails=0

step() { printf '\n=== %s\n' "$1"; }
check() { # check <expected-code> <actual-code> <what>
  if [ "$1" = "$2" ]; then printf '    ok   %s (%s)\n' "$3" "$2"
  else printf '    FAIL %s: expected %s, got %s\n' "$3" "$1" "$2"; fails=$((fails + 1)); fi
}
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }
call() { # call <method> <path> [body]
  if [ $# -ge 3 ]; then
    curl -sS -w '\n%{http_code}' -X "$1" -H 'content-type: application/json' -d "$3" "$BASE$2"
  else
    curl -sS -w '\n%{http_code}' -X "$1" "$BASE$2"
  fi
}

printf 'NRF smoke test against %s\n' "$BASE"
printf 'using nfInstanceId %s\n' "$ID"

step "1. register (expect 201)"
r=$(call PUT "/nnrf-nfm/v1/nf-instances/$ID" '{
  "nfInstanceId": "'"$ID"'",
  "nfType": "SMSF",
  "fqdn": "smoke.example",
  "heartBeatTimer": 30,
  "nfServices": [{
    "serviceInstanceId": "smoke-1",
    "serviceName": "nsmsf-sms",
    "versions": [{"apiVersionInUri": "v2"}],
    "scheme": "https",
    "apiPrefix": "/t/smoke"
  }]
}')
check 201 "$(code "$r")" "PUT creates"
body "$r" | head -c 400; echo

step "2. register again (expect 200, replace)"
r=$(call PUT "/nnrf-nfm/v1/nf-instances/$ID" '{"nfInstanceId":"'"$ID"'","nfType":"SMSF","fqdn":"smoke.example"}')
check 200 "$(code "$r")" "PUT replaces"

step "3. id mismatch (expect 400 ProblemDetails)"
r=$(call PUT "/nnrf-nfm/v1/nf-instances/$ID" '{"nfInstanceId":"somethingelse","nfType":"SMSF"}')
check 400 "$(code "$r")" "PUT rejects mismatched id"
body "$r"; echo

step "4. heartbeat with an empty patch (expect 204)"
r=$(call PATCH "/nnrf-nfm/v1/nf-instances/$ID" '[]')
check 204 "$(code "$r")" "PATCH [] heartbeats"

step "5. patch nfStatus (expect 200)"
r=$(call PATCH "/nnrf-nfm/v1/nf-instances/$ID" '[{"op":"replace","path":"/nfStatus","value":"REGISTERED"}]')
check 200 "$(code "$r")" "PATCH updates"

step "6. discover it (expect 200 and at least one instance)"
r=$(call GET "/nnrf-disc/v1/nf-instances?target-nf-type=SMSF&requester-nf-type=AMF")
check 200 "$(code "$r")" "discovery answers"
if grep -q "$ID" <<<"$(body "$r")"; then printf '    ok   our instance is in the SearchResult\n'
else printf '    FAIL our instance is missing from the SearchResult\n'; fails=$((fails + 1)); fi
body "$r" | head -c 600; echo

step "7. discover a type nobody has (expect 200 and an empty list, NOT 404)"
r=$(call GET "/nnrf-disc/v1/nf-instances?target-nf-type=NEF&requester-nf-type=AMF")
check 200 "$(code "$r")" "empty result is 200"
body "$r"; echo

step "8. discovery without requester-nf-type (expect 400)"
r=$(call GET "/nnrf-disc/v1/nf-instances?target-nf-type=UDM")
check 400 "$(code "$r")" "mandatory query parameter enforced"

step "9. deregister (expect 204)"
r=$(call DELETE "/nnrf-nfm/v1/nf-instances/$ID")
check 204 "$(code "$r")" "DELETE deregisters"

step "10. read the deregistered instance (expect 404)"
r=$(call GET "/nnrf-nfm/v1/nf-instances/$ID")
check 404 "$(code "$r")" "gone after deregistration"

step "11. it is out of discovery too"
r=$(call GET "/nnrf-disc/v1/nf-instances?target-nf-type=SMSF&requester-nf-type=AMF")
if grep -q "$ID" <<<"$(body "$r")"; then printf '    FAIL still discoverable after DELETE\n'; fails=$((fails + 1))
else printf '    ok   no longer discoverable\n'; fi

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL CHECKS PASSED\n'; else printf '%s CHECK(S) FAILED\n' "$fails"; fi
exit "$fails"
