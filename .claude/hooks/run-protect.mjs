#!/usr/bin/env node
// PreToolUse フックの入口（.claude/settings.json から呼ぶ）。判定は protect-paths.mjs の check() に任せ、
// 終了コード（0 = 許可、2 = 拒否）はこのファイルだけが決める。
//
// Claude Code は終了コード 2 のときだけツール呼び出しを止める。判定モジュールが壊れていても保護が外れないように、
// 構文エラー・例外・未処理の Promise 拒否・時間切れ（固まる）は、すべて終了コード 2（拒否）にする。
// このファイル自体が壊れると保護が外れるため、小さく保つ。検査: node scripts/test-protect-hook.mjs

// Claude Code のフックのタイムアウト（既定 60 秒）より前に拒否する。
const TIMEOUT_MS = 5000;

function deny(reason) {
  process.stderr.write(`protect-paths フックの実行に失敗したため拒否します: ${reason}\n`);
  process.exit(2);
}

process.on('uncaughtException', (err) => deny(err));
process.on('unhandledRejection', (err) => deny(err));
setTimeout(() => deny(`判定が ${TIMEOUT_MS}ms 以内に終わりませんでした`), TIMEOUT_MS);

try {
  // 動的 import にすることで、判定モジュールの構文エラーもここで捕まえられる。
  const { check } = await import('./protect-paths.mjs');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const reason = await check(JSON.parse(raw || '{}'));
  if (reason) {
    process.stderr.write(reason);
    process.exit(2);
  }
  process.exit(0);
} catch (err) {
  deny(err);
}
