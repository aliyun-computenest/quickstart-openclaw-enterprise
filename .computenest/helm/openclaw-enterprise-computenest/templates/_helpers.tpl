{{- define "oce.labels" -}}
app.kubernetes.io/name: openclaw-enterprise
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "oce.selector" -}}
app.kubernetes.io/name: openclaw-enterprise
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "oce.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "oce.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{- define "oce.applicationDatabaseUrl" -}}
postgresql://occ_app:{{ .Values.applicationDatabasePassword }}@openclaw-enterprise-postgres:5432/openclaw_enterprise
{{- end }}

{{- define "oce.migrationDatabaseUrl" -}}
postgresql://occ_migrator:{{ .Values.migrationDatabasePassword }}@openclaw-enterprise-postgres:5432/openclaw_enterprise
{{- end }}

{{- define "oce.runtimeImage" -}}
{{- printf "%s@%s" (regexReplaceAll ":[^/:]+$" .Values.images.runtime "") .Values.images.runtimeDigest -}}
{{- end }}
