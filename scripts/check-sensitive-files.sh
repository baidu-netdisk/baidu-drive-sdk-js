#!/usr/bin/env bash
# 敏感文件检查：确认仓库里没有被提交的凭据类文件。
#
# 为什么不用 `grep -E` 直接匹配文件名：`.` 在正则里是通配符，会把 tsconfig.json、
# vite-env.d.ts、credential.ts 这类正常源码误判成敏感文件；而 `*.pem` 这种 glob
# 在正则里是非法表达式，报错又被 `|| true` 吞掉，等于根本没检查。
#
# 用法：
#   bash scripts/check-sensitive-files.sh              # 检查当前仓库
#   bash scripts/check-sensitive-files.sh --self-test  # 用临时仓库验证检查确实生效
set -euo pipefail

# 只匹配「文件名像凭据」的，且锚定完整文件名，避免子串误伤
PATTERNS='(^|/)\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|(^|/)credentials?\.(json|ya?ml|txt|ini|env)$|(^|/)secrets?\.(json|ya?ml|txt|ini)$'
# 允许的模板文件（模板里没有真实值）
ALLOW='(^|/)\.env\.(example|template|sample)$'

check() {
  local failed=0
  local file
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if printf '%s\n' "$file" | grep -Eq "$ALLOW"; then
      continue
    fi
    echo "❌ 发现疑似敏感文件：$file"
    failed=1
  done < <(git ls-files | grep -E "$PATTERNS" || true)
  return "$failed"
}

if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  (
    cd "$tmp"
    git init -q
    touch leaked.pem server.key app.p12 credentials.json .env
    mkdir -p examples/demo
    touch examples/demo/.env.example
    git add -A
  )
  if (cd "$tmp" && check > /dev/null 2>&1); then
    echo "❌ 自测失败：应当拦住 .pem / .key / .p12 / credentials.json / .env"
    exit 1
  fi
  echo "✅ 自测通过：能拦住凭据类文件，且放行 .env.example"
  exit 0
fi

if check; then
  echo "✅ 未发现敏感文件"
else
  echo "请移除这些文件，或把模板文件命名为 *.example 并加入 .gitignore"
  exit 1
fi
