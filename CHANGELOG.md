# Changelog

## 2.0.0 (2026-05-25)

### 🚀 v2.0: 完善升级

**新增 Hook（+5）：**
- `tool_result` — 追踪 LLM 修改的文件，实时统计未提交变更
- `turn_start` — 记录 LLM turn 数，用于效率指标
- `message_end` — 自动检测"任务完成"信号，非侵入式提醒 checkpoint
- `session_before_switch` — 切换 session 前检查未提交变更，防止丢失进度
- `session_before_fork` — fork session 前同样检查

**新增命令（+3）：**
- `/vibe-plan` — 桥接 `/skill:writing-plans`，自动传入当前任务上下文
- `/vibe-metrics` — 显示工作流统计面板（checkpoint 频率、文件变更、效率指标）
- `/vibe-autocheckpoint [on|off]` — 切换自动 checkpoint 建议

**新增指标：**
- `VibeMetrics` 类型：filesPerCheckpoint、checkpointTimestamps、filesModifiedSinceCheckpoint、turnCount、toolCallCount
- 效率指标：Turns/Checkpoint、Avg files/checkpoint

**扩展规模：**
- 1786 行 · 9 hooks · 11 commands · 2 tools · 25 functions

---

## 1.0.0 (2026-05-24)

### 🚀 首次发布

**核心功能：**
- `vibe-workflow` Extension — 原子化 Vibe Coding 工作流引擎
- 8 个命令：`/vibe-init`, `/vibe-enable`, `/vibe-disable`, `/vibe-task`, `/vibe-checkpoint`, `/vibe-status`, `/vibe-handoff`, `/vibe-context`
- 2 个 LLM 工具：`vibe_checkpoint`, `vibe_status`
- 4 个生命周期 hooks：`session_start`, `before_agent_start`, `agent_end`, `session_shutdown`

**设计特性：**
- 🧠 Anthropic Cache 友好：message 注入 + state-hash 去重（97% 缓存命中率）
- 📏 上下文精简：~200 tokens/次注入，仅状态变化时触发
- 🔗 Skills 桥接：`/vibe-handoff` 自动触发 `/skill:handoff`
- 📦 会话文档：自动维护 `docs/vibe/sessions/`, `diffs/`, `tasks/`
- 🔄 状态持久化：通过 `pi.appendEntry` 跨 session 恢复
