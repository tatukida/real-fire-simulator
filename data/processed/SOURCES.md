# データ出典・ライセンス

配信するのは、下記の生データから計算した**年次の加工値**（`returns.json`）のみです。生データは配信しません。
ライセンス状態は `pipeline/src/fire_data/config.py` で管理し、配信前に `python -m fire_data.validate --strict` で検査します。
画面に表示する出所・加工表記は、使用した系列の分だけ `returns.json` の `attribution.notice_ja` に自動生成されます。

| ID            | 内容                                                                             | 期間（完全な暦年）              | 状態                           |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------- | ------------------------------ |
| DAMODARAN     | S&P500（配当込み）・金の年次リターン、インフレ率                                 | S&P500: 1928年〜 / 金: 1972年〜 | **cleared**                    |
| JST           | 先進18か国の株式総合リターン・対米ドル為替（年次）→ 先進国株式（等ウェイト合成） | 1950年〜2020年（使用範囲）      | **cleared**（CC BY-NC-SA 4.0） |
| FRED_CPIAUCNS | 米国CPI（BLS, 月次）                                                             | 1914年〜                        | **cleared**                    |
| FRED_DEXJPUS  | 円/ドル為替（日次）                                                              | 1972年〜                        | **cleared**                    |
| JP_CPI        | 日本の消費者物価指数（総合, 月次）                                               | データ次第（1970年〜を想定）    | **cleared**                    |

## ソースごとの記録

### DAMODARAN

- 提供元: Aswath Damodaran（ニューヨーク大学スターン経営大学院）、`histretSP.xls`（Historical Returns on Stocks, Bonds and Bills）。
- 内容: 年次の名目USDリターン表。S&P500（配当込み）と金は 1928〜2025年、インフレ率の列あり。
- Damodaran のデータはすべて独自に加工したものであり、使用に問題なし。同サイトの「Usage rules」にも「this data is here for you to use」、謝辞は任意とある。
- 金は、1971年8月の金兌換停止までは公定価格のため、**1972年以降のみ使用**（`config.py` の `ASSET_START_FLOOR`。変更可）。
- 年ずれ検査: 表のインフレ列を FRED CPI 由来のインフレと突き合わせ、年のずれを `validate` が警告する（`returns.json` の `checks`）。
- 系列の限界: S&P500 は 1928年〜（約98年）。

### JST

- 利用日: 2026-09-29
- 提供元: Jordà-Schularick-Taylor Macrohistory Database, Release 6（`JSTdatasetR6.xlsx`）。引用: Jordà, Schularick and Taylor (2019), _The Rate of Return on Everything, 1870-2015_, Quarterly Journal of Economics 134(3)。利用日は公開時に追記すること（提供元の依頼）。
- ライセンス: **CC BY-NC-SA 4.0**（表示・非営利・継承）。非営利の無料Webアプリとして公開し、加工後データも同条件で公開することに問題なし。**広告・課金を入れない**こと。
- 加工: 国別の株式総合リターン `eq_tr`（名目・現地通貨）を、`xrusd`（現地通貨/USD）の前年比で USD 建てに換算し、有効な国が10か国以上ある年について等ウェイト平均。1950年より前は使わない（戦後の混乱期を避けるため。`config.py` の `ASSET_START_FLOOR`）。
- 限界: 時価総額加重ではなく、米国を含む18か国の単純平均。データベースの最終年は2020年（以降は含まれない）。
- 加工後の `returns.json` は同じ CC BY-NC-SA 4.0 の条件で提供される。

### FRED_CPIAUCNS / FRED_DEXJPUS

- CPIAUCNS: 系列ページで「public domain with citation requested」（発行元: 米国労働統計局）、1913年1月〜を確認。年次インフレは12月値どうしの比。
- DEXJPUS: 系列ページで「Public Domain: Citation Requested」を確認。年次変化は12月最終営業日の値どうしの比。

### JP_CPI

- 出所を明記し、加工したのは開発者である旨を記載すれば利用可（国が加工後のデータを作成・公表したように見せてはならないため）。
- 入手: e-Stat「品目別価格指数（全国・月次）」CSV（総合、1970年1月〜）。`python -m fire_data.convert_jp_cpi` で `data/raw/manual/jp_cpi.csv` に変換する（手順は `data/README.md`）。年次のインフレは12月どうしの比。

## 画面表示用の文言（`attribution.notice_ja` の内容）

米国株式・金・先進国株式・為替・米国CPI・日本CPIを使う場合:

> 【使用データおよび出所について】本アプリのシミュレーションには、以下のオープンデータおよび学術公開データを使用しています。
> ・米国株式（S&P 500・配当込み）・金価格：アスワス・ダモダラン教授（ニューヨーク大学スターン経営大学院）公開データ
> ・先進国株式：Jordà-Schularick-Taylor Macrohistory Database（Release 6）（Jordà, Schularick and Taylor, 2019, Quarterly Journal of Economics）。ライセンス CC BY-NC-SA 4.0
> ・為替（円/ドル）：連邦準備制度理事会（FRB）H.10 / FRED（セントルイス連邦準備銀行）
> ・米国CPI：米国労働統計局（BLS）／FRED（セントルイス連邦準備銀行）
> ・日本CPI（インフレ率）：総務省統計局ホームページ「消費者物価指数（CPI）」をもとに作成
> ※本アプリに搭載されている各種計算結果は、上記出所のデータを基に開発者が独自に統計・シミュレーション加工を行ったものであり、各提供元が作成・公表したものではありません。
> 先進国株式は、上記データベースの先進18か国の株式総合リターン（現地通貨建て）を、為替で米ドル建てに換算したうえで、開発者が各年の等ウェイト平均として合成したものです（時価総額加重の指数ではありません）。この加工後データは非営利目的に限り、CC BY-NC-SA 4.0 の条件で利用できます。
> 本アプリのインフレ調整シミュレーションは、総務省統計局の「消費者物価指数（CPI）」のデータを基に、開発者が独自に計算・加工して構築したものです。

英語表記は各ソースの `attribution_en`（`config.py`）を参照。
