# golden/ — ゴールデンデータ

`docs/spec.md` 6.2 のゴールデンテストが使う正解データ。Python 参照実装（`pipeline/reference/`）が出力し、**人間が生成して承認した**もの。
TS 実装（`web/src/core/`）の結果を、`web/tests/golden/golden.test.ts` がこのデータと許容誤差内で比べる。

- `index.json`: spec のバージョン、生成日時、Python と NumPy のバージョン、ケース ID の一覧
- `cases/<ID>.json`: 各ケースの入力（系列を含む）、許容誤差、出力

ケースの一覧・JSON の構造・許容誤差は `docs/golden-cases.md`、比較の決定は `docs/spec.md` 7章 決定済み 21。

## 扱い

- **保護対象**。CLAUDE.md の保護対象であり、PreToolUse フックが編集を拒否する。
- **手で編集しない**。値を直すときも、必ず生成器で再生成する。
- テストが合わないときに、ゴールデンを合わせて直してはならない。不一致はケース ID・項目・両方の値を人間に報告し、どちらが spec に沿っているかは人間が判断する。
- **再生成は spec が変わったときだけ**行う（計算仕様やケース一覧が変わった場合）。TS 実装の都合で再生成しない。

## 再生成の手順（人間が行う）

```sh
cd pipeline && python -m reference.generate_golden <出力先>
```

1. 一時ディレクトリなどに出力し、内容と差分を確認する。
2. 承認したら `golden/` に置き換える（保護解除 `ALLOW_PROTECTED=1` が必要）。
3. コミットメッセージに、spec のバージョンと**生成に使った生成器のコミット**を書く。
   例: `ゴールデンを生成（spec v0.8、生成器 85c2cdb）`
