# Book Reader

极简浏览器电子书阅读器，基于 [foliate-js](https://github.com/readest/foliate-js) 内核。

**支持格式**：EPUB · MOBI · AZW3 · KF8 · FB2 · CBZ · PDF

## 启动

### 完整功能（含 TTS 后端）

```bash
pip3 install --user fastapi 'uvicorn[standard]' edge-tts
python3 server.py            # 默认端口 8765
# 浏览器打开 http://localhost:8765/
```

`server.py` 同时提供：
- 静态文件（index.html、app.js、style.css、vendor/）
- `GET /api/tts?text=...&voice=...&rate=...` — 流式 TTS，调用 Microsoft Edge 在线语音
- `GET /api/voices?locale=zh` — 列出可用语音

### 仅前端（无 TTS）

```bash
python3 -m http.server 8765
```

或直接双击 `index.html`（部分浏览器对 `file://` 协议下的 iframe/CSP 限制更严）。

## 用法

- **打开新书**：首页左侧拖拽文件 / 点击「Choose file…」/ `O` 键 / URL 参数 `?url=/path/to/book.epub`
- **继续上次**：首页右侧书架直接点击书项（自动恢复 CFI 进度），或工具栏 📚 / `Shift+L`
- **翻页**：`←` / `→` / `↑` / `↓` / `H` / `L` / 工具栏 ‹ › 按钮 / 鼠标点击页面左半边（上一页）或右半边（下一页），hover 时出现淡 ‹ / › chevron
- **跳页**：拖拽工具栏进度条（鼠标悬停显示页码 / 百分比）
- **单/双页切换**：`S` 键 / 工具栏「单页」按钮
- **缩放（fit-to-width）**：`+` / `−` 键，或工具栏 `−` / `+` 按钮（8 档位吸附：0.75× ~ 2×）
- **整页/宽度切换**：`W` 键（fit-to-page 取消宽度限制，fit-to-width 限制列宽）
- **字体族**：`F` 键 / 工具栏 `Sans` 按钮循环 Sans / Serif / Mono
- **字体大小**：工具栏 `S / M / L / XL` 按钮循环（15 / 17 / 19 / 22 px）
- **目录**：工具栏 📑 / `C` 键（点击章节跳转；以玻璃浮层形式叠加在正文上，展开/收起不改变正文布局）
- **搜索**：工具栏 🔍 / `/` 键（输入即搜，实时结果显示在侧栏）
- **书签**：工具栏 🔖 / `B` 键（按一次在当前位置添加书签，弹出侧栏查看列表）
- **听书（TTS）**：工具栏 🔊 / `R` 键（调用 `server.py` 的 `/api/tts` 走 Microsoft Edge 在线语音，音质比浏览器内置好得多；底部出现圆形玻璃控制条，可换语音、调速 0.5×–2×、上一段/下一段/暂停/停止）
- **书架**：工具栏 📚 / `Shift+L` 键（任何时候打开过的书都会自动加入书架，含书名/作者/上次打开时间/进度小条；点击即恢复到最后阅读位置；首页 drop 卡片下也列出最近的书，方便快速继续阅读；✕ 删除单本）
- **主题**：`T` 键在「Liquid Glass / Sepia Glass / Dark Glass」三主题循环
- **关闭侧栏**：`Esc`

设置（缩放、单/双页、fit 模式、主题、阅读进度、书签、侧栏模式）持久化到 `localStorage`，每本书的书签按书的 identifier 分别保存。书架的书本体（用于刷新页面后重新打开）持久化到浏览器 IndexedDB。

## 文件结构

```
bookreader/
├── index.html      入口
├── style.css       主题 + 工具栏
├── app.js          薄壳：工具栏交互、localStorage、键盘
└── vendor/foliate-js/  解析 + 渲染核心（fork 自 readest/foliate-js）
```

主代码 3 个文件 ~ 9KB；vendored foliate-js 完整保留不修改。

## 已知限制

- 只支持无 DRM 的书（亚马逊加密的 `.azw`/`.azw3` 解析不了）
- 书架的 file blob 存浏览器 IndexedDB（如清理浏览器数据会丢；约支持每本几 MB 到几十 MB，超大书建议直接放服务器走 `?url=`）
- `?url=` 打开的书不加入书架（无法持久化跨域/服务器文件），仅本地拖拽 / choose 按钮的书会加入
