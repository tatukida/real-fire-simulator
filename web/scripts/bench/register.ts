/**
 * Node で src/ の TypeScript を直接読むためのリゾルバ（ベンチマーク専用）。
 * src/ は拡張子なしで import する（Vite / Vitest の流儀）ので、相対パスに .ts を補う。型の除去は Node 本体が行う。
 * 登録はスレッドごとに必要。登録より前に静的 import したモジュールには効かないため、src/ は動的 import で読む。
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL !== undefined) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
