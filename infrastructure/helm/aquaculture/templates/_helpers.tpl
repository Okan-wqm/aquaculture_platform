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
{{- $tag := .image.tag | default "1.0.0" -}}
{{- printf "%s/%s:%s" $registry $repository $tag -}}
{{- end }}

{{/*
Common environment variables for backend services.
SECURITY (CRITICAL-001): JWT_PUBLIC_KEY is distributed to every backend service
so they can verify RS256-signed access tokens issued by auth-service. The
matching JWT_PRIVATE_KEY is injected ONLY into auth-service (see backend-services.yaml).
Before RS256 migration, a shared HS256 JWT_SECRET was distributed everywhere,
meaning any compromised service could forge tokens platform-wide.
*/}}
{{- define "aquaculture.backendEnv" -}}
- name: NODE_ENV
  value: {{ .Values.global.nodeEnv | default "production" | quote }}
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
- name: JWT_PUBLIC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "aquaculture.fullname" . }}-secrets
      key: jwtPublicKey
{{- end }}

{{/*
Per-service NATS client cert mount (ADR-015: cert-is-identity).

Each service authenticates to NATS via mTLS. Server runs `verify_and_map: true`
(nats-tls-enabled.conf), mapping the client cert's CN directly to the NATS
user — no username / password are sent in the CONNECT frame. The requested
identity must exist in the generated SSoT roster, and the pod receives only
that identity's Secret.

Usage:
  {{- include "aquaculture.natsServiceEnv" (list . "farm_service") | nindent 12 }}

The second argument is the certificate CN from infrastructure/nats/services.yaml.

Historical: prior to ADR-015 this helper injected NATS_AUTH_USER /
NATS_AUTH_PASS from a per-service Secret. Those env vars are removed;
the server ignored them under verify_and_map anyway, and keeping them
wired was the drift surface that caused the 2026-04-14 outage.
*/}}
{{- define "aquaculture.natsServiceEnv" -}}
{{- $root := index . 0 -}}
{{- $svcName := index . 1 -}}
{{- $registry := $root.Files.Get "files/nats-service-identities.yaml" | fromYaml -}}
{{- if not (has $svcName $registry.identities) -}}
{{- fail (printf "NATS identity %q is absent from generated nats-service-identities.yaml" $svcName) -}}
{{- end -}}
- name: NATS_TLS_ENABLED
  value: "true"
- name: NATS_TLS_CA
  value: /etc/ssl/nats-client/ca.crt
- name: NATS_TLS_CERT
  value: /etc/ssl/nats-client/tls.crt
- name: NATS_TLS_KEY
  value: /etc/ssl/nats-client/tls.key
{{- end }}

{{/* Kubernetes Secret name for one NATS certificate identity. */}}
{{- define "aquaculture.natsClientSecretName" -}}
{{- $root := index . 0 -}}
{{- $svcName := index . 1 | replace "_" "-" -}}
{{- $suffix := printf "-nats-%s" $svcName -}}
{{- $prefixMax := sub 63 (len $suffix) | int -}}
{{- $prefix := include "aquaculture.fullname" $root | trunc $prefixMax | trimSuffix "-" -}}
{{- printf "%s%s" $prefix $suffix | trimSuffix "-" -}}
{{- end }}

{{/* Mount only the current runtime's cert-manager Secret. */}}
{{- define "aquaculture.natsServiceVolumeMount" -}}
- name: nats-client-tls
  mountPath: /etc/ssl/nats-client
  readOnly: true
{{- end }}

{{- define "aquaculture.natsServiceVolume" -}}
{{- $root := index . 0 -}}
{{- $svcName := index . 1 -}}
- name: nats-client-tls
  secret:
    secretName: {{ include "aquaculture.natsClientSecretName" (list $root $svcName) }}
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
Pod security context — applied at pod spec level.
Includes runAsGroup to prevent group-0 writes.
*/}}
{{- define "aquaculture.podSecurityContext" -}}
securityContext:
  runAsNonRoot: {{ .Values.podSecurityContext.runAsNonRoot }}
  runAsUser: {{ .Values.podSecurityContext.runAsUser }}
  runAsGroup: {{ .Values.podSecurityContext.runAsGroup }}
  fsGroup: {{ .Values.podSecurityContext.fsGroup }}
{{- end }}

{{/*
Container security context — applied at container level.
Satisfies Kubernetes Pod Security Standards restricted profile (1.25+).
Add emptyDir volumes for any service that requires write access to local paths.
*/}}
{{- define "aquaculture.securityContext" -}}
securityContext:
  allowPrivilegeEscalation: {{ .Values.securityContext.allowPrivilegeEscalation }}
  readOnlyRootFilesystem: {{ .Values.securityContext.readOnlyRootFilesystem }}
  runAsNonRoot: {{ .Values.securityContext.runAsNonRoot }}
  runAsUser: {{ .Values.securityContext.runAsUser }}
  runAsGroup: {{ .Values.securityContext.runAsGroup }}
  capabilities:
    drop:
      - ALL
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/*
Frontend container security context — nginx runs as user 101.
Capabilities drop and seccomp profile applied consistently.
*/}}
{{- define "aquaculture.frontendSecurityContext" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  runAsUser: 101
  runAsGroup: 101
  capabilities:
    drop:
      - ALL
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{/*
Validate required sub-chart passwords.
An empty postgresql.auth.password or redis.auth.password causes the Bitnami
sub-charts to start with authentication disabled, exposing unauthenticated
database endpoints to every pod in the namespace. This template is rendered
from namespace.yaml so the chart fails to render if either value is absent.
*/}}
{{- define "aquaculture.validatePasswords" -}}
{{- if and .Values.postgresql.enabled (not .Values.postgresql.auth.password) -}}
{{- required "postgresql.auth.password must be set — an empty value disables PostgreSQL authentication. Set via --set postgresql.auth.password=<value> or a sealed-secrets overlay." .Values.postgresql.auth.password -}}
{{- end -}}
{{- if and .Values.redis.enabled (not .Values.redis.auth.password) -}}
{{- required "redis.auth.password must be set — an empty value disables Redis authentication. Set via --set redis.auth.password=<value> or a sealed-secrets overlay." .Values.redis.auth.password -}}
{{- end -}}
{{- end -}}

{{/*
Frontend pod anti-affinity — spread replicas across nodes so a single
node failure does not take down all frontend MFEs simultaneously.
*/}}
{{- define "aquaculture.frontendAntiAffinity" -}}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              {{- toYaml .matchLabels | nindent 14 }}
          topologyKey: kubernetes.io/hostname
{{- end }}
