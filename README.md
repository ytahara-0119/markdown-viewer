# MD Viewer

読むだけに特化した、Mac 向けの軽量 Markdown ビューアです。Rust(Tauri 2)製。

- フォルダを開くと、左に Markdown ファイルだけのツリーを表示
- ファイルをクリックすると整形表示(GFM:表・タスクリスト・脚注・取り消し線・`> [!NOTE]` などのアラート)
- Finder で `.md` をダブルクリックするとこのアプリで開く
- ファイルやフォルダをウィンドウにドロップしても開ける
- 外部エディタで保存すると自動で再読み込み(スクロール位置は維持)
- Markdown 内の相対リンク(`./other.md#見出し`)はアプリ内で移動、画像も表示
- macOS のライト/ダーク設定に自動追従(Rose Quartz テーマ)
- 前回開いていたフォルダとファイルを記憶

## ショートカット

| キー | 動作 |
|---|---|
| ⌘O | フォルダを開く |
| ⌘P / ⌘K | ファイル名で絞り込み(Enter で先頭を開く) |
| ⌘B | サイドバーの表示/非表示 |
| ⌘R | 再読み込み |
| ⌘+ / ⌘− / ⌘0 | 文字サイズ 大きく / 小さく / 元に戻す |

## 必要なもの

- Rust(`rustup` で入れたもの)
- Xcode Command Line Tools(`xcode-select --install`)
- Tauri CLI:

```sh
cargo install tauri-cli --version "^2" --locked
```

Node.js は不要です(画面は素の HTML/CSS/JS)。

## 動かす

```sh
cd src-tauri
cargo tauri dev      # 開発用に起動
cargo tauri build    # .app を作成
```

ビルドが終わると `src-tauri/target/release/bundle/macos/MD Viewer.app` ができます。
これを「アプリケーション」フォルダにドラッグしてください。

## .md をダブルクリックで開くようにする

1. Finder で任意の `.md` ファイルを選んで ⌘I(情報を見る)
2. 「このアプリケーションで開く」で **MD Viewer** を選ぶ
3. 「すべてを変更…」を押す

以降、どの `.md` もダブルクリックで MD Viewer が開きます。

## テーマを変える

`ui/theme.css` は shadcn 形式の CSS 変数(`--background`, `--primary` など)で書いてあり、
`:root` がライト、`.dark` がダークです。
Morphous ギャラリーの「Copy all」でコピーした CSS で丸ごと置き換えれば、そのまま反映されます。

## アイコンを変える

元データは `src-tauri/app-icon.png`(1024×1024px の透過 PNG)です。
`src-tauri/icons/` の中身はここから自動生成するので、直接編集しません。

```sh
cd src-tauri
cargo tauri icon app-icon.png   # icons/ 一式を再生成
touch src/main.rs               # アイコンを埋め込み直すため再コンパイルさせる
cargo tauri dev
```

元データを作るときの決まり(macOS 標準のアイコン寸法):

- キャンバスは 1024×1024px、背景は透明
- 角丸タイルは 824×824px で中央に置く(上下左右の余白は各 100px)
- 角丸の半径は約 185px

タイルをキャンバスいっぱいに描いたり、余白を広く取りすぎたりすると、Dock で他のアプリより大きく/小さく見えます
(以前はタイルがキャンバスの約 65% しかなく、小さく表示されていました)。

反映されないとき:

- アイコンはコンパイル時にバイナリへ埋め込まれますが、画像を差し替えただけでは Cargo が再コンパイルしないことがあります。
  `touch src/main.rs` で直らなければ `cargo clean -p folio` のあとにビルドし直します。
- Dock に古いアイコンが残る場合は `killall Dock` を実行します。

## 構成

```
ui/                 画面(index.html / style.css / theme.css / app.js)
src-tauri/
  src/main.rs       起動・Finder からのファイル受け取り・フォルダ監視
  src/markdown.rs   Markdown → HTML(pulldown-cmark)、画像/リンクの書き換え
  src/tree.rs       サイドバー用のファイルツリー
  tauri.conf.json   ウィンドウ・ファイル関連付け・セキュリティ設定
  app-icon.png      アイコンの元データ(icons/ はここから生成)
```

ツリーには隠しフォルダと `node_modules` / `target` / `dist` / `build` / `vendor` は表示しません(`tree.rs` で変更可)。

## テスト

```sh
cd src-tauri && cargo test
```
