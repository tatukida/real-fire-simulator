# CLAUDE.md — リアルFIREシミュレーター

Claude Code 向けのプロジェクト規約。作業前に必ず読むこと。仕様の正は `docs/spec.md`。

## プロジェクト概要

初期資産・FIRE期間・年間生活費・投資対象（S&P500 / 先進国株式 / ゴールド）・通貨（USD / JPY）を入力すると、
モンテカルロ法と過去データで「資産が最後までもつ確率（成功率）」を表示するサーバーレスWebアプリ。
IT エンジニアの公開ポートフォリオ。**課金リスクゼロ**と**検証の質**が最重要の設計目標。

## アーキテクチャ（変更禁止の前提）

- サーバーなし。計算は `web/src/core`（純粋関数）を Web Worker から呼ぶ。詳細は `docs/adr/0001-*.md`。
- 配信は Firebase Hosting（Spark）の静的ファイルのみ。
- **使ってはいけないもの**: Firestore / Auth / Cloud Storage / Cloud Functions / Analytics / 外部API呼び出し / 外部CDN（CSP は `'self'` のみ）。Blaze が必要になる変更は行わない。
- Python は `pipeline/`（データ整備）と `pipeline/reference/`（NumPy リファレンス実装）のみ。本番配信物に Python は含めない。

## ディレクトリ

`README.md` のリポジトリ構成を参照。`core/` は UI・DOM・React に依存させない（Worker と Node テストの両方で動くこと）。

## コマンド（フェーズ1〜で整備。整備前は存在しない）

| 目的 | コマンド |
|---|---|
| Web 依存導入 | `cd web && npm ci` |
| 開発サーバ | `cd web && npm run dev` |
| 型チェック | `cd web && npm run typecheck` |
| Lint | `cd web && npm run lint` |
| 単体・プロパティ・ゴールデン | `cd web && npm test` |
| E2E | `cd web && npm run e2e` |
| ビルド | `cd web && npm run build` |
| Python テスト | `cd pipeline && pytest` |
| データ取得 / 加工 / 検証 | `cd pipeline && python -m fire_data.fetch` / `.build` / `.validate --strict`（詳細は `data/README.md`） |
| ゴールデン再生成 | `python -m reference.generate_golden`（**人間の承認が必要**） |
| 全ゲート | `scripts/gates.sh`（フェーズ4で作成） |

## 品質ゲート（すべて合格で完了）

1. 型チェック・Lint が通る
2. 単体 / プロパティ / ゴールデンテストが通る
3. Python テストが通る
4. 性能: 50,000 パス × 40 年が Worker 上で 2 秒以内（基準環境）
5. バンドル: 初回ロード JS + CSS が gzip 後 300KB 以下、`data/processed` の配信JSON合計 200KB 以下
6. E2E とアクセシビリティ（axe）に重大違反なし

ゲートの基準値を緩める変更は禁止。緩める必要があると考えたら、実装を止めて人間に相談する。

## 保護対象（編集禁止。変更は人間の承認が必要）

- `docs/spec.md`
- `web/tests/property/**`、`web/tests/golden/**`
- `golden/**`
- `pipeline/tests/**` のうち、仕様を表すテスト
- `firebase.json` のセキュリティヘッダ（CSP など）
- 品質ゲートの閾値

上記のうち `docs/spec.md`・`web/tests/property/`・`web/tests/golden/`・`golden/`、およびフック自身（`.claude/settings.json`・`.claude/hooks/`）への編集は、
PreToolUse フック（`.claude/hooks/protect-paths.mjs`）が拒否する。人間が承認した場合のみ `ALLOW_PROTECTED=1` を付けて Claude Code を起動すると解除される。
フックの判定は `node scripts/test-protect-hook.mjs` で検査できる。拒否されたら回避策を探さず、人間に報告する。

**テストを書き換えて合格させてはならない。** テストが誤っていると思う場合も、修正せず理由を報告する。
新しいテストの追加は歓迎（`web/tests/unit/` など保護対象外の場所に追加）。

## 実装ルール

- 言語: TypeScript は `strict`。`any` 禁止。Python は型注釈 + ruff。
- 乱数はシード付き PRNG（xoshiro128** など）のみ。`Math.random()` を `core/` で使わない。同じシード・入力で TS と Python が近い結果を返すこと。
- 金額は内部では**実質（インフレ調整後）** の数値で扱う。通貨は表示・換算層で処理する。
- 通貨換算（JPY）は `(1+USDリターン)×(1+USD/JPY変化率)−1`。為替データは別系列として保持し、実行時に合成する。
- 依存は最小限。追加時は理由とバンドル増加量を PR に書く。
- UI 文言は日本語。免責表示（`docs/spec.md` の文言）を常に画面に出す。
- 出典・ライセンスは `data/processed/SOURCES.md` に必ず記載。ライセンス不明の系列は配信しない。
- 画面には `returns.json` の `attribution.notice_ja`（出所・加工表記）を常時表示する。文言は変えない。
- `WORLD_DM` は先進18か国の等ウェイト合成であり、MSCI ACWI（オルカン）や時価総額加重の指数ではない。UI・文書で「オルカン」「ACWI」と呼ばない。CC BY-NC-SA 4.0 の表記（`attribution.notice_ja`）を必ず表示し、非営利の無料公開を前提とする。
- 標本不足の注意表示（`docs/spec.md` 4章 項目9）と 3 手法の併記を実装する。

## 作業の進め方

1. 変更前に関連する `docs/spec.md` の節を確認する。
2. 小さく変更し、都度関連テストを実行する。
3. 不明点・仕様の穴は推測で埋めず、`docs/spec.md` の「未決事項」に追記する提案を人間に出す。
4. ループ実行時は各イテレーションを `docs/loop-log.md` に追記する（失敗したゲート / 原因 / 変更点 / 結果）。
5. 1イテレーションの変更は原則 300 行以内。最大反復回数はループ設定に従い、超えたら停止して報告する。

## 禁止事項

- 機密情報・APIキーのコミット（このアプリに秘密情報は不要）
- 保護対象の編集、ゲート緩和、テストの skip / xfail による回避
- 外部への通信を追加すること
- 投資助言と受け取れる表現（「おすすめ」「必ず」など）の追加

## フェーズ状況

現在: **フェーズ2（コア実装）** 進行中。
- フェーズ1（データ整備）完了。ライセンス判断は `docs/adr/0002-data-sources.md`。実データで `returns.json` を生成済み（SP500 1928〜2025、GOLD 1972〜2025、WORLD_DM 1950〜2020、USD/JPY 1972〜2025）。
- `docs/spec.md` は v0.6 で承認済み。計算仕様の補足は 7章「決定済み（v0.6）」を参照。
- フェーズ2の手順: ① `web/` 最小構成 → ② PRNG（TS/Python） → ③ データ合成 → ④ エンジン・生成器 → ⑤ プロパティテスト（**人間の承認が必要**） → ⑥ 統計・逆算・注意表示 → ⑦ リファレンス実装とゴールデン（**生成は人間**） → ⑧ Worker・性能 → ⑨ ADR-0003（サニティ範囲・閾値）。
