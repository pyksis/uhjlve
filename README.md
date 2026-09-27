# 灰机本地 VisualEditor

这是为 `unimage.huijiwiki.com` 制作的单页可视化编辑工具。它直接使用灰机服务器下发的 MediaWiki VisualEditor 1.38 前端，把失效的 REST/Parsoid 转换移到本机，再用当前浏览器登录状态调用 MediaWiki `action=edit` 发布。

当前程序版本为 1.0.4；原有文件夹名称可以继续保留。保留发布转换空值崩溃修复，同时恢复优先直连 API，缩短浏览器轮询占用连接的时间，并让提交复用打开页面时同一修订的原始 HTML 和源码，减少重新解析及超时重试。转换继续使用选择性序列化，以保留未修改区域的原始维基文本和模板调用。

## 浏览器插件

`extension/` 中的 Edge/Chrome 扩展只是连接桥梁。它负责把灰机页面中的 VisualEditor 接到本机，但无法独自完成模板感知的 HTML 与维基文本双向转换。`runtime/parsoid/` 是这项转换所需的 Wikimedia Parsoid，其中还包含较大的中文繁简和地区词转换数据；`runtime/node/node.exe` 用来独立运行 Parsoid。因此完整便携包仍有一定体积。

原来的 `HuijiLocalVisualEditor-Extension-1.0.1.zip` 是旧版插件。使用本次更新时，应在扩展管理页重新加载本目录中的 `extension/`，并停止其他目录加载的同类扩展。插件必须与本完整包启动的本地服务配合，不能单独代替 Parsoid。

## 使用

1. 双击 `启动灰机本地可视化编辑器.cmd`。
2. 工具会打开一个独立的 Edge 应用窗口。第一次使用时，请在该窗口登录灰机账号并确认邮箱，然后重新打开要编辑的页面。
3. 页面右下角出现“本地 Parsoid 0.11.1 已连接”后，点击“编辑”或使用地址中的 `veaction=edit`。
4. 在 VisualEditor 中编辑，最后使用原生“发布更改”对话框填写摘要并发布。
5. 不再使用时可双击 `停止本地服务.cmd`。

也可以把任意本站页面 URL 作为启动脚本的第一个参数：

```bat
启动灰机本地可视化编辑器.cmd "https://unimage.huijiwiki.com/wiki/页面名"
```

## 功能

- 段落与一至六级标题
- 粗体、斜体、删除线、上标、下标等格式
- 内部链接与外部超链接
- 有序列表、无序列表、缩进
- 表格插入、增删行列、合并单元格、表头样式
- 图片/媒体搜索、插入、说明文字、尺寸与对齐；上传权限仍由灰机账号决定
- 模板搜索、参数编辑、灰机新手包中的 Infobox/Navbox 等模板展开
- 引用、特殊字符、注释、代码、数学公式（以站点已启用模块为准）
- 撤销/重做、查找替换、可视化与源代码切换
- 发布前预览和差异检查
- 以加载时的修订时间戳提交；远端页面已改变时由 MediaWiki 返回编辑冲突

## 工作方式

- `extension/`：把灰机 VisualEditor 的读取、片段解析、序列化、预览和发布流程接到本地服务。
- `runtime/parsoid/`：Wikimedia 官方 Parsoid 0.11.1；读取本站模板、模块和页面后生成 VisualEditor 所需的带注释 HTML。
- `app/huiji-api-proxy.js`：仅监听 `127.0.0.1:8143`，优先直接读取 API；被验证拦截或连接失败时，使用打开的灰机编辑页读取获准的页面、模板和媒体 API。拦截后一分钟内跳过重复的直连尝试。浏览器经 Parsoid 的 `8142/_bridge/` 通道接收请求。遇到浏览器验证时，按右下角提示打开验证页并完成验证后重试。
- `app/revision-snapshots.js`：在内存中保留已打开修订的原始 HTML 和源码，最多 32 MB、30 分钟，用于提交和差异转换。按站点、页面、修订号及 HTML 版本区分；重新打开页面仍会读取并展开最新模板，缓存失效后按原流程重新解析。
- 发布：扩展把编辑后的 HTML 交给本地 Parsoid 转成维基文本，然后在浏览器页面内使用 CSRF 令牌调用灰机 `action=edit`。账号 Cookie 和令牌不会交给本地 Parsoid 或代理。

该版本只匹配 `unimage.huijiwiki.com`，不做多站点或多页面迁移。模板和图片来自线上站点，因此编辑时需要联网。站点中的交互式 JavaScript 小工具不会在 VisualEditor 编辑画布内运行，但模板输出、站点 CSS 和 MediaWiki 内容节点会按官方编辑器方式呈现。

如果维基文本引用了只有文件说明页、实际文件不存在的图片，编辑器会保留原始图片语法并显示缺图节点；这与真正上传成功的图片不同。

## 验证

下列测试使用模拟 API 和本地中文维基配置，无需登录，也不会发布页面：

```powershell
& .\runtime\node\node.exe tests\api-relay.test.js
& .\runtime\node\node.exe tests\serializer.test.js
& .\runtime\node\node.exe tests\revision-snapshots.test.js
```

转换测试覆盖发布时的原文间隔空值崩溃、完整源码往返、可视化修改表格，以及未修改的模板、标题、链接、列表和注释保留。性能测试覆盖直连不等待浏览器、连接占满时轮询及时释放、原始修订复用及缓存过期和大小限制。
