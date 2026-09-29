# リアルFIREシミュレーター

初期資産・FIRE期間・年間生活費・投資対象を入力すると、モンテカルロ法と過去の実際の市場データで
「資産が最後までもつ確率（成功率）」を表示する、サーバーレスの公開Webアプリです。

> **免責**: 本アプリは教育・情報提供を目的としたもので、投資助言ではありません。
> 過去の実績は将来の成果を保証しません。税金・年金・手数料の一部は考慮していません。

## 設計の要点

- **サーバーを持たない**: シミュレーションはブラウザ（Web Worker）で実行。ホスティングは Firebase Hosting（Spark プラン）の静的配信のみで、課金リスクはゼロ。（[ADR-0001](docs/adr/0001-serverless-client-side-simulation.md)）
- **Python は検証とデータ整備に使う**: データ取得・加工と、NumPy によるリファレンス実装（TypeScript 実装の正解データ）を担当。
- **AI（Claude Code）による自己改善ループ**: テスト・プロパティ検査・性能ゲートを合格基準に、実装と改善を反復。記録は [docs/loop-log.md](docs/loop-log.md)。

## リポジトリ構成

```
real-fire-simulator/
├─ CLAUDE.md                  Claude Code 向けの規約・コマンド・禁止事項
├─ README.md
├─ firebase.json              Hosting 設定（キャッシュ・セキュリティヘッダ）
├─ .firebaserc                Firebase プロジェクトID（要書き換え）
├─ docs/
│  ├─ spec.md                 仕様書（人間が承認して変更する）
│  ├─ loop-log.md             自己改善ループの実行ログ
│  └─ adr/                    設計判断記録
├─ data/
│  ├─ raw/                    取得した生データ（git管理外）
│  └─ processed/              整形済み年次データ JSON（git管理・配信対象）
├─ pipeline/                  Python（uv/pip + pytest）
│  ├─ src/fire_data/          データ取得・加工
│  ├─ reference/              NumPy リファレンス実装
│  └─ tests/
├─ golden/                    リファレンス出力（TS実装の正解データ・保護対象）
├─ web/                       Vite + React + TypeScript
│  ├─ src/
│  │  ├─ core/                シミュレーション本体（純粋関数・UI非依存）
│  │  ├─ worker/              Web Worker ラッパ
│  │  └─ ui/                  画面・グラフ
│  ├─ tests/
│  │  ├─ unit/
│  │  ├─ property/            fast-check（保護対象）
│  │  └─ golden/              ゴールデン照合（保護対象）
│  └─ e2e/                    Playwright
├─ scripts/                   ゲート実行・ループ用スクリプト
├─ .claude/
│  ├─ agents/                 サブエージェント定義（フェーズ4）
│  ├─ commands/               スラッシュコマンド（フェーズ4）
│  └─ settings.json           Hooks（フェーズ4）
└─ .github/workflows/         CI とデプロイ
```

## デプロイ（概要）

1. Firebase コンソールでプロジェクトを作成（Spark プランのまま。Firestore/Auth/Storage は有効化しない）
2. `.firebaserc` のプロジェクトIDを書き換える
3. `cd web && npm run build` → リポジトリ直下で `firebase deploy --only hosting`

## ライセンス・データ出典

データの出典とライセンスは `data/processed/SOURCES.md`（フェーズ1で作成）に記載します。
