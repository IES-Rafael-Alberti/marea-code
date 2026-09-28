: "${MAREA_RELEASE:?set MAREA_RELEASE to the release directory}"
: "${MAREA_ROOT:?set MAREA_ROOT to the new installation directory}"
: "${MAREA_RESTORE_PARENT:?set MAREA_RESTORE_PARENT to a private directory outside MAREA_ROOT}"
: "${MAREA_PORT:?set MAREA_PORT to the loopback port of the teacher server}"
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY to the provider credential}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD for the first administrator}"
export PATH="$MAREA_RELEASE/bin:$PATH"
umask 077

mkdir -m 700 "$MAREA_ROOT"
for directory in locks config state backups work centers centers/center-north \
  centers/center-north/didactic centers/center-north/evaluation teachers \
  teachers/teacher-ada teachers/teacher-ada/didactic teachers/teacher-ada/evaluation; do
  mkdir -m 700 "$MAREA_ROOT/$directory"
done
cp -R "$MAREA_RELEASE/skills" "$MAREA_ROOT/core"
cp -R "$MAREA_RELEASE/dashboard" "$MAREA_ROOT/dashboard"
chmod -R go-rwx "$MAREA_ROOT/core" "$MAREA_ROOT/dashboard"

openssl rand 32 > "$MAREA_ROOT/state/digest.key"
printf '%s\n' "$OPENROUTER_API_KEY" > "$MAREA_ROOT/state/openrouter.key"
chmod 600 "$MAREA_ROOT/state/digest.key" "$MAREA_ROOT/state/openrouter.key"

cat > "$MAREA_ROOT/config/operations.json" <<EOF
{
  "version": 1,
  "databasePath": "$MAREA_ROOT/marea.sqlite",
  "indexPath": "$MAREA_ROOT/state/deletion-index.sqlite",
  "backupRoot": "$MAREA_ROOT/backups",
  "authorityLineage": "lineage:pilot-north",
  "rootId": "root:pilot-north",
  "databaseLineage": "sha256:$(openssl rand -hex 32)",
  "releaseId": "release:pilot",
  "limits": { "fileCount": 16, "fileBytes": 268435456, "totalBytes": 536870912 },
  "stateFiles": []
}
EOF

cat > "$MAREA_ROOT/policy.json" <<'EOF'
{
  "version": 1,
  "classes": [
    {
      "classId": "class:physics",
      "policy": {
        "route": {
          "version": "route:2026-09",
          "modelAlias": "marea",
          "providerRoute": {
            "providerId": "org.marea.openrouter",
            "model": "synthetic/example-model",
            "budget": {
              "inputTokenCeiling": 32000,
              "tutoring": {
                "version": "usage:tutoring-2026-09",
                "costUnit": "credit",
                "inputCostUnitsPerToken": 1,
                "outputCostUnitsPerToken": 3,
                "maxRequests": 200,
                "maxTokens": 2000000,
                "maxCostUnits": 4000000,
                "maxConcurrentRequests": 2,
                "maxRequestDurationMs": 60000,
                "maxInputTokens": 32000,
                "maxOutputTokens": 4000,
                "maxToolCalls": 100
              },
              "evaluation": {
                "version": "usage:evaluation-2026-09",
                "costUnit": "credit",
                "inputCostUnitsPerToken": 1,
                "outputCostUnitsPerToken": 3,
                "maxRequests": 4,
                "maxTokens": 200000,
                "maxCostUnits": 400000,
                "maxConcurrentRequests": 1,
                "maxRequestDurationMs": 120000,
                "maxInputTokens": 32000,
                "maxOutputTokens": 4000,
                "maxToolCalls": 0
              }
            }
          }
        },
        "teacherToolPolicy": {
          "version": "policy:2026-09",
          "restrictions": [{ "tool": "workspace.write", "effect": "require-approval" }]
        }
      }
    }
  ]
}
EOF

cat > "$MAREA_ROOT/config/operator-cli.json" <<EOF
{
  "version": 1,
  "databasePath": "$MAREA_ROOT/marea.sqlite",
  "operatorPolicyPath": "$MAREA_ROOT/policy.json",
  "coreSourcePath": "$MAREA_ROOT/core",
  "centers": [{ "id": "center:north", "root": "$MAREA_ROOT/centers/center-north" }],
  "teachers": [{ "id": "user:ada", "root": "$MAREA_ROOT/teachers/teacher-ada" }],
  "personalOwners": [{ "classId": "class:physics", "teacherId": "user:ada" }]
}
EOF

cat > "$MAREA_ROOT/config/teacher-host.json" <<EOF
{
  "version": 1,
  "releaseId": "release:pilot",
  "listen": { "hostname": "127.0.0.1", "port": $MAREA_PORT },
  "allowedHosts": ["127.0.0.1:$MAREA_PORT"],
  "allowedOrigins": ["http://127.0.0.1:$MAREA_PORT"],
  "secureDashboardCookie": false,
  "serverVersion": "0.2.0",
  "statusPath": "$MAREA_ROOT/state/host-status.json",
  "digestKeyPath": "$MAREA_ROOT/state/digest.key",
  "dashboardDistPath": "$MAREA_ROOT/dashboard",
  "providers": [
    { "pluginId": "org.marea.openrouter", "credentialPath": "$MAREA_ROOT/state/openrouter.key" }
  ],
  "retry": { "delayMs": 500, "maxDelayMs": 5000 },
  "evaluationIntervalMs": 5000,
  "shutdownDrainMs": 10000
}
EOF

marea-operations --installation "$MAREA_ROOT" installation status
marea-operations --installation "$MAREA_ROOT" installation initialize

version_of() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
input() { cat > "$MAREA_ROOT/work/$1.json"; printf '%s' "$MAREA_ROOT/work/$1.json"; }

marea-admin --installation "$MAREA_ROOT" center create --input "$(input center <<'EOF'
{ "centerId": "center:north", "displayName": "North Center", "expectedVersion": null }
EOF
)"
marea-admin --installation "$MAREA_ROOT" class create --input "$(input class <<'EOF'
{ "centerId": "center:north", "classId": "class:physics", "displayName": "Physics", "expectedVersion": null }
EOF
)"
ada=$(marea-admin --installation "$MAREA_ROOT" account create --input "$(input ada <<'EOF'
{ "centerId": "center:north", "userId": "user:ada", "displayName": "Ada Teacher",
  "login": "ada", "role": "teacher", "classId": "class:physics", "expectedVersion": null }
EOF
)")

provisioned=$(printf '%s\n' "$ADMIN_PASSWORD" | marea-admin --installation "$MAREA_ROOT" \
  credential provision --user user:ada --expected-version "$(printf '%s' "$ada" | version_of)" \
  --password-stdin)
marea-admin --installation "$MAREA_ROOT" administrator grant --input "$(input grant <<EOF
{ "centerId": "center:north", "userId": "user:ada", "expectedVersion": "$(printf '%s' "$ada" | version_of)" }
EOF
)"

marea-teacher --installation "$MAREA_ROOT" --release release:pilot > "$MAREA_ROOT/work/host.log" 2>&1 &
host_pid=$!
for attempt in $(seq 1 100); do
  marea-operations --installation "$MAREA_ROOT" installation status | grep -q '"status":"ready"' && break
  sleep 0.2
done
marea-operations --installation "$MAREA_ROOT" installation status | grep '"status":"ready"'
for attempt in $(seq 1 25); do
  curl -fsS "http://127.0.0.1:$MAREA_PORT/dashboard/index.html" > /dev/null 2>&1 && break
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$MAREA_PORT/dashboard/index.html" > /dev/null

kill -TERM "$host_pid"
wait "$host_pid"
marea-operations --installation "$MAREA_ROOT" installation status | grep '"status":"stopped"'

preview=$(marea-admin --installation "$MAREA_ROOT" class import-preview --input "$(input import <<'EOF'
{ "centerId": "center:north", "classId": "class:physics", "expectedTeachingVersion": null,
  "package": { "format": "marea-class-exchange:1", "source": { "displayName": "Physics template" },
    "agentMode": "tutoring",
    "classInstructions": { "tutoring": "Guide with questions.", "free": "Explore freely." },
    "selection": { "didactic": [], "evaluation": [] } } }
EOF
)")
preview_id=$(printf '%s' "$preview" | sed -n 's/.*"previewId":"\([^"]*\)".*/\1/p')
imported=$(marea-admin --installation "$MAREA_ROOT" class import-confirm --input "$(input confirm <<EOF
{ "centerId": "center:north", "classId": "class:physics", "previewId": "$preview_id" }
EOF
)")
teaching_version=$(printf '%s' "$imported" | sed -n 's/.*"teachingVersion":"\([^"]*\)".*/\1/p')
marea-admin --installation "$MAREA_ROOT" class export --output "$MAREA_ROOT/work/physics-exchange.json" \
  --input "$(input export <<EOF
{ "centerId": "center:north", "classId": "class:physics", "expectedTeachingVersion": "$teaching_version" }
EOF
)"

marea-admin --installation "$MAREA_ROOT" sessions revoke --input "$(input revoke <<EOF
{ "centerId": "center:north", "userId": "user:ada", "expectedVersion": "$(printf '%s' "$provisioned" | version_of)" }
EOF
)"

student=$(marea-admin --installation "$MAREA_ROOT" account create --input "$(input student <<'EOF'
{ "centerId": "center:north", "userId": "user:leaver", "displayName": "Leaver Student",
  "login": "leaver", "role": "student", "classId": "class:physics", "expectedVersion": null }
EOF
)")
marea-operations --installation "$MAREA_ROOT" deletion preview --output "$MAREA_ROOT/work/leaver-preview.json" \
  --input "$(input leaver-request <<EOF
{ "requestId": "request:leaver", "previewId": "preview:leaver", "policyRevision": "policy:2026-09",
  "targets": [{ "kind": "account", "key": { "userId": "user:leaver" },
    "observed": { "kind": "version", "version": "$(printf '%s' "$student" | version_of)" } }] }
EOF
)"

marea-operations --installation "$MAREA_ROOT" deletion confirm \
  --input "$MAREA_ROOT/work/leaver-preview.json" | grep '"state":"applied"'

marea-operations --installation "$MAREA_ROOT" backup create --input "$(input backup <<'EOF'
{ "name": "nightly-2026-09-15" }
EOF
)"
mkdir -p -m 700 "$MAREA_RESTORE_PARENT"
cp -R "$MAREA_ROOT/backups/nightly-2026-09-15" "$MAREA_RESTORE_PARENT/nightly-2026-09-15"

marea-operations --installation "$MAREA_ROOT" installation status
marea-operations --installation "$MAREA_ROOT" backup create --input "$(input pre-upgrade <<'EOF'
{ "name": "pre-upgrade" }
EOF
)"
cp -R "$MAREA_ROOT/backups/pre-upgrade" "$MAREA_RESTORE_PARENT/pre-upgrade"
marea-operations --installation "$MAREA_ROOT" deletion activate

marea-operations --installation "$MAREA_ROOT" backup restore --input "$(input restore <<EOF
{ "bundlePath": "$MAREA_RESTORE_PARENT/nightly-2026-09-15",
  "destinationRoot": "$MAREA_RESTORE_PARENT/restored-nightly" }
EOF
)" | grep '"state":"restored"'

: "${MAREA_NEW_ROOT:?set MAREA_NEW_ROOT to the new, empty installation directory}"
mkdir -m 700 "$MAREA_NEW_ROOT"
for directory in locks config state backups work; do
  mkdir -m 700 "$MAREA_NEW_ROOT/$directory"
done
cp -R "$MAREA_ROOT/core" "$MAREA_ROOT/dashboard" "$MAREA_ROOT/centers" "$MAREA_ROOT/teachers" \
  "$MAREA_ROOT/policy.json" "$MAREA_NEW_ROOT/"
cp "$MAREA_ROOT/state/digest.key" "$MAREA_ROOT/state/openrouter.key" "$MAREA_NEW_ROOT/state/"
for file in operator-cli teacher-host; do
  sed "s#$MAREA_ROOT#$MAREA_NEW_ROOT#g" "$MAREA_ROOT/config/$file.json" > "$MAREA_NEW_ROOT/config/$file.json"
done
sed -e "s#$MAREA_ROOT#$MAREA_NEW_ROOT#g" -e 's#"root:pilot-north"#"root:pilot-north-2"#' \
  "$MAREA_ROOT/config/operations.json" > "$MAREA_NEW_ROOT/config/operations.json"
chmod -R go-rwx "$MAREA_NEW_ROOT"

marea-operations --installation "$MAREA_ROOT" transfer start --input "$(input move <<EOF
{ "handoffId": "handoff:move-north", "destinationInstallation": "$MAREA_NEW_ROOT" }
EOF
)" | grep '"state":"destination-active"'

marea-operations --installation "$MAREA_ROOT" transfer inspect | grep '"state":"destination-active"'
marea-teacher --installation "$MAREA_NEW_ROOT" --release release:pilot > "$MAREA_NEW_ROOT/work/host.log" 2>&1 &
host_pid=$!
for attempt in $(seq 1 100); do
  marea-operations --installation "$MAREA_NEW_ROOT" installation status | grep -q '"status":"ready"' && break
  sleep 0.2
done
marea-operations --installation "$MAREA_NEW_ROOT" installation status | grep '"status":"ready"'
kill -TERM "$host_pid"
wait "$host_pid"

marea-operations --installation "$MAREA_ROOT" installation status
marea-operations --installation "$MAREA_ROOT" recovery inspect --input "$(input inspect <<'EOF'
{}
EOF
)"
