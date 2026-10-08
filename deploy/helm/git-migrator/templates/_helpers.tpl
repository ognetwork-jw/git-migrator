{{/* Resource name prefix: the release name (so hooks are <release>-config-migrate, DEP-030). */}}
{{- define "git-migrator.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{- define "git-migrator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "git-migrator.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The hook copy of the ServiceAccount used by the migrate Job. */}}
{{- define "git-migrator.migrateServiceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- printf "%s-migrate" (include "git-migrator.fullname" .) -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "git-migrator.image" -}}
{{- $repository := required "image.repository is required (for example <org>/git-migrator)" .Values.image.repository -}}
{{- printf "%s/%s:%s" .Values.image.registry $repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* DEP-031: the default provider reads the vault with the workload identity. */}}
{{- define "git-migrator.secretspecProvider" -}}
{{- if .Values.secretspec.provider -}}
{{- .Values.secretspec.provider -}}
{{- else -}}
{{- $vault := required "azure.keyVaultName is required unless secretspec.provider is set" .Values.azure.keyVaultName -}}
{{- $_ := required "azure.workloadIdentityClientId is required unless secretspec.provider is set" .Values.azure.workloadIdentityClientId -}}
{{- printf "akv://%s?auth=workload_identity" $vault -}}
{{- end -}}
{{- end -}}

{{- define "git-migrator.selectorLabels" -}}
app.kubernetes.io/name: git-migrator
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- if .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- end -}}

{{- define "git-migrator.labels" -}}
{{ include "git-migrator.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{/* DEP-010: pod and container security contexts, the same for every workload. */}}
{{- define "git-migrator.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 10001
runAsGroup: 10001
fsGroup: 10001
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "git-migrator.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/*
The runtime configuration file (DEP-040): values.config over the production default, then the
top-level values the application needs over that. Secrets never appear here.
*/}}
{{- define "git-migrator.config" -}}
{{- $config := mustMergeOverwrite (dict "environment" "production") (deepCopy .Values.config) -}}
{{- if and (not (hasKey $config "publicUrl")) .Values.ingress.host -}}
{{- $_ := set $config "publicUrl" (printf "https://%s" .Values.ingress.host) -}}
{{- end -}}
{{- $owned := dict
      "postgres" (dict
        "host" (required "postgres.host is required" .Values.postgres.host)
        "port" .Values.postgres.port
        "database" .Values.postgres.database
        "user" .Values.postgres.user
        "sslmode" .Values.postgres.sslmode
        "auth" .Values.postgres.auth
        "pool" (deepCopy .Values.postgres.pool))
      "worker" (dict
        "standard" (dict "concurrency" (deepCopy .Values.worker.standard.concurrency))
        "large" (dict "concurrency" (deepCopy .Values.worker.large.concurrency)))
      "observability" (deepCopy .Values.observability)
      "metrics" (dict "port" .Values.metrics.port)
      "secretspec" (dict "profile" .Values.secretspec.profile) -}}
{{- $merged := mustMergeOverwrite $config $owned -}}
{{- toYaml $merged -}}
{{- end -}}

{{/* Environment shared by every container. `role` is set for the workers. */}}
{{- define "git-migrator.env" -}}
- name: GM_CONFIG_FILE
  value: /etc/git-migrator/config.yaml
- name: GM_SECRETSPEC_PROVIDER
  value: {{ include "git-migrator.secretspecProvider" .root | quote }}
- name: GM_SECRETSPEC_PROFILE
  value: {{ .root.Values.secretspec.profile | quote }}
- name: HOME
  value: /home/gm
- name: TMPDIR
  value: /tmp
{{- if .role }}
- name: GM_SCRATCH_DIR
  value: /scratch
- name: GM_WORKER_ROLE
  value: {{ .role | quote }}
{{- end }}
{{- end -}}

{{/* Pod labels: the selector labels plus the workload identity opt-in (DEP-020). */}}
{{- define "git-migrator.podLabels" -}}
{{ include "git-migrator.labels" . }}
azure.workload.identity/use: "true"
{{- end -}}
