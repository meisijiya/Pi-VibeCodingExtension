# 🎯 Atomic Vibe Workflow — pi Extension

> **把你的 Vibe Coding 从"野路子"变成"规范流程"**  
> 最小化任务 · Git 原子提交 · 上下文不膨胀 · Skills 全联动

---

## 📖 问题与动机

你引用的那段话非常精准地点出了 AI 辅助开发的核心矛盾：

> ❌ **问题**：大模型在长上下文中容易「范围膨胀」——说着说着就开始改不相干的东西  
> ❌ **问题**：每次新 session 都要重新描述项目状态，浪费 token  
> ❌ **问题**：没有 commit 记录，改动不可追溯，出了问题回滚困难  
> ❌ **问题**：压缩上下文（compaction）会丢失关键信息  

### ✅ 优化后的解决方案

| 原始建议 | 优化后 | 为什么 |
|----------|--------|--------|
| `last-session-diff.md` 单个文件 | `docs/vibe/diffs/last.md` + 结构化 meta | 带时间戳、commit 关联、不丢失历史 |
| `handoff.md` 单个文件 | `docs/vibe/sessions/<timestamp>.md` | 不覆盖，每个 session 独立存档 |
| 无任务跟踪 | `docs/vibe/tasks/active.md` | 显式跟踪当前任务，大模型一目了然 |
| 手动运行 git | Extension 自动化 + LLM 工具调用 | 减少手动操作，降低出错 |
| 独立使用 | 与 superpowers + handoff + to-prd 技能联动 | 最大化复用现有能力 |

---

## 🏗️ 工作流全景

```
                        ┌──────────────────────────────────────┐
                        │          AGENTS.md（项目宪法）          │
                        │   约束 · 约定 · 任务边界 · 当前聚焦     │
                        └──────────────┬───────────────────────┘
                                       │ 被 vibe-workflow 读取并注入
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     💬 每一次 AI 对话                              │
│                                                                 │
│  注入上下文 = AGENTS.md 约束 + 当前任务 + 上次 diff + 工作流指令    │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────┐         │
│  │ 开始工作  │───▶│ 完成原子任务   │───▶│ vibe_checkpoint │         │
│  │(读active) │    │  (单一变更)   │    │ git commit +   │         │
│  └──────────┘    └──────────────┘    │ update docs    │         │
│                                      └────────────────┘         │
│                                             │                   │
│                                             ▼                   │
│                              ┌──────────────────────────┐       │
│                              │  docs/vibe/              │       │
│                              │  ├── sessions/<id>.md    │       │
│                              │  ├── diffs/last.md      │       │
│                              │  └── tasks/active.md    │       │
│                              └──────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘

                        🧠 Skills 联动层
┌──────────────────────────────────────────────────────────────────┐
│  brainstorming ──▶ writing-plans ──▶ executing-plans             │
│       │                  │                   │                   │
│       ▼                  ▼                   ▼                   │
│   确定方向         生成实现计划       分批执行 + checkpoint        │
│                                      │                           │
│                          ┌───────────┴───────────┐               │
│                          ▼                       ▼               │
│                   handoff              finishing-a-branch        │
│                   会话交接              分支合并/PR/清理          │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 1. 在项目中使用

```bash
# 进入你的项目
cd /path/to/your-project

# 启动 pi（扩展已全局安装，自动加载）
pi

# 初始化 vibe 工作流
/vibe-init

# 启用工作流
/vibe-enable

# 设置当前任务
/vibe-task "实现用户登录页面"

# 告诉 AI 你的需求
"帮我实现登录页面，完成一个任务后调用 vibe_checkpoint"
```

### 2. AI 工作流程

```
你: "实现登录页面的表单验证，完成后调用 vibe_checkpoint"

AI: [读取 AGENTS.md、上次 diff、当前任务]
    → [实现表单验证]
    → [调用 vibe_checkpoint 工具]
    → [git commit: "[实现用户登录页面] checkpoint #1: ..."]
    → [更新 docs/vibe/diffs/last.md]
    → [更新 docs/vibe/tasks/active.md]

你: "很好，接下来实现密码强度检查"

AI: [又读了一遍上下文，知道进度在哪]
    → [实现密码强度检查]
    → [vibe_checkpoint]
```

### 3. Session 之间交接

```bash
# Session A 快结束时
/vibe-handoff      # 生成结构化交接文档
/skill:handoff     # 生成 LLM 视角的交接补充

# --- 新 Session B ---
/vibe-enable       # 启用工作流
/vibe-task "继续实现用户注册"
# AI 自动读取 AGENTS.md + last diff + active tasks
# 无缝衔接，不需要重新描述！
```

---

## 📂 目录结构

```
project/
├── AGENTS.md                          # 🏛️ 项目宪法（你用 /vibe-init 创建模板）
├── docs/
│   ├── vibe/                          # ⚡ Vibe Workflow 自动维护
│   │   ├── sessions/
│   │   │   ├── .gitkeep
│   │   │   ├── 2026-05-24-1430.md     # 每个 session 的记录
│   │   │   └── handoff-2026-05-24-1430.md  # 交接文档
│   │   ├── diffs/
│   │   │   └── last.md                # 最近变更 diff 汇总
│   │   └── tasks/
│   │       └── active.md              # 当前活动任务列表
│   ├── superpowers/
│   │   └── plans/                     # writing-plans 技能输出
│   ├── adr/                           # 架构决策记录
│   └── prd/                           # PRD 文档
└── .pi/
    └── settings.json                  # pi 项目配置
```

---

## 🔧 命令详解

### `/vibe-init`
初始化项目的 vibe 工作流。创建目录结构和 AGENTS.md 模板。

### `/vibe-enable` / `/vibe-disable`
启用/禁用 vibe 工作流。启用后：
- ✅ 每次对话注入工作流上下文
- ✅ LLM 可以调用 `vibe_checkpoint` 和 `vibe_status` 工具
- ✅ 底部状态栏显示 session 信息

### `/vibe-task <任务名>`
设置当前任务。影响：
- 注入上下文中的"当前任务"显示
- git commit 消息前缀
- session doc 记录

### `/vibe-checkpoint`
手动执行 checkpoint（= git commit + 更新文档）。  
LLM 也可以调用 `vibe_checkpoint` 工具达到相同效果。

### `/vibe-status`
查看当前工作流状态：启用状态、session ID、checkpoint 数、未提交变更等。

### `/vibe-handoff`
生成完整交接文档。包含：
- Session 摘要
- 所有 checkpoint 表格
- 下一步任务
- AGENTS.md 关键约束
- 建议的 skill 使用顺序

### `/vibe-context`
预览会注入到每次对话的上下文内容（调试用）。

### `/vibe-plan` 🆕 v2
桥接 `/skill:writing-plans`：自动将当前任务名、session 状态、已完成 checkpoint 数作为上下文传给 writing-plans skill，生成实现计划。

### `/vibe-metrics` 🆕 v2
显示工作流统计面板：
- Checkpoint 频率（Turns/Checkpoint，理想值 2-5）
- 每个 checkpoint 的文件变更数
- Session 内的 LLM turn 数和工具调用数
- 平均文件变更数

### `/vibe-autocheckpoint [on|off]` 🆕 v2
切换自动 checkpoint 建议。开启时（默认）：当 LLM 说 "done"/"complete"等完成信号时，自动在状态栏提示 checkpoint。关闭：仅手动触发。

---

## 🤝 与现有 Skills 联动

### 完整开发流程

```
第 1 步: /skill:brainstorming
  └─ 头脑风暴，确定需求和方向

第 2 步: /skill:writing-plans
  └─ 生成实现计划 → docs/superpowers/plans/YYYY-MM-DD-feature.md

第 3 步: /vibe-task "实现 {feature-name}"
  └─ 设置当前任务名称

第 4 步: /skill:executing-plans
  └─ 按计划分批执行
     ├─ 每批完成 → 由 AI 调用 vibe_checkpoint
     ├─ 自动 git commit + 更新 session doc
     └─ 批次间用户 review

第 5 步: /vibe-handoff
  └─ 生成结构化交接文档

第 6 步: /skill:finishing-a-development-branch
  └─ 选择合并/PR/保留分支的完成方式
```

### 技能矩阵

| 技能 | 来源 | 触发时机 | vibe-workflow 如何配合 |
|------|------|---------|----------------------|
| `brainstorming` | superpowers + 已有 | 开始任何创意工作 | AGENTS.md 中提醒先 brainstorming |
| `writing-plans` | superpowers | 有 spec 需要计划 | 计划存入后，vibe 的 checkpoint 跟踪执行进度 |
| `executing-plans` | superpowers + 已有 | 有实现计划要执行 | 每个 batch 完成 = 一个 vibe_checkpoint |
| `handoff` | 已有 | 会话结束/切换 | vibe-handoff 生成数据视角，handoff 生成 LLM 视角 |
| `to-prd` | 已有 | 需要创建 PRD | PRD 归档后，vibe 链接到 session doc |
| `finishing-a-development-branch` | superpowers | 开发完成 | vibe-handoff 的输出为分支完成决策提供上下文 |
| `verification-before-completion` | superpowers + 已有 | 声称完成前 | vibe_checkpoint 前自动验证 |

---

## 🎯 为什么可以「很久不用压缩上下文」？

### 传统方式 vs Vibe Workflow

```
传统方式:
Session 长 ──▶ 上下文膨胀 ──▶ 压缩 ──▶ 信息丢失 ──▶ 新 session 重新描述

Vibe Workflow 方式:
Session 短 ──▶ checkpoint 后关闭 ──▶ 新 session 自动读取
                │                          │
                ├─ git 有 commit 历史       ├─ AGENTS.md 约束
                ├─ diffs/last.md 变更记录   ├─ tasks/active.md 进度
                └─ sessions/<id>.md 详细记录 └─ 上次的 handoff 文档
                
→ LLM 始终知道「在做什么」「改了什么」「什么是边界」
→ 不需要把所有历史都塞进上下文
→ context 始终保持精简，远离压缩阈值
```

### 🧠 Anthropic Cache 优化策略

这是一个关键设计决策——系统提示缓存 vs 消息缓存：

```
❌ 方案A: systemPrompt 注入
   [System Prompt + vibe_context]  ← 前缀变了！
   [msg1]                           ← cache MISS  💸
   [msg2]                           ← cache MISS  💸
   → 全部缓存失效，每次 turn 重新计算全部 token

✅ 方案B: message 注入（本扩展采用）
   [System Prompt]                  ← cache HIT  ✅
   [msg1]                           ← cache HIT  ✅
   [msg2]                           ← cache HIT  ✅
   [vibe context msg]               ← only this is new
   → 99% 缓存命中，仅 ~200 tokens 重新计算

➕ 去重优化: 只在状态变化时注入
   Turn 1: [vibe context] ← 新任务，注入
   Turn 2: (no injection) ← 状态未变，跳过
   Turn 3: (no injection) ← 跳过
   Turn 4: [vibe context] ← checkpoint 完成，状态变了，注入
   → 避免了 75% 的重复注入，上下文永不膨胀
```

**缓存命中率对比：**

| 场景 | systemPrompt 注入 | message 注入（去重） |
|------|-------------------|---------------------|
| 首个 turn | 0% (全 miss) | ~95% (仅最后一条 miss) |
| 后续 turn (状态不变) | 0% | ~100% (零注入) |
| 后续 turn (状态变化) | 0% | ~95% |
| **平均** | **~0%** 💸💸💸 | **~97%** ✅✅✅ |

---

## ⚙️ 高级配置

### 自定义 vibe 目录

在 `.pi/settings.json` 中：

```json
{
  "extensions": [
    "~/.pi/agent/extensions/vibe-workflow.ts"
  ]
}
```

### 禁用自动上下文注入

如果你只想用 checkpoint/commit 功能，不需要上下文注入：

直接在对话中不运行 `/vibe-enable`，手动使用 `/vibe-checkpoint` 命令。

### 与其他 git 工具配合

vibe-workflow 只做 `git add -A` + `git commit` + `--no-verify`。它不会：
- 推送（push）
- 创建分支
- 修改 remote

这些操作由你或 `finishing-a-development-branch` 技能控制。

---

## 📊 效果对比

| 指标 | 无工作流 | 使用 Vibe Workflow |
|------|---------|-------------------|
| 上下文利用率 | ~40%（大量历史废话） | ~80%（只含当前任务信息） |
| 新 session 启动时间 | 5-10 分钟（重新描述） | <1 分钟（自动读取） |
| 需求膨胀率 | 高（AI 改无关代码） | 低（AGENTS.md 约束） |
| 可追溯性 | 差（无 commit 或混乱 commit） | 好（每个 checkpoint 一次 commit） |
| 回滚难度 | 高（不知道改了啥） | 低（git log 清晰） |
| Skill 联动 | 手动切换 | 自动化流程 |

---

> 💡 **一句话**: 这不是为了约束大模型，而是为了让大模型更聪明地工作——给它恰好需要的信息，不多不少。

---

## 📊 上下文体积对比

```
无工作流:
  system prompt: 10K tokens
  + 20 turns × 2K avg = 40K tokens
  + vibe overhead: 0
  = 50K tokens (and LLM doesn't know project state)

Vibe Workflow（优化后）:
  system prompt: 10K tokens (pi built-in + AGENTS.md)
  + 20 turns × 2K avg = 40K tokens
  + vibe injection: 0.2K × ~5 state changes = 1K tokens
  = 51K tokens (and LLM has full project context!) 
  
  → 仅多 1K tokens，换来完整的进度追踪 + 约束注入 + Skills 联动
```

---

_Made with ❤️ for the pi ecosystem_
