{{/*
=============================================================================
Aquaculture Platform - Helm Template Helpers
=============================================================================
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "aquaculture.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "aquaculture.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "aquaculture.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "aquaculture.labels" -}}
helm.sh/chart: {{ include "aquaculture.chart" . }}
{{ include "aquaculture.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "aquaculture.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aquaculture.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "aquaculture.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "aquaculture.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Backend service labels
*/}}
{{- define "aquaculture.backendLabels" -}}
{{ include "aquaculture.labels" . }}
tier: backend
{{- end }}

{{/*
Frontend service labels
*/}}
{{- define "aquaculture.frontendLabels" -}}
{{ include "aquaculture.labels" . }}
tier: frontend
{{- end }}

{{/*
Create image name
*/}}
{{- define "aquaculture.image" -}}
{{- $registry := .global.imageRegistry | default "ghcr.io" -}}
{{- $repository := .image.repository -}}
{{- $tag := .image.tag | default "latest" -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- end }}

{{/*
Common environment variables for backend services
*/}}
{{- define "aquaculture.backendEnv" -}}
- name: NODE_ENV
  value: {{ .Values.gatewayApi.env.NODE_ENV | default "production" | quote }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "aquaculture.fullname" . }}-secrets
      key: databaseUrl
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "aquaculture.fullname" . }}-secrets
      key: redisUrl
- name: NATS_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "aquaculture.fullname" . }}-secrets
      key: natsUrl
- name: JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "aquaculture.fullname" . }}-secrets
      key: jwtSecret
{{- end }}

{{/*
Liveness probe configuration
*/}}
{{- define "aquaculture.livenessProbe" -}}
livenessProbe:
  httpGet:
    path: /health
    port: {{ .port | default 3000 }}
  initialDelaySeconds: {{ .Values.livenessProbe.initialDelaySeconds }}
  periodSeconds: {{ .Values.livenessProbe.periodSeconds }}
  timeoutSeconds: {{ .Values.livenessProbe.timeoutSeconds }}
  failureThreshold: {{ .Values.livenessProbe.failureThreshold }}
{{- end }}

{{/*
Readiness probe configuration
*/}}
{{- define "aquaculture.readinessProbe" -}}
readinessProbe:
  httpGet:
    path: /health/ready
    port: {{ .port | default 3000 }}
  initialDelaySeconds: {{ .Values.readinessProbe.initialDelaySeconds }}
  periodSeconds: {{ .Values.readinessProbe.periodSeconds }}
  timeoutSeconds: {{ .Values.readinessProbe.timeoutSeconds }}
  failureThreshold: {{ .Values.readinessProbe.failureThreshold }}
{{- end }}

{{/*
Pod security context
*/}}
{{- define "aquaculture.podSecurityContext" -}}
securityContext:
  runAsNonRoot: {{ .Values.podSecurityContext.runAsNonRoot }}
  runAsUser: {{ .Values.podSecurityContext.runAsUser }}
  fsGroup: {{ .Values.podSecurityContext.fsGroup }}
{{- end }}

{{/*
Container security context
*/}}
{{- define "aquaculture.securityContext" -}}
securityContext:
  allowPrivilegeEscalation: {{ .Values.securityContext.allowPrivilegeEscalation }}
  readOnlyRootFilesystem: {{ .Values.securityContext.readOnlyRootFilesystem }}
{{- end }}
