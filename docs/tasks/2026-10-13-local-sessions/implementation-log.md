# Implementation Log

### 2026-10-13 — 保留 pi 兼容入口，新增独立入口

- Decision: pi 原 ID 保持不变，Claude Code/Codex 使用来源前缀；两种入口共享原有元数据目录。
- Reason: 旧的 pi-web 来源链接、AI 讲解和用户整理结果依赖原 ID，直接迁移会造成兼容性回归。
- Decision: 多来源模式只修改管理器元数据，隐藏原始文件删除；pi 单来源模式保留原删除行为。
- Reason: 当前仅能识别绑定 pi 的活动会话，不能可靠判断其他 CLI 是否正在写入记录，也不能同步它们的原生索引。
- Decision: 将外部记录转换为内部 pi 事件结构，复用对话、图片和复盘渲染。
- Reason: 已有内部结构能表达工具调用及结果，减少重复的展示和导出逻辑；格式适配保留各来源的分支和压缩语义。
- Validation: 修改前类型检查和 37 个测试通过。
- Git: main，基线 df7602f；实现尚未提交。

### 2026-10-13 — 验证与兼容性修正

- Decision: 独立入口禁用原始文件删除；pi 插件入口对 pi 来源继续保留原生重命名、切换和回收站删除。这细化了首条日志中的多来源删除边界。
- Reason: 保留既有 pi 使用方式，同时不把其他工具的文件传给 pi 的绑定接口。
- Discovery: pi-web 会对 HTTP listener 调用 unref，独立 CLI 在打印地址后立即退出。
- Resolution: 独立 CLI 自己维持进程引用并在 SIGINT/SIGTERM 时清理；未修改各 pi 插件共享的 hub.ts。
- Discovery: Codex 会同时记录 response_item 与 event_msg；AGENTS 环境信息可能以 user role 存储。只读 response_item 的正文，环境信息显示为上下文标注，避免重复对话和错误标题。
- Validation: 50 个测试及类型检查通过；本机识别 pi 22、Claude Code 66、Codex 24 个会话。浏览器演示验证来源过滤、置顶、标题持久化和 Codex 构建复盘。仅运行时依赖的安装可以在无 pi 依赖时显示 CLI help。
- Git: main，基线 df7602f；代码仍未提交或发布。
