# data/

- `raw/` : 取得した生データ（**git管理外**）。`python -m fire_data.fetch` で取得、または手動配置。
- `processed/` : 配信対象の加工済みJSON（`returns.json`）と出典（`SOURCES.md`）。

## raw/ の配置

```
data/raw/
├─ damodaran/histretSP.xls          Damodaran の年次リターン表（fetch または手動）
├─ jst/JSTdatasetR6.xlsx            JST Macrohistory Database Release 6（fetch または手動）
├─ fred/DEXJPUS.csv                 FRED 為替の CSV（fetch または手動）
├─ fred/CPIAUCNS.csv                FRED 米国CPI の CSV（fetch または手動）
└─ manual/
   └─ jp_cpi.csv                    日本CPI（月次、手動）
```

## 日本CPI（manual/jp_cpi.csv）の作り方

1. [e-Stat の消費者物価指数のファイル一覧](https://www.e-stat.go.jp/stat-search/files?toukei=00200573&tstat=000001243876&tclass1=000001243880)で、周期が**月次**の「品目別価格指数（全国）」CSV（1970年1月〜最新月）をダウンロードする。年度平均・年平均のファイルは使わない（12月どうしの比が取れないため）。
2. 変換する:

```bash
python -m fire_data.convert_jp_cpi <ダウンロードしたCSV>
```

`data/raw/manual/jp_cpi.csv` が作られる（総合・月次）。

## manual/jp_cpi.csv の形式

見出しは `date,value`。日付は `YYYY` / `YYYY-MM` / `YYYY-MM-DD`。

- `YYYY` は**年末の水準**として扱う（年次データは年末値を入れる）。
- 日本CPIは、12月値どうしの比でインフレ率を出すため、**月次**で12月が含まれること。

```csv
date,value
2019-11,101.6
2019-12,101.8
```

## 実行手順

```bash
cd pipeline
pip install -r requirements.txt
# fire_data は src/ 配下にあるため、モジュールの検索パスに src を追加する（ウィンドウごとに1回）
export PYTHONPATH=src                     # PowerShell: $env:PYTHONPATH = "src"
python -m fire_data.fetch                 # 取得できないものは手動配置
python -m fire_data.build                 # cleared のソースのみ使用（米国株式・金・先進国株式・為替・米国CPI・日本CPI）
python -m fire_data.build --allow-review  # 開発用: needs-review のソースも含める。配信には使わない
python -m fire_data.validate --strict     # 配信前。ライセンス状態と出所表記を検査
pytest
```
