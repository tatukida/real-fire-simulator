// PreToolUse フックの判定: 保護対象（CLAUDE.md「保護対象」）への編集を拒否する。
// 入口は run-protect.mjs（終了コードはそちらで決める）。このファイルは check() を export するだけで、自分では終了しない。
//
// 解除: 人間が承認する場合のみ、環境変数 ALLOW_PROTECTED=1 を付けて Claude Code を起動する。
//   bash:       ALLOW_PROTECTED=1 claude
//   PowerShell: $env:ALLOW_PROTECTED = "1"; claude
//
// Edit / Write / NotebookEdit はパスで厳密に判定する。
// Bash / PowerShell はコマンド文字列に保護パスと書き込み操作の両方が含まれるときに拒否する（ベストエフォート）。
//   誤検知を減らすため、次の2つだけは判定の前に取り除く（stripBenign）。リダイレクト先は取り除かない。
//   - ヒアドキュメントの本文: `cat > 先 <<'EOF'` / `cat <<'EOF' > 先` の形の行に続く本文のみ。
//   - `-m` に渡す引用符付き文字列（コミットメッセージ）。`-m "$(cat <<'EOF' … EOF )"` の形を含む。
//   解釈があいまいになる入力（バッククォート、\" や \'、PowerShell のヒア文字列、上記以外の <<、
//   "$(…)" を含む文字列、展開される本文の $(…)）では何も取り除かず、元のコマンド全体で判定する。
// 拒否時は理由の文字列を返す（入口が stderr に書いて exit 2 にし、Claude Code がツール呼び出しを止める）。

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

// 本文を取り除いてよいヒアドキュメントの行（cat とファイルへのリダイレクトだけ）。
const HEREDOC_LINE = [
  /^[ \t]*cat[ \t]+>>?[ \t]*[^\s<>|;&'"]+[ \t]+<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2[ \t]*$/,
  /^[ \t]*cat[ \t]+<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2[ \t]+>>?[ \t]*[^\s<>|;&'"]+[ \t]*$/,
];
// -m "$(cat <<'EOF' の形（区切りは引用符付きのみ）。
const MSG_HEREDOC = /^"\$\(cat[ \t]+<<(-?)[ \t]*(['"])([A-Za-z_]\w*)\2[ \t]*\n/;

const toPosix = (p) => p.replace(/\\/g, '/');

// from から始まる本文の区切り行を探す。見つからなければ null。
function heredocEnd(cmd, from, word, dash) {
  let pos = from;
  for (;;) {
    const nl = cmd.indexOf('\n', pos);
    const lineEnd = nl === -1 ? cmd.length : nl;
    const line = cmd.slice(pos, lineEnd);
    if ((dash ? line.replace(/^\t+/, '') : line) === word) return { bodyStart: from, bodyEnd: pos, end: lineEnd };
    if (nl === -1) return null;
    pos = nl + 1;
  }
}

// ヒアドキュメントの本文と -m の文字列を取り除いたコマンドを返す。あいまいなら元のまま返す。
function stripBenign(cmd) {
  if (/`|\\["']|@["']/.test(cmd)) return cmd;
  let out = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    const prev = i === 0 ? '\n' : cmd[i - 1];
    if (prev === '\n') {
      const nl = cmd.indexOf('\n', i);
      const line = cmd.slice(i, nl === -1 ? cmd.length : nl);
      const m = HEREDOC_LINE.map((re) => line.match(re)).find(Boolean);
      if (m) {
        const h = nl === -1 ? null : heredocEnd(cmd, nl + 1, m[3], m[1] === '-');
        if (!h) return cmd;
        if (!m[2] && cmd.slice(h.bodyStart, h.bodyEnd).includes('$(')) return cmd; // 本文が展開される
        out += `${line}\n${cmd.slice(h.bodyEnd, h.end)}`;
        i = h.end;
        continue;
      }
    }
    if (c === '#' && /\s/.test(prev)) {
      // コメントは取り除かないが、中の引用符は解釈しない。
      const nl = cmd.indexOf('\n', i);
      const end = nl === -1 ? cmd.length : nl;
      out += cmd.slice(i, end);
      i = end;
      continue;
    }
    if (c === '<' && cmd[i + 1] === '<') return cmd; // 上記以外のヒアドキュメント・ヒア文字列
    if (c === '-' && cmd[i + 1] === 'm' && /\s/.test(prev) && /[ \t]/.test(cmd[i + 2] || '')) {
      let k = i + 2;
      while (cmd[k] === ' ' || cmd[k] === '\t') k++;
      const q = cmd[k];
      if (q === "'" || q === '"') {
        const hm = q === '"' ? cmd.slice(k).match(MSG_HEREDOC) : null;
        let end;
        if (hm) {
          const h = heredocEnd(cmd, k + hm[0].length, hm[3], hm[1] === '-');
          const tail = h && cmd.slice(h.end).match(/^\n[ \t]*\)"/);
          if (!tail) return cmd;
          end = h.end + tail[0].length;
        } else {
          const j = cmd.indexOf(q, k + 1);
          if (j === -1) return cmd;
          if (q === '"' && cmd.slice(k, j).includes('$(')) return cmd;
          end = j + 1;
        }
        out += `-m ${q}${q}`;
        i = end;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, i + 1);
      if (j === -1) return cmd;
      if (c === '"' && cmd.slice(i, j).includes('$(')) return cmd;
      out += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

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
  // 引用符のエスケープ（\"）を判定に使うため、区切り文字の変換より先に取り除く。
  const raw = String((input.tool_input || {}).command || '').replace(/\r\n/g, '\n');
  const cmd = toPosix(stripBenign(raw));
  const lower = cmd.toLowerCase();
  const hit = PROTECTED.find((p) => lower.includes(p.toLowerCase()));
  if (!hit) return null;
  if (!WRITE_PATTERNS.some((re) => re.test(cmd))) return null;
  return `コマンドが保護対象（${hit}）に書き込む可能性があります`;
}

// 入力（Claude Code から渡された JSON を解析したもの）を判定し、拒否するなら理由、許可するなら null を返す。
export function check(input) {
  if (process.env.ALLOW_PROTECTED === '1') return null;

  const root = projectRoot(input);
  let reason = null;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
    reason = checkFileTool(input, root);
  } else if (['Bash', 'PowerShell'].includes(input.tool_name)) {
    reason = checkShellTool(input);
  }
  if (!reason) return null;

  return (
    `保護対象への編集は拒否されました: ${reason}\n` +
    '変更には人間の承認が必要です（CLAUDE.md「保護対象」）。修正せず、理由を人間に報告してください。\n' +
    '人間が承認した場合のみ、ALLOW_PROTECTED=1 を付けて Claude Code を起動し直すと解除されます。\n'
  );
}
