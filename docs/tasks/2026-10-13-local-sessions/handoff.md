---
updated: 2026-11-23
status: Complete
---

# Handoff: 本机会话统一管理

## For People

Name: 本机会话统一管理
Now: 三种工具的本机会话管理已完成，检查通过，按用户要求提交到远程仓库。
Done: 可以在同一网页浏览、搜索、整理三种来源的本机会话，保留原来的 pi 入口。
Next: 按需选择历史会话验证原生终端恢复。
Not yet: 尚未发行新的版本标签或发布软件包。

## Decided

- 2026-10-13，用户：只管理用户本机的会话，不接入远程或云端历史。
- 2026-11-23，用户：将当前插件改动提交并推送到 GitHub；本次不创建发行标签或发布 npm 软件包。

## Summary

pi-sessions 增加独立 CLI 和 Claude Code/Codex 本地读取适配器，复用网页、搜索、元数据、图片与复盘。保留 pi 扩展入口。

## Current State

本机统一管理这一阶段完成；本次交付为 GitHub 源码更新，原有 v0.3.3 标签不变。

## Git And Persistent State

main，基线 df7602f；本次提交包含三种来源支持、本地 Markdown 渲染资源和配套文档，推送目标 origin/main（woertedetiankong/pi-newsession）。以 git status 和远程提交核对交付状态，无 PR。用户原始会话只做读取检查，没有恢复或改写。
默认元数据与 token 目录保持原位；外部记录用命名空间 ID，pi 的原有键和链接保留。

## Validation

- 2026-11-23：npm run check 通过；npm test 51/51 通过，包括独立进程存活、SIGTERM 退出和静态资源路径限制。
- 本机读取识别 pi 22、Claude Code 66、Codex 24 个会话，对话和工具记录均可解析。
- 合成记录的浏览器 QA：来源筛选、置顶、标题保存、Codex 构建复盘均显示预期状态。
- npm pack 打包包含 CLI、适配器、网页和说明；临时生产依赖安装中没有 pi 包，CLI help 可运行。
- 恢复命令使用真实 CLI help 校验参数，测试验证路由及 shell 字面参数；未自动恢复用户历史会话。

## Next Steps

1. 用用户选择的历史会话验证 macOS 原生终端恢复，确定系统自动化权限与 CLI 环境。
2. 新版本 CLI 更新时扩充格式 fixtures，优先覆盖 Claude compaction 和 Codex 新日志类型。
3. 若需要独立 AI 整理，再增加显式模型配置；本阶段独立入口不连接模型。

## Restart Verify

```bash
git status --short # expected: 交付后工作区干净；mismatch means: 推送后有新的本地修改
npm run check && npm test # expected: 类型检查通过、51 tests pass；mismatch means: 代码或依赖改变
node bin/agent-sessions.mjs --help # expected: 三种来源目录参数；mismatch means: CLI 打包或 tsx 依赖丢失
```

## Implementation Log

[implementation-log.md](implementation-log.md) 记录兼容 ID、原生动作边界、格式重复和独立服务生命周期的决策。

## Cross-module references

[本地适配合同](../../local-sessions.md) 覆盖 scanner → adapters → transcript/review/export → server → CLI/pi/web。
[任务约束](task-brief.md) 和 [任务索引](../INDEX.md) 是本阶段的范围和入口。
src/hub.ts 的共享协议已升级到版本 3，增加可选静态资源处理；其他包的同步属于各自仓库的维护范围。

## Known risks and follow-ups

内部 JSONL 格式不是固定公共协议，后续 CLI 版本需回归验证。Linux 终端启动未实机测试，Windows 仅提供 PowerShell 恢复命令。
加密思考、外链图片和原始记录中未保存的文件差异无法重建；code-mode 内嵌动作仍作为通用工具调用显示。

## Docs/wiki sync

README.md 已改为三种本机来源的使用方式并移除远程及跨电脑流程；docs/local-sessions.md 记录稳定合同。
仓库没有 wiki，未新建 wiki。
