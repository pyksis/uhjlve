# 第三方组件

- Parsoid 0.11.1，Wikimedia Foundation 及贡献者，GPL-2.0-or-later。源码和许可证位于 `runtime/parsoid/`。
- Node.js 14.21.3，Node.js contributors，MIT。许可证位于 `runtime/node/LICENSE`。
- VisualEditor 前端由 `unimage.huijiwiki.com` 的 MediaWiki 1.38.4 ResourceLoader 在运行时提供。本工具针对官方 VisualEditor `REL1_38` 接口实现接桥；VisualEditor 采用 MIT 许可证。

本项目自编写的接桥与启动脚本可按 MIT 许可证使用。

为适配灰机 API，随附 Parsoid 做了两处可审计的兼容修改：依赖锁中已失效的 `wikimedia/content-type` 提交改为该仓库当前提交；`AddMediaInfo.extractInfo` 将灰机返回的 `filemissing` 识别为不存在的文件，避免缺图条目导致转换进程退出。有效图片仍使用 API 返回的实际尺寸和 URL。
