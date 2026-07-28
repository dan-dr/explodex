#!/bin/zsh
set -euo pipefail

expected_runtime="${1:?expected runtime state required: absent, present, or destroyed}"
expected_time_origin="${2:?expected performance.timeOrigin required}"
session="0789a7a74fd7"
target_id="320892B4AB2506B37CF08E743DB39053"
overlay_id="B7FBA1D17F480337F3092F9D855B8D6B"
sdk="/Users/dan/Projects/ddyo/Explodex/packages/sdk/dist/runtime/explodex-runtime.iife.js"
helper="/Users/dan/Projects/ddyo/Explodex/packages/cli/dist/runtime/bin/explodex-runtime-helper"

test "$(realpath "/Applications/ChatGPT.app")" = "/Applications/ChatGPT.app"
test "$(realpath "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")" = \
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "/Applications/ChatGPT.app/Contents/Info.plist")" = \
  "com.openai.codex"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/ChatGPT.app/Contents/Info.plist")" = \
  "26.721.41059"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "/Applications/ChatGPT.app/Contents/Info.plist")" = \
  "5848"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "/Applications/ChatGPT.app/Contents/Info.plist")" = \
  "ChatGPT"
codesign -dv --verbose=4 "/Applications/ChatGPT.app" 2>&1 |
  grep -q '^TeamIdentifier=2DC432GLL2$'
test "$(shasum -a 256 "/Applications/ChatGPT.app/Contents/Info.plist" | awk '{print $1}')" = \
  "9765029b131711b4797e2c21312ae3b290563f7ff3d2a9ec3c9b3b08686e6a2d"
test "$(shasum -a 256 "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" | awk '{print $1}')" = \
  "d7bd5eacb7f59c42240e6c5dc62eebdeca9d09a0b59ed4c3ac3e2b55ef8d9336"
test "$(shasum -a 256 "/Applications/ChatGPT.app/Contents/Resources/app.asar" | awk '{print $1}')" = \
  "da39a51b06fb4c728d418b8f0f05fc8fd8c6b1f74c4fb4d47c20c7914a798f45"

test "$("$helper" identify 76069)" = "113245930.161864995"
test "$("$helper" identify 76398)" = "113246247.161865506"
test "$(ps -p 76398 -o ppid= | tr -d ' ')" = "76069"
ps -ww -p 76069 -o command= |
  grep -Fq '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --user-data-dir=/Users/dan/.explodex/dev/plugin-dev/electron-user-data --remote-debugging-port=9444 --explodex-dev-instance=plugin-dev'
ps -ww -p 76398 -o command= |
  grep -Fq '/Users/dan/.explodex/dev/plugin-dev/codex-home/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'

listener_pids="$(lsof -nP -a -iTCP:9444 -sTCP:LISTEN -t | sort -n -u | paste -sd, -)"
test "$listener_pids" = "76069,76398"
protected_9333="$(lsof -nP -a -iTCP:9333 -sTCP:LISTEN -FpctnT)"
printf '%s\n' "$protected_9333" | grep -q '^p22810$'
printf '%s\n' "$protected_9333" | grep -q '^cComet$'
printf '%s\n' "$protected_9333" | grep -q '^n127.0.0.1:9333$'

version_json="$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:9444/json/version")"
printf '%s' "$version_json" |
  jq -e '.Browser == "Chrome/150.0.7871.128" and ."Protocol-Version" == "1.3"' >/dev/null
targets_json="$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:9444/json/list")"
printf '%s' "$targets_json" | jq -e \
  --arg target "$target_id" \
  --arg overlay "$overlay_id" \
  'length == 2
   and any(.[]; .id == $target and .type == "page" and .url == "app://-/index.html")
   and any(.[]; .id == $overlay and .type == "page" and .url == "app://-/index.html?initialRoute=%2Favatar-overlay")
   and all(.[]; .id == $target or .id == $overlay)' >/dev/null

test "$(wc -c < "$sdk" | tr -d ' ')" = "85623"
test "$(shasum -a 256 "$sdk" | awk '{print $1}')" = \
  "cde97e29af89a35b737406bd038212c94752b43ec3d24ab74b87aeb480e03ec4"
test "$(shasum -a 256 "/Users/dan/.explodex/dev/plugin-dev/state.json" | awk '{print $1}')" = \
  "5abd53852c64ef0b4e699737bf695c57b7d8d97fcccfeb8c79d2cccf79261f09"
test "$(shasum -a 256 "/Users/dan/.explodex/state/compatibility.json" | awk '{print $1}')" = \
  "cadfaae5d21baea7dac8227fbd38ac3ca182f23a43fa5cbe4f8034777e6a8b6e"
test ! -e "/Users/dan/.explodex/plugins.json"

tabs_json="$(agent-browser --session "$session" tab --json)"
printf '%s' "$tabs_json" | jq -e \
  '.success == true
   and (.data.tabs | length) == 2
   and any(.data.tabs[]; .active == true and .tabId == "t1" and .url == "app://-/index.html")
   and any(.data.tabs[]; .tabId == "t2" and .url == "app://-/index.html?initialRoute=%2Favatar-overlay")' >/dev/null

runtime_json="$(agent-browser --session "$session" eval --json \
  "({href:location.href,title:document.title,readyState:document.readyState,timeOrigin:performance.timeOrigin,top:window.top===window,frameElementCount:document.querySelectorAll('iframe,webview').length,bridgeType:typeof globalThis.electronBridge?.sendMessageFromView,composerPresent:Boolean(document.querySelector('textarea,[contenteditable=true]')),profilePresent:/Dan|profile|account/i.test(document.body.innerText),signInVisible:/sign in|log in/i.test(document.body.innerText),runtimePresent:Boolean(globalThis.Explodex),runtimeVersion:globalThis.Explodex?.version??null,runtimeRequest:globalThis.Explodex?.__explodexSdkRuntimeRequestMark??null,runtimeInventory:typeof globalThis.Explodex?.__explodexPluginApplicationInventory==='function'?globalThis.Explodex.__explodexPluginApplicationInventory():[],harnessKind:globalThis.__M4_LIVE_R03__?.kind??null,harnessCallbacks:Object.keys(globalThis).filter((key)=>key.startsWith('__m4LiveR03')||key.startsWith('__explodexReview_')||key.startsWith('__explodexUpdate_')).sort(),futureDocumentSentinel:globalThis.__M4_LIVE_R03_FUTURE_DOCUMENT__??null})")"
printf '%s' "$runtime_json" | jq -e \
  --argjson time_origin "$expected_time_origin" \
  '.success == true
   and .data.result.href == "app://-/index.html"
   and .data.result.readyState == "complete"
   and .data.result.timeOrigin == $time_origin
   and .data.result.top == true
   and .data.result.frameElementCount == 0
   and .data.result.bridgeType == "function"
   and .data.result.composerPresent == true
   and .data.result.profilePresent == true
   and .data.result.signInVisible == false
   and .data.result.futureDocumentSentinel == null' >/dev/null

case "$expected_runtime" in
  absent)
    printf '%s' "$runtime_json" |
      jq -e '.data.result.runtimePresent == false and .data.result.harnessKind == null' >/dev/null
    ;;
  present)
    printf '%s' "$runtime_json" | jq -e \
      '.data.result.runtimePresent == true
       and .data.result.runtimeVersion == "1.2.0"
       and (.data.result.runtimeRequest | startswith("cde97e29af89a35b737406bd038212c94752b43ec3d24ab74b87aeb480e03ec4:"))
       and .data.result.harnessKind == "validation-only-direct-cdp"
       and .data.result.harnessCallbacks == []' >/dev/null
    ;;
  destroyed)
    printf '%s' "$runtime_json" |
      jq -e '.data.result.runtimePresent == false and .data.result.harnessKind == null and .data.result.runtimeInventory == [] and .data.result.harnessCallbacks == []' >/dev/null
    ;;
  *)
    printf 'unknown expected runtime state: %s\n' "$expected_runtime" >&2
    exit 64
    ;;
esac

jq -n \
  --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg expectedRuntime "$expected_runtime" \
  --arg targetId "$target_id" \
  --arg overlayTargetId "$overlay_id" \
  --arg listenerPids "$listener_pids" \
  --argjson runtime "$runtime_json" \
  '{
    observedAt: $observedAt,
    expectedRuntime: $expectedRuntime,
    targetId: $targetId,
    overlayTargetId: $overlayTargetId,
    listenerPids: ($listenerPids | split(",") | map(tonumber)),
    runtime: $runtime.data.result,
    verdict: "revalidated"
  }'
