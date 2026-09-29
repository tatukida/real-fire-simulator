// 保護対象フック（.claude/hooks/protect-paths.mjs）の拒否・許可ケースを検査する。
// 使い方: node scripts/test-protect-hook.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, '.claude/hooks/protect-paths.mjs');
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
  // 許可されるべきもの
  ['Edit web/tests/unit/a.test.ts', { tool_name: 'Edit', tool_input: { file_path: P('web/tests/unit/a.test.ts') } }, 0],
  ['Edit web/src/core/prng.ts', { tool_name: 'Edit', tool_input: { file_path: P('web/src/core/prng.ts') } }, 0],
  ['Edit docs/spec.md.bak（別ファイル）', { tool_name: 'Edit', tool_input: { file_path: P('docs/spec.md.bak') } }, 0],
  ['Read docs/spec.md', { tool_name: 'Read', tool_input: { file_path: P('docs/spec.md') } }, 0],
  ['Bash cat docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'cat docs/spec.md | grep 決定' } }, 0],
  ['Bash git diff docs/spec.md 2>/dev/null', { tool_name: 'Bash', tool_input: { command: 'git diff docs/spec.md 2>/dev/null' } }, 0],
  ['Bash git add docs/spec.md', { tool_name: 'Bash', tool_input: { command: 'git add docs/spec.md' } }, 0],
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
console.log(fail === 0 ? '全ケース期待どおり' : `${fail} 件が期待と不一致`);
process.exit(fail === 0 ? 0 : 1);
