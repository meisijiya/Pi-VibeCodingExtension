# Changelog

## 1.0.0 (2026-05-25)

### 🚀 首次发布

**核心功能：**
- `vibe-workflow` Extension — 原子化 Vibe Coding 工作流引擎
- 8 个命令：`/vibe-init`, `/vibe-enable`, `/vibe-disable`, `/vibe-task`, `/vibe-checkpoint`, `/vibe-status`, `/vibe-handoff`, `/vibe-context`
- 2 个 LLM 工具：`vibe_checkpoint`, `vibe_status`
- 4 个生命周期 hooks：`session_start`, `before_agent_start`, `agent_end`, `session_shutdown`

**设计特性：**
- 🧠 Anthropic Cache 友好：message 注入 + state-hash 去重（97% 缓存命中率 vs systemPrompt 注入的 0%）
- 📏 上下文精简：~200 tokens/次注入，仅状态变化时触发
- 🔗 Skills 桥接：`/vibe-handoff` 自动触发 `/skill:handoff`
- 📦 会话文档：自动维护 `docs/vibe/sessions/`, `diffs/`, `tasks/`
- 🔄 状态持久化：通过 `pi.appendEntry` 跨 session 恢复

**联动 Skills：**
- superpowers: `writing-plans`, `executing-plans`, `finishing-a-development-branch`
- 已有: `handoff`, `brainstorming`, `to-prd`
