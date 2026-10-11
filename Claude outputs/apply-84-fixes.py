#!/usr/bin/env python3
"""Applies Ramla's two review comments on PR #84 (branch ALPHA-113-Rollback-Strategy).
Run from the repo root. Every edit must match exactly once, or nothing is written."""
import json, sys

C = "kubernetes/charts/microservice/"
files = {}

def load(p):
    if p not in files:
        files[p] = open(p, encoding="utf-8", newline="").read()
    return files[p]

def sub(p, old, new):
    s = load(p)
    if s.count(old) != 1:
        sys.exit(f"{p}: expected exactly 1 match, got {s.count(old)} for:\n{old[:100]}")
    files[p] = s.replace(old, new)

# 1. analysis-template.yaml: only render when analysis is enabled
sub(C + "templates/analysis-template.yaml",
    "{{- if not .Values.singleton }}\n",
    "{{- if and (not .Values.singleton) .Values.analysis.enabled }}\n")

# 2. deployment.yaml: skip the analysis step when analysis is disabled
sub(C + "templates/deployment.yaml",
    "        - analysis:\n",
    "        {{- if .Values.analysis.enabled }}\n        - analysis:\n")
sub(C + "templates/deployment.yaml",
    "                  podTemplateHashValue: Latest\n",
    "                  podTemplateHashValue: Latest\n        {{- end }}\n")

# 3. values.yaml: new analysis.enabled flag; drop strategy.type (the canary doesn't read it)
sub(C + "values.yaml",
    "  # -- RollingUpdate or Recreate (forced to Recreate when singleton: true).\n  type: RollingUpdate\n",
    "  # -- Services use canary (Argo Rollouts); the scheduler (singleton: true) uses Recreate.\n")
sub(C + "values.yaml",
    "# -- Rollout is marked failed after this many seconds",
    "# -- Run the Prometheus canary analysis (error rate, P95 latency) before promoting.\n"
    "# Set false where Prometheus isn't available (local kind).\n"
    "analysis:\n  enabled: true\n\n"
    "# -- Rollout is marked failed after this many seconds")

# 4. values.schema.json: the schema rejects unknown top-level keys, so analysis must be declared
sub(C + "values.schema.json",
    '    "progressDeadlineSeconds": {',
    '    "analysis": {\n      "type": "object",\n      "additionalProperties": false,\n'
    '      "properties": {\n        "enabled": {\n          "type": "boolean"\n        }\n      }\n    },\n'
    '    "progressDeadlineSeconds": {')

json.loads(files[C + "values.schema.json"])  # still valid JSON
for p, s in files.items():
    open(p, "w", encoding="utf-8", newline="").write(s)
    print("patched", p)
