#!/usr/bin/env node
// PreToolUse フック: 保護対象（CLAUDE.md「保護対象」）への編集を拒否する。
//
// 解除: 人間が承認する場合のみ、環境変数 ALLOW_PROTECTED=1 を付けて Claude Code を起動する。
//   bash:       ALLOW_PROTECTED=1 claude
//   PowerShell: $env:ALLOW_PROTECTED = "1"; claude
//
// Edit / Write / NotebookEdit はパスで厳密に判定する。
// Bash / PowerShell はコマンド文字列に保護パスと書き込み操作の両方が含まれるときに拒否する（ベストエフォート）。
// 拒否時は exit 2 + stderr（Claude Code がツール呼び出しを止め、理由を Claude に返す）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// プロジェクトルートからの相対パス（'/' 区切り）。末尾 '/' はディレクトリ配下すべて。
const PROTECTED = [
  'docs/spec.md',
  'web/tests/property/',
  'web/tests/golden/',
  'golden/',
  // フック自体を無効化できないように、設定とフックも保護する。
  '.claude/settings.json',
  '.claude/hooks/',
];

const WRITE_PATTERNS = [
  /(^|[^0-9&<>-])>(?![&=])/, // リダイレクト（2>/dev/null・->・=> は除く）
  /\bsed\b[^|;&]*\s-i/,
  /\b(tee|rm|rmdir|mv|cp|touch|truncate|dd|install|ln|unlink|chmod)\b/,
  /\bgit\s+(checkout|restore|rm|mv|apply|am|reset|stash|clean|merge|rebase|cherry-pick|revert|pull)\b/,
  /\b(Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item)\b/i,
  /\b(WriteAll(Text|Lines|Bytes)|writeFile(Sync)?|appendFile(Sync)?|write_text|write_bytes|shutil)\b/,
  /\bopen\([^)]*['"][wax]b?\+?['"]/,
];

const toPosix = (p) => p.replace(/\\/g, '/');

function projectRoot(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (input.cwd) return input.cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function relFromRoot(root, filePath, cwd) {
  const abs = path.resolve(cwd || root, filePath);
  return toPosix(path.relative(root, abs));
}

function matchProtected(rel) {
  const r = rel.toLowerCase();
  return PROTECTED.find((p) => (p.endsWith('/') ? r.startsWith(p.toLowerCase()) : r === p.toLowerCase()));
}

function checkFileTool(input, root) {
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.notebook_path;
  if (!target) return null;
  const rel = relFromRoot(root, target, input.cwd);
  const hit = matchProtected(rel);
  return hit ? `${rel}（保護対象: ${hit}）` : null;
}

function checkShellTool(input) {
  const cmd = toPosix(String((input.tool_input || {}).command || ''));
  const lower = cmd.toLowerCase();
  const hit = PROTECTED.find((p) => lower.includes(p.toLowerCase()));
  if (!hit) return null;
  if (!WRITE_PATTERNS.some((re) => re.test(cmd))) return null;
  return `コマンドが保護対象（${hit}）に書き込む可能性があります`;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');

  if (process.env.ALLOW_PROTECTED === '1') return 0;

  const root = projectRoot(input);
  let reason = null;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
    reason = checkFileTool(input, root);
  } else if (['Bash', 'PowerShell'].includes(input.tool_name)) {
    reason = checkShellTool(input);
  }
  if (!reason) return 0;

  process.stderr.write(
    `保護対象への編集は拒否されました: ${reason}\n` +
      '変更には人間の承認が必要です（CLAUDE.md「保護対象」）。修正せず、理由を人間に報告してください。\n' +
      '人間が承認した場合のみ、ALLOW_PROTECTED=1 を付けて Claude Code を起動し直すと解除されます。\n',
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // 入力が壊れているときも安全側（拒否）に倒す。
    process.stderr.write(`protect-paths フックの実行に失敗したため拒否します: ${err}\n`);
    process.exit(2);
  },
);
