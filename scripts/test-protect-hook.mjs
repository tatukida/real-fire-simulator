// 保護対象フック（入口 .claude/hooks/run-protect.mjs → 判定 protect-paths.mjs）の拒否・許可ケースを検査する。
// 判定モジュールが壊れている場合（構文エラー・例外・固まる）に入口が終了コード 2 を返すことも検査する。
// 使い方: node scripts/test-protect-hook.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, '.claude/hooks/run-protect.mjs');
const P = (rel) => path.join(root, rel);

// [説明, 入力, 期待 exit code]
const cases = [
  ['Edit docs/spec.md', { tool_name: 'Edit', tool_input: { file_path: P('docs/spec.md') } }, 2],
  ['Write web/tests/property/x.test.ts', { tool_name: 'Write', tool_input: { file_path: P('web/tests/property/x.test.ts') } }, 2],
  ['Write web/tests/golden/g.test.ts', { tool_name: 'Write', tool_input: { file_path: P('web/tests/golden/g.test.ts') } }, 2],
  ['Write golden/case.json', { tool_name: 'Write', tool_input: { file_path: P('golden/case.json') } }, 2],
  ['Edit .claude/settings.json', { tool_name: 'Edit', tool_input: { file_path: P('.claude/settings.json') } }, 2],
  ['Edit .claude/hooks/protect-paths.mjs', { tool_name: 'Edit', tool_input: { file_path: P('.claude/hooks/protect-paths.mjs') } }, 2],
  ['Edit 相対パス ../docs/spec.md (cwd=web)', { tool_name: 'Edit', cwd: P('web'), tool_input: { file_path: '../docs/spec.md' } }, 2],
  ['Edit 大文字小文字違い DOCS/Spec.md', { tool_name: 'Edit', tool_input: { file_path: P('DOCS/Spec.md') } }, 2],
  ['Bash sed -i docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'sed -i s/a/b/ docs/spec.md' } }, 2],
  ['Bash echo > golden/x', { tool_name: 'Bash', tool_input: { command: 'echo 1 > golden/x.json' } }, 2],
  ['Bash rm web/tests/property/a', { tool_name: 'Bash', tool_input: { command: 'rm web/tests/property/a.test.ts' } }, 2],
  ['Bash git checkout -- docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'git checkout -- docs/spec.md' } }, 2],
  ['PowerShell Set-Content docs\\spec.md', { tool_name: 'PowerShell', tool_input: { command: 'Set-Content docs\\spec.md "x"' } }, 2],
  ['壊れた入力は拒否', null, 2],
  // ヒアドキュメント・-m の除外ですり抜けないこと
  ['Bash cat > docs/spec.md <<EOF（リダイレクト先は検査）', { tool_name: 'Bash', tool_input: { command: "cat > docs/spec.md <<'EOF'\nx\nEOF" } }, 2],
  ['Bash cat <<EOF > golden/x.json', { tool_name: 'Bash', tool_input: { command: "cat <<'EOF' > golden/x.json\n{}\nEOF" } }, 2],
  ['Bash ヒアドキュメント後の rm docs/spec.md', { tool_name: 'Bash', tool_input: { command: "cat > /tmp/x <<'EOF'\nx\nEOF\nrm docs/spec.md" } }, 2],
  ['Bash 展開される本文の $(rm docs/spec.md)', { tool_name: 'Bash', tool_input: { command: 'cat > /tmp/x <<EOF\n$(rm docs/spec.md)\nEOF' } }, 2],
  ['Bash python - <<EOF の本文（スクリプト）は検査', { tool_name: 'Bash', tool_input: { command: "python - <<'EOF'\nopen(\"docs/spec.md\", \"w\").write(\"x\")\nEOF" } }, 2],
  ['Bash cat <<EOF | sh の本文は検査', { tool_name: 'Bash', tool_input: { command: "cat <<'EOF' | sh\nrm docs/spec.md\nEOF" } }, 2],
  ['Bash 本文内の -m で後続を隠せない', { tool_name: 'Bash', tool_input: { command: "python - <<'EOF'\nx -m '\nEOF\nrm docs/spec.md\n'" } }, 2],
  ['Bash git commit -m "x" > docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'git commit -m "x" > docs/spec.md' } }, 2],
  ['Bash git commit -m "$(rm docs/spec.md)"', { tool_name: 'Bash', tool_input: { command: 'git commit -m "$(rm docs/spec.md)"' } }, 2],
  ['Bash -m のヒアドキュメント後の && rm docs/spec.md', { tool_name: 'Bash', tool_input: { command: "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && rm docs/spec.md" } }, 2],
  ['Bash 文字列中の -m で後続を隠せない', { tool_name: 'Bash', tool_input: { command: 'echo " -m " > docs/spec.md " "' } }, 2],
  ['PowerShell -m "a\\" > docs/spec.md; "', { tool_name: 'PowerShell', tool_input: { command: 'git commit -m "a\\" > docs/spec.md; "' } }, 2],
  ['PowerShell ヒア文字列の後の Set-Content', { tool_name: 'PowerShell', tool_input: { command: "$m = @'\nx\n'@\nSet-Content docs/spec.md $m" } }, 2],
  // 許可されるべきもの
  ['Edit web/tests/unit/a.test.ts', { tool_name: 'Edit', tool_input: { file_path: P('web/tests/unit/a.test.ts') } }, 0],
  ['Edit web/src/core/prng.ts', { tool_name: 'Edit', tool_input: { file_path: P('web/src/core/prng.ts') } }, 0],
  ['Edit docs/spec.md.bak（別ファイル）', { tool_name: 'Edit', tool_input: { file_path: P('docs/spec.md.bak') } }, 0],
  ['Read docs/spec.md', { tool_name: 'Read', tool_input: { file_path: P('docs/spec.md') } }, 0],
  ['Bash cat docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'cat docs/spec.md | grep 決定' } }, 0],
  ['Bash git diff docs/spec.md 2>/dev/null', { tool_name: 'Bash', tool_input: { command: 'git diff docs/spec.md 2>/dev/null' } }, 0],
  ['Bash git add docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'git add docs/spec.md' } }, 0],
  ['Bash 保護対象外へのヒアドキュメント（本文に保護パスと rm）', { tool_name: 'Bash', tool_input: { command: "cat > scripts/x.mjs <<'EOF'\n// docs/spec.md は rm しない\nEOF" } }, 0],
  ['Bash git commit -m "$(cat <<EOF …)"（本文に spec.md と <…>）', { tool_name: 'Bash', tool_input: { command: "git commit -m \"$(cat <<'EOF'\ndocs/spec.md v0.7\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)\"" } }, 0],
  ['Bash git commit -m "docs/spec.md … <…>"', { tool_name: 'Bash', tool_input: { command: 'git commit -m "docs/spec.md を更新 <noreply@anthropic.com>"' } }, 0],
  ["PowerShell git commit -m 'docs/spec.md > 更新'", { tool_name: 'PowerShell', tool_input: { command: "git commit -m 'docs/spec.md > 更新'" } }, 0],
];

let fail = 0;
for (const allow of [false, true]) {
  for (const [name, input, expected] of cases) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    delete env.ALLOW_PROTECTED;
    if (allow) env.ALLOW_PROTECTED = '1';
    const r = spawnSync('node', [hook], { input: input === null ? '{not json' : JSON.stringify(input), env, encoding: 'utf-8' });
    // ALLOW_PROTECTED=1 のときは、正しい入力はすべて通る（壊れた入力は常に拒否）
    const want = allow && input !== null ? 0 : expected;
    const ok = r.status === want;
    if (!ok) fail++;
    console.log(`${ok ? 'OK  ' : 'NG  '} [ALLOW=${allow ? 1 : 0}] exit=${r.status} (期待 ${want})  ${name}`);
  }
}
// settings.json が入口を呼んでいること（判定モジュールを直接呼ぶと、壊れたときに保護が外れる）
{
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf-8'));
  const commands = settings.hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  const ok = commands.length === 1 && commands[0].endsWith('/.claude/hooks/run-protect.mjs"');
  if (!ok) fail++;
  console.log(`${ok ? 'OK  ' : 'NG  '} settings.json の PreToolUse は run-protect.mjs だけを呼ぶ: ${JSON.stringify(commands)}`);
}

// 壊れた判定モジュール: 入口を一時フォルダに複製し、隣に壊れた protect-paths.mjs を置いて実行する。
// （判定モジュールの場所を環境変数などで切り替えられるようにはしない。それ自体が保護の抜け道になるため。）
const broken = [
  ['構文エラー', 'export function check( {\n'],
  ['読み込み時に例外', "throw new Error('boom');\n"],
  ['check() が例外', "export function check() { throw new Error('boom'); }\n"],
  ['check() の Promise が拒否', "export async function check() { throw new Error('boom'); }\n"],
  ['check() が固まる（終わらない Promise）', 'export function check() { return new Promise(() => {}); }\n'],
  ['読み込みが固まる（終わらない top-level await）', 'await new Promise(() => {});\nexport function check() { return null; }\n'],
  ['check() を export していない', 'export const other = 1;\n'],
  ['非同期で例外（未処理）', "export function check() { setTimeout(() => { throw new Error('boom'); }, 0); return new Promise(() => {}); }\n"],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-hook-'));
try {
  fs.copyFileSync(hook, path.join(tmp, 'run-protect.mjs'));
  const allowedInput = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: P('README.md') } });
  for (const allow of [false, true]) {
    for (const [name, source] of broken) {
      fs.writeFileSync(path.join(tmp, 'protect-paths.mjs'), source);
      const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
      delete env.ALLOW_PROTECTED;
      if (allow) env.ALLOW_PROTECTED = '1';
      const r = spawnSync('node', [path.join(tmp, 'run-protect.mjs')], { input: allowedInput, env, encoding: 'utf-8', timeout: 30000 });
      // 本来は許可される入力でも、判定モジュールが壊れていれば拒否する
      const ok = r.status === 2;
      if (!ok) fail++;
      console.log(`${ok ? 'OK  ' : 'NG  '} [ALLOW=${allow ? 1 : 0}] exit=${r.status} (期待 2)  壊れた判定モジュール: ${name}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fail === 0 ? '全ケース期待どおり' : `${fail} 件が期待と不一致`);
process.exit(fail === 0 ? 0 : 1);
