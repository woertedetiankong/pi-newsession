# Task Brief: 本机会话统一管理

> Created: 2026-10-13
> Parent plan: None found
> Status: Complete

## Goal

将 pi-sessions 扩展为可独立运行、管理本机 pi、Claude Code 和 Codex 会话的网页工具。

## Success Criteria

- 无需启动 pi 即可启动网页，读取本机三种会话格式。
- 支持来源筛选、项目和时间浏览、全文搜索、对话与工具结果阅读。
- 支持管理器内重命名、标签、置顶和归档，并按来源提供恢复入口。
- 保留 pi 插件入口及既有 AI、复盘功能，不覆盖旧的 pi 元数据。
- 不直接改写 Claude Code/Codex 原始记录，不连接云端历史或远程服务。
- 类型检查、既有测试、新增格式和 HTTP 集成测试通过。

## Scope

本机文件读取、独立 CLI、恢复命令、网页及使用文档。首版独立入口不提供 AI 模型连接；pi 入口继续使用 pi 当前模型。

## Constraints

- 保留 pi 的原会话 ID 和旧链接，新增来源使用命名空间 ID。
- 会话文本只在本机读取；AI 功能沿用用户主动触发的行为。
- 独立入口和外部来源只修改管理器元数据；pi 插件入口保留 pi 原生动作。

## Expected Knowledge Updates

- README.md：独立启动、三种来源、恢复与功能范围。
- docs/local-sessions.md：本地适配合同和格式边界。
- Task index: docs/tasks/INDEX.md。
