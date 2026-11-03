#!/usr/bin/env bash
# Safe, loopback-only local family authentication onboarding. Do not commit passwords.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ -z "${ALEX_PARENT_PASSWORD:-}" ]]; then
  if [[ ! -t 0 ]]; then
    echo 'ALEX_PARENT_PASSWORD is required (at least 12 characters). Run interactively or pass a secure environment variable.' >&2
    exit 2
  fi
  read -r -s -p '设置本地家长密码（至少 12 个字符，不回显）: ' ALEX_PARENT_PASSWORD
  printf '\n'
fi
if (( ${#ALEX_PARENT_PASSWORD} < 12 )); then
  echo '家长密码至少需要 12 个字符；未启动服务。' >&2
  exit 2
fi
if [[ -n "${ALEX_CHILD_PIN:-}" && ! "${ALEX_CHILD_PIN}" =~ ^[0-9]{6,12}$ ]]; then
  echo 'ALEX_CHILD_PIN 必须是 6–12 位数字；未启动服务。' >&2
  exit 2
fi
export AUTH_MODE=local ALEX_PARENT_PASSWORD
npm run build
exec node scripts/server.mjs
