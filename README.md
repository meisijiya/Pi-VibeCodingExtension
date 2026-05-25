# 🎯 Pi-VibeCodingExtension

> **Atomic Vibe Coding 工作流引擎** —— 从 Vibe Coding 实践中总结的「原子化 AI 协作开发」方法论与工具集。

在长期 Vibe Coding 实践中，我发现两个核心矛盾：
1. **大模型会「范围膨胀」** —— 说着说着就开始改不相干的东西
2. **上下文越用越长** —— 每个新 session 都要重新描述项目状态

解法只有一个：**最小化每一步，让 AI 始终知道「在做什么、做了什么、边界在哪」**。这个 pi 扩展就是这套方法论的工程化落地。

[![pi-package](https://img.shields.io/badge/pi-package-blue)](https://pi.dev/packages)
[![version](https://img.shields.io/badge/version-5.1.0-green)](#)
[![license](https://img.shields.io/badge/license-MIT-orange)](LICENSE)

---

## 目录

- [快速开始](#快速开始)
- [命令速查表](#命令速查表)
- [配置指南](#配置指南)
  - [MiniMax CLI（识图/搜索/生成）](#配置-mmx CLI识图--搜索--生成)
  - [Mimo 多模态模型（兜底方案）](#配置-mimo-多模态模型兜底方案)
  - [配置检查清单](#配置检查清单)
- [场景1：新项目从零开始](#场景1新项目从零开始)
- [场景2：功能分支开发](#场景2功能分支开发)
- [场景3：识图 → 分析 → 写代码](#场景3识图--分析--写代码)
- [场景4：会话交接](#场景4会话交接)
- [场景5：发布 Release](#场景5发布-release)
- [场景6：出错回滚 + 提交整理](#场景6出错回滚--提交整理)
- [Skills 参考](#skills-参考)
- [行为准则](#行为准则-karpathys-principles)
- [目录结构](#目录结构)
- [上下文注入策略](#上下文注入策略)
  - [多模型协作](#多模型协作)
- [安装方式](#安装方式)

---

## 快速开始

```bash
# 1. 安装扩展
pi install git:github.com/meisijiya/Pi-VibeCodingExtension

# 2. 在项目中初始化
cd your-project
pi
/vibe-init       # 创建 docs/vibe/ 目录 + AGENTS.md 模板
/vibe-enable     # 启用工作流

# 3. 开始工作
/vibe-task "实现用户登录页面"
"帮我实现登录页面，每完成一个小任务调用 vibe_checkpoint"
```

---

## 命令速查表

### 🏗️ 基础工作流（日常使用）

| 命令 | 用途 | 示例 |
|------|------|------|
| `/vibe-init` | 初始化项目（创建目录 + AGENTS.md 模板） | `/vibe-init` |
| `/vibe-enable` | 启用工作流（开始上下文注入） | `/vibe-enable` |
| `/vibe-disable` | 禁用工作流 | `/vibe-disable` |
| `/vibe-task <name>` | 设置当前任务名 | `/vibe-task "实现登录验证"` |
| `/vibe-checkpoint` | 提交变更 + 更新文档 | `/vibe-checkpoint` |
| `/vibe-status` | 查看状态 + 上下文用量 + 压缩建议 | `/vibe-status` |
| `/vibe-handoff` | 生成交接文档 + 自动触发 /skill:handoff | `/vibe-handoff` |
| `/vibe-context` | 预览注入给 LLM 的上下文 | `/vibe-context` |

### 🔀 Git 工作流

| 命令 | 用途 | 示例 |
|------|------|------|
| `/vibe-branch <name>` | 创建功能分支 + 新 session | `/vibe-branch feature-payment` |
| `/vibe-merge` | 合并当前分支回主分支 | `/vibe-merge` |
| `/vibe-squash [N]` | 压缩 N 个 checkpoint → 1 个 clean commit | `/vibe-squash 5` |
| `/vibe-rollback [N]` | 回滚到指定 checkpoint（自动备份） | `/vibe-rollback 3` |
| `/vibe-release <ver>` | 打 tag + 生成 changelog | `/vibe-release 1.2.0` |

### 🤖 智能辅助

| 命令 | 用途 | 示例 |
|------|------|------|
| `/vibe-plan` | 桥接 /skill:writing-plans 生成计划 | `/vibe-plan` |
| `/vibe-metrics` | 工作流统计面板 | `/vibe-metrics` |
| `/vibe-autocheckpoint` | 开启/关闭自动 checkpoint | `/vibe-autocheckpoint off` |
| `/vibe-model` | 快速切换模型（pro/flash/mmx/mimo/back） | `/vibe-model flash` |

### 🖼️ 多模态 + MiniMax

| 命令 | 用途 | 示例 |
|------|------|------|
| `/vibe-mimo` | 切换到原生多模态模型（兜底） | `/vibe-mimo` → 贴图 → `/vibe-mimo --back` |
| `/vibe-minimax` | MiniMax CLI 工具（识图/搜索/生成） | `/vibe-minimax setup` |
| `/vibe-paste` | 从剪贴板粘贴图片（自动适配模型） | `/vibe-paste`（文本模型→工具识图，多模态→直接看图） |

| LLM 工具 | 触发方式 | 用途 |
|----------|---------|------|
| `vibe_checkpoint` | LLM 自动调用 | 完成任务后提交 |
| `vibe_status` | LLM 自动调用 | 查询工作流状态 |
| `minimax_describe_image` | LLM 自动调用 | 主力模型"看"图 |
| `minimax_web_search` | LLM 自动调用 | 主力模型搜索网络 |
| `minimax_generate` | LLM 自动调用 | 生成图片/视频/音频 |

> ⚠️ **重要：谁需要"切回来"？**
>
> 大部分命令是**一次性操作**，执行完就结束。只有两类命令改变了**持久状态**，需要主动回退：
>
> | 命令 | 改了什么 | 回退方式 |
> |------|---------|---------|
> | `/vibe-mimo` | 切换了 pi 模型 | `/vibe-mimo --back` |
> | `/vibe-enable` | 启用了工作流 | `/vibe-disable` |
> | `/vibe-branch <name>` | 切换了 git 分支 | `/vibe-merge` 合并回来 |
> | `/vibe-autocheckpoint off` | 关闭了自动建议 | `/vibe-autocheckpoint on` |
>
> `/vibe-minimax`、`/vibe-checkpoint`、`/vibe-squash` 等**不需要 back**——它们只是执行了一次操作，没有改变会话状态。

---

## 场景1：新项目从零开始

> **目标**：启动一个新项目，用 Vibe Workflow 管理整个开发过程。

### 详细流程

```bash
# ═══ 第 1 步：初始化项目 ═══
cd ~/projects/my-app
git init
pi

# 初始化 vibe 工作流（一次性）
/vibe-init
# → 创建 docs/vibe/sessions/、diffs/、tasks/
# → 生成 AGENTS.md 模板（如果不存在）

# ═══ 第 2 步：编辑 AGENTS.md（项目宪法） ═══
# 写下：
#   - Task Boundaries（任务边界）
#   - Constraints（项目约束）
#   - Conventions（代码约定）
#   - Current Focus（当前聚焦）

# ═══ 第 3 步：启动工作流 ═══
/vibe-enable
# → 底部状态栏: vibe: 2026-05-25-1430
# → LLM 自动获得 vibe 上下文注入

# ═══ 第 4 步：开始开发 ═══
/vibe-task "搭建项目框架"
"初始化 React + TypeScript 项目，创建基础目录结构"
# → LLM 读取 AGENTS.md 约束
# → LLM 实现项目框架
# → LLM 完成后自动调用 vibe_checkpoint
# → git commit + diff 汇总 + session 更新

# ═══ 第 5 步：确认 checkpoint ═══
/vibe-status
# → Session: 2026-05-25-1430
# → Checkpoints: 1
# → Current Task: 搭建项目框架
# → Uncommitted: 0 files ✅

# ═══ 第 6 步：继续下一个任务 ═══
/vibe-task "实现首页路由"
"实现路由配置，包含首页、登录页、404页面"
# → 重复 第4-6 步
```

### 效果

```
AGENTS.md（约束）
  ↓
每个任务 → vibe_checkpoint → git commit
  ↓                         ↓
docs/vibe/tasks/active.md   docs/vibe/diffs/last.md
（进度跟踪）                 （变更记录）
  ↓
下个任务开始 → LLM 自动读取上下文
→ 永远知道「在做什么、改了什么、边界在哪」
```

---

## 场景2：功能分支开发

> **目标**：开发一个独立功能（支付模块），用分支隔离，完成后合并。

### 详细流程

```bash
# ═══ 前置：当前在 main 分支，已完成一些基础功能 ═══
/vibe-status
# → Checkpoints: 5 · Task: 实现基础框架

# ═══ 第 1 步：创建功能分支 ═══
/vibe-branch feature-payment
# → 🌿 创建并切换到 feature-payment
# → 如有未提交变更，自动 checkpoint
# → 新 session: 2026-05-25-1600
# → 新 task: Feature: feature-payment

# ═══ 第 2 步：在分支上开发 ═══
/vibe-task "实现支付接口"
"对接 Stripe API，实现 createPaymentIntent"

# ... AI 开发 ...
# vibe_checkpoint ← CP #1

/vibe-task "实现支付回调"
"实现 webhook 处理支付结果"

# ... AI 开发 ...
# vibe_checkpoint ← CP #2

# ═══ 第 3 步：查看指标 ═══
/vibe-metrics
# → Checkpoints: 2
# → LLM Turns: 8
# → Turns/Checkpoint: 4.0 ✅ (理想范围 2-5)
# → Avg files/checkpoint: 2.5

# ═══ 第 4 步：查看进度 ═══
/vibe-status
# → Session: 2026-05-25-1600
# → Checkpoints: 2
# → Uncommitted: 0

# ═══ 第 5 步：压缩提交（可选） ═══
# 如果觉得 2 个 checkpoint 太碎，压缩为 1 个
/vibe-squash 2
# → ⚠️ 确认对话框
# → ✅ 2 commits → 1 clean "[feature-payment] 2 checkpoints"

# ═══ 第 6 步：合并回 main ═══
/vibe-merge
# → 自动检测 base: main
# → ✅ merge: feature-payment → main
# → 旧分支可手动删除: git branch -d feature-payment
```

### 分支策略

```
main ●──●──●──●────────────────● (merge)
              \
feature-payment ●──● (CP #1, #2)
                     ↓ squash → ● (1 clean commit)
                                  ↓ merge → main
```

---

## 场景3：识图 → 分析 → 写代码

> **目标**：主力模型 DeepSeek（纯文本）自动"看"设计稿截图，分析问题并改代码。

### 详细流程

```bash
# ═══ 前置：DeepSeek session，vibe 已启用 ═══
/vibe-task "优化登录页面UI"
/vibe-status
# → Model: deepseek/deepseek-chat

# ═══ 第 1 步：贴图（自动路由） ═══
# Ctrl+V 粘贴登录页面的设计稿截图
"根据这个设计稿，检查当前代码实现有什么问题"

# 🆕 input hook 自动拦截！
# → 📷 Image saved: assets/pasted/pasted-1712345678-0.png
# → 消息改写为纯文本 + 工具提示
# → DeepSeek 收到纯文本 ✅ 不会 400 报错！

# ═══ 第 2 步：LLM 自动调用识图工具 ═══
# DeepSeek 看到消息后自动决定:
# → 调用 minimax_describe_image("assets/pasted/pasted-xxx.png")
# → MiniMax CLI 返回: "这是一个登录表单，包含 email 输入框、
#    密码输入框、登录按钮。按钮颜色为 #3366ff，圆角 4px..."

# ═══ 第 3 步：LLM 对比代码 ═══
# DeepSeek 读取 src/pages/Login.tsx
# → 发现按钮颜色写的是 #333，与设计稿 #3366ff 不符
# → 发现缺少"忘记密码"链接
# → 修改代码

# ═══ 第 4 步：提交 ═══
# vibe_checkpoint ← 自动或手动触发
# → Commit: "[优化登录页面UI] checkpoint #3: 2 file(s)"
```

### 自动路由原理

```
用户 Ctrl+V 贴图
       │
       ▼
┌──────────────────────────────────────────────┐
│ input hook 拦截                               │
│ 1. 检测模型: DeepSeek → 纯文本 → 不能收图片   │
│ 2. 保存图片: assets/pasted/pasted-xxx.png     │
│ 3. 改写消息: "[Image saved: path] use tool"   │
└──────────────────┬───────────────────────────┘
                   │ 纯文本消息
                   ▼
┌──────────────────────────────────────────────┐
│ DeepSeek 收到纯文本                            │
│ → 调用 minimax_describe_image(path)          │
│    ↓                                          │
│    mmx CLI describe xxx.png               │
│    ↓                                          │
│    返回: "This image shows..."                │
│ → 基于描述分析问题、写代码                      │
└──────────────────────────────────────────────┘
```

### 兜底方案：原生多模态

```bash
# 如果 MiniMax CLI 不可用，手动切换原生模型:
/vibe-mimo
# → 👁️ 切换到 claude-sonnet（或 minimax/mimo-v2.5）
# → 上下文: 精简模式（仅任务描述，不浪费 token）

Ctrl+V 贴图  "分析这个设计稿"
# → Claude 直接"看"图，不需要 CLI

/vibe-mimo --back
# → 🔙 切回 DeepSeek
# → Claude 的分析结果在消息历史中，DeepSeek 可见
```

---

## 场景4：会话交接

> **目标**：当前 session 快结束了，把进度完整交给下一个 session。

### 详细流程

```bash
# ═══ Session A 结束前 ═══
/vibe-status
# → Session: 2026-05-25-1430 · Checkpoints: 3
# → Current Task: 实现登录页面（未完成）
# → Uncommitted: auth.ts

# ═══ 第 1 步：提交残留变更 ═══
/vibe-checkpoint
# → ✅ Checkpoint #4: auth.ts

# ═══ 第 2 步：生成交接文档 ═══
/vibe-handoff
# → 📦 数据交接: docs/vibe/sessions/handoff-2026-05-25-1430.md
#    ├─ Checkpoint 表格
#    ├─ 下一步任务
#    ├─ AGENTS.md 关键约束
#    └─ 建议的 Skills
# → 🧠 自动排队 /skill:handoff（LLM 语义化补充）

# ═══ 第 3 步：退出 ═══
# Ctrl+C 退出

# ════════════════════════════════════════════
# ═══ Session B（新 session） ═══
# ════════════════════════════════════════════

pi
/vibe-enable
# → 🚀 Vibe 工作流已启用
# → LLM 自动读取:
#     ├─ AGENTS.md（项目约束）
#     ├─ docs/vibe/diffs/last.md（上次变更）
#     ├─ docs/vibe/tasks/active.md（任务进度）
#     └─ docs/vibe/sessions/handoff-xxx.md（交接文档）

/vibe-task "继续实现登录页面"
# → LLM 无缝衔接，无需重新描述！

"继续完成上次未完成的登录页面表单验证"
# → LLM 已有完整上下文，直接开始工作
```

### 交接机制

```
Session A 结束
  │
  ├─ git commit 历史（所有变更可追溯）
  ├─ docs/vibe/sessions/<id>.md（Session 完整记录）
  ├─ docs/vibe/diffs/last.md（最后 diff 汇总）
  └─ docs/vibe/tasks/active.md（任务进度 + 下一步）

Session B 开始
  │
  ├─ /vibe-enable
  ├─ before_agent_start 注入上下文
  │   ├─ AGENTS.md 约束
  │   ├─ 当前任务状态
  │   └─ 文档路径引用
  └─ LLM 知道一切 → 无缝衔接
```

---

## 场景5：发布 Release

> **目标**：功能开发完成，打 tag 发布。

### 详细流程

```bash
# ═══ 第 1 步：确认全部完成 ═══
/vibe-status
# → Checkpoints: 8
# → Uncommitted: 0 ✅

/vibe-metrics
# → Turns/Checkpoint: 3.5 ✅
# → Total files: 15

# ═══ 第 2 步：发布 ═══
/vibe-release 1.0.0
# → 确认: 如有未提交变更，自动 checkpoint
# → 📄 生成 docs/vibe/release-1.0.0.md
#    ├─ Changes 列表（从 checkpoint 记录生成）
#    └─ Session 元数据
# → 🏷️  git tag -a v1.0.0

# ═══ 第 3 步：推送 ═══
git push origin main --tags
```

---

## 场景6：出错回滚 + 提交整理

> **目标**：发现第 3 个 checkpoint 引入了 bug，回滚 + 重新开发。

### 详细流程

```bash
# ═══ 第 1 步：确认要回滚的 checkpoint ═══
/vibe-status
# → Checkpoints: 5
# → #3 引入了一个难以修复的 bug

# ═══ 第 2 步：安全回滚 ═══
/vibe-rollback 3
# → 列出 checkpoint 供确认
# → ⚠️ 确认对话框
# → 自动创建备份分支: vibe-backup-2026-05-25-xxx
# → ✅ 回滚到 CP #3（revert 方式，保留历史）

# ═══ 第 3 步：重新开发（可选） ═══
/vibe-task "修复登录逻辑（重新实现）"
# ... 重新开发 ...

# ═══ 第 4 步：整理提交历史（可选） ═══
# 如果觉得 commit 太碎，压缩整理:
/vibe-squash 4
# → 列出最近 4 个 checkpoint
# → ⚠️ 确认对话框（不可逆操作！）
# → ✅ 4 commits → 1 clean commit
```

### 安全机制

```
每个回滚操作自动创建备份分支:
  vibe-backup-<session-id>-<timestamp>
  → 即使回滚错了，也能从备份恢复

Squash 前必须确认:
  → 显示将被压缩的 commit 列表
  → 确认后执行 soft reset + recommit
  → 工作区文件不受影响
```

---

## 目录结构

```
your-project/
│
├── AGENTS.md                    # 🏛️ 项目宪法（你编辑）
│   ├── Task Boundaries          #   任务边界（防需求膨胀）
│   ├── Constraints              #   项目约束（代码、文件、操作）
│   ├── Conventions              #   代码约定（风格、测试、文档）
│   └── Current Focus            #   当前聚焦任务
│
├── docs/
│   ├── vibe/                    # ⚡ 自动维护（不用手动编辑）
│   │   ├── sessions/            #   每次 session 的记录
│   │   │   ├── 2026-05-25-1430.md
│   │   │   └── handoff-2026-05-25-1430.md
│   │   ├── diffs/
│   │   │   ├── last.md          #   最近变更汇总
│   │   │   └── by-file/         #   每个文件的独立变更历史
│   │   │       ├── INDEX.md
│   │   │       ├── Login_tsx.md
│   │   │       └── auth_ts.md
│   │   ├── tasks/
│   │   │   └── active.md        #   当前任务 + 进度
│   │   └── release-1.0.0.md     #   Release changelog
│   └── superpowers/
│       └── plans/               #   writing-plans 技能输出
│
├── assets/
│   ├── pasted/                  #   Ctrl+V 贴图自动保存
│   └── generated/               #   MiniMax 生成素材
│
└── .pi/
    └── settings.json
```

---

## 上下文注入策略

### 三级注入（Token 最优）

```
┌─────────────────────────────────────────────────────────┐
│ 主力模型（DeepSeek、Claude、GPT）                         │
│ ┌───────────────────────────────────────────────────┐   │
│ │ Full Vibe Context (~300 tokens)                    │   │
│ │ • Session · Checkpoints                           │   │
│ │ • Current Task                                    │   │
│ │ • Uncommitted files                               │   │
│ │ • Reference docs paths                            │   │
│ │ • Rules (checkpoint, comments, scope)             │   │
│ └───────────────────────────────────────────────────┘   │
│ 仅在状态变化时注入 · 缓存命中率 97%                         │
├─────────────────────────────────────────────────────────┤
│ 工具模型（Mimo、Vision）                                  │
│ ┌───────────────────────────────────────────────────┐   │
│ │ Minimal Context (~50 tokens)                       │   │
│ │ • Current Task only                               │   │
│ │ • "Focus on immediate request"                    │   │
│ └───────────────────────────────────────────────────┘   │
│ 节省 ~250 tokens/次                                     │
├─────────────────────────────────────────────────────────┤
│ 外部 CLI（mmx CLI）                                  │
│ ┌───────────────────────────────────────────────────┐   │
│ │ Zero Context                                      │   │
│ │ 纯 shell 命令，不经过 LLM                          │   │
│ └───────────────────────────────────────────────────┘   │
│ 节省 ~300 tokens/次                                     │
└─────────────────────────────────────────────────────────┘
```

### 关于上下文压缩

> **vibe 工作流大幅降低压缩频率，但不能完全替代压缩。**

| 层 | 机制 | 说明 |
|----|------|------|
| 1️⃣ 预防 | 短 session + 精简注入 + handoff 交接 | 从根源减少上下文堆积 |
| 2️⃣ 监控 | `/vibe-status` 实时显示用量（🟢🟡🔴） | 看得到，就不会意外溢出 |
| 3️⃣ 兜底 | pi 自动压缩 + **压缩前自动 checkpoint** | git 永远有完整记录 |

**handoff 交接适用场景：** `/vibe-handoff` 是「存档」→ 生成 `docs/vibe/sessions/handoff-xxx.md`。`/vibe-enable` 是「读档」→ LLM 自动读取。任何新 session（`/new`、`pi --continue`、多分支并行）只要 enable 就能无缝衔接。

**实际操作建议：** 每 3-5 个 checkpoint 跑一次 `/vibe-status`。接近 60% 时 `/vibe-handoff` → `/new` → `/vibe-enable` 无缝交接；接近 80% 时可手动 `/compact`（压缩前会自动 checkpoint 保底）。

### 多模型协作

通过 `/vibe-model` 在 DeepSeek v4-pro（主力思考）、DeepSeek v4-flash（日常任务）、MiniMax M2.7（简单任务）之间快速切换，节省 Token 成本。

```bash
/vibe-model pro    # DeepSeek v4-pro · 1M ctx   主力思考
/vibe-model flash  # DeepSeek v4-flash · 1M ctx  日常任务
/vibe-model mmx    # MiniMax M2.7 · 256K ctx ⚠️  简单任务
/vibe-model back   # 切回上一个模型
```

**上下文自动适配：** 大上下文模型（≥300K）注入全量 vibe 上下文；小上下文模型（如 MiniMax 256K）自动降级为精简注入（~50 tokens），防止溢出。切换模型时显示上下文大小提醒。

---

## 安装方式

```bash
# 一步安装全部（vibe-workflow + context7）
pi install git:github.com/meisijiya/Pi-VibeCodingExtension

# 快速启动
pi
/vibe-init
/vibe-enable

# 可选：Context7 最新文档（需要注册 API Key）
export CONTEXT7_API_KEY=ctx7sk-xxx   # https://context7.com
```

**安装后即用：** 19 个命令 · 8 个 LLM 工具 · 完整的 Vibe Coding 工作流

### 前置依赖

- [pi](https://pi.dev) — 终端 AI 编程工具
- Git — 版本控制（checkpoint 功能需要）

---

## 配置指南

### 配置 MiniMax CLI（识图 / 搜索 / 生成）

> MiniMax CLI 是扩展的「手脚」——主力模型通过调用 CLI 工具间接获得多模态能力。

**第 1 步：安装**

```bash
# 参考官方文档安装 mmx CLI
# https://platform.minimaxi.com/docs/token-plan/mmx CLI

# 安装后验证:
mmx CLI --version
```

**第 2 步：登录**

```bash
# 登录你的 MiniMax Token Plan 账号
mmx CLI login

# 验证登录状态:
mmx CLI whoami
```

**第 3 步：在 pi 中验证**

```bash
pi
/vibe-minimax setup
# → ✅ MiniMax CLI 可用
```

> 💡 **不需要在 pi 中单独配置 API Key**。CLI 工具自己管理认证，扩展通过 `pi.exec("mmx CLI", ...)` 调用，与你的终端环境一致。

### 配置 Mimo 多模态模型（兜底方案）

> Mimo 是原生多模态模型，在 MiniMax CLI 不可用时作为兜底。

**你已经在 pi 中连接了 Mimo（如通过 opencode-go provider），不需要额外配置。**

```bash
# 验证 Mimo 可被发现:
pi
/vibe-mimo
# → 👁️ 自动搜索所有 provider 中的多模态模型
# → 应找到你的 Mimo 模型（如 opencode-go/minimax-mimo-v2.5）

# 如果自动检测失败，手动指定:
/vibe-mimo --model opencode-go/minimax-mimo-v2.5

# 使用完切回主力模型:
/vibe-mimo --back
```

> 💡 **如果你在其他 provider 下有 Mimo**（如直接注册了 MiniMax provider），自动检测同样能找到——扩展搜索**所有**已注册 provider 中的多模态模型。

### 配置检查清单

| 功能 | 需要配置 | 如何验证 |
|------|---------|---------|
| 基础工作流 | 无（开箱即用） | `/vibe-enable` |
| Git checkpoint | Git 已安装 | `/vibe-status` |
| MiniMax 识图/搜索/生成 | 安装 + 登录 mmx CLI | `/vibe-minimax setup` |
| Mimo 原生多模态 | provider 已连接（如 opencode-go） | `/vibe-mimo` |
| Skills 联动 | 安装 superpowers skills | `/skill:writing-plans` |

---

## Skills 参考

本扩展与以下 skills 联动，按集成深度分为三级：

### 🔗 桥接集成（扩展自动触发）

| Skill | 触发方式 | 场景 |
|-------|---------|------|
| `handoff` | `/vibe-handoff` 自动排队 `/skill:handoff` | 生成 LLM 视角的语义化交接补充 |
| `writing-plans` | `/vibe-plan` 自动排队 `/skill:writing-plans` | 传入当前任务上下文，生成 bite-sized 实现计划 |

### 💡 上下文推荐（注入时提醒 LLM）

| Skill | 何时推荐 | 场景 |
|-------|---------|------|
| `brainstorming` | 开始新功能前 | 头脑风暴，确定需求方向 |
| `executing-plans` | 有计划文件时 | 分批执行计划，每批结束触发 vibe_checkpoint |

### 📋 协作配合（文档引用 + AGENTS.md 推荐）

| Skill | 用途 | 与 vibe 工作流的关系 |
|-------|------|---------------------|
| `finishing-a-development-branch` | 分支完成（合并/PR/丢弃） | vibe-handoff 输出为分支完成决策提供上下文 |
| `verification-before-completion` | 完成前验证 | vibe_checkpoint 前的质量门 |
| `test-driven-development` | TDD 开发流程 | 每个 checkpoint 前确保测试通过 |
| `systematic-debugging` | 系统化调试 | 发现 bug 后回滚 + 重新开发的标准流程 |
| `subagent-driven-development` | 子 Agent 并行执行 | 大量独立任务时分派，完成后各自由 vibe_checkpoint 收尾 |
| `using-git-worktrees` | Git worktree 隔离开发 | 配合 `/vibe-branch` 创建完全隔离的工作空间 |
| `using-superpowers` | 引导 LLM 自动发现 skill | 确保 LLM 在需要时主动调用上述 skills |

> 💡 **MiniMax 功能不需要额外 skill**。识图、搜索、生成已通过 `minimax_describe_image`、`minimax_web_search`、`minimax_generate` 三个 LLM 工具封装在扩展内部，开箱即用。

### 快速安装所有 Skills

```bash
# 安装 superpowers skills
git clone --depth 1 --filter=blob:none https://github.com/obra/superpowers.git /tmp/sp
cp -r /tmp/sp/skills/* ~/.agents/skills/
rm -rf /tmp/sp

# 验证
ls ~/.agents/skills/
```

---

## 行为准则（Karpathy's Principles）

> 整合自 [Andrej Karpathy 的 LLM 编程观察](https://github.com/multica-ai/andrej-karpathy-skills)（15 万 stars），作为 vibe workflow 的「心法」层。

我们提供框架（任务边界、checkpoint、上下文），Karpathy 提供品味（怎么写、怎么改、怎么想）。两者互补：

| 我们的规则（框架） | Karpathy 原则（心法） |
|-------------------|---------------------|
| 不要扩展范围 | **Simplicity First** — 最小代码，不加投机功能 |
| 单任务聚焦 | **Surgical Changes** — 只改必须改的，不碰无关代码 |
| 完成后提交 | **Goal-Driven** — 先定义可验证成功标准，再动手 |
| 函数级注释 | **Think Before Coding** — 先陈述假设，暴露不确定 |

### 注入方式

**动态注入**（vibe context，每次对话）：
```
**Coding principles (Karpathy):**
- Simplicity first: minimum code, no speculative features
- Surgical changes: touch only what you must, match existing style
- Goal-driven: define verifiable success criteria before starting
```

**静态约束**（AGENTS.md 模板）：完整 5 条原则写入项目宪法。

---

## 扩展规模

| 版本 | 核心能力 | 规模 |
|------|---------|------|
| v1.0 | 基础工作流（init/enable/task/checkpoint） | 1429 行 |
| v2.0 | 文件追踪 + 指标 + 自动建议 | 1786 行 |
| v3.0 | Per-file diff + 智能 auto-checkpoint | 1950 行 |
| v4.0 | Squash/Rollback/Branch/Merge/Release | 2548 行 |
| v5.0 | 模型感知上下文 + 多模态切换 | 2849 行 |
| **v5.4** | **全家桶：smart_search + Context7 + 精简** | **3400+ 行 · 2 extensions** |

> 安装即得：`extensions/vibe-workflow.ts` + `extensions/pi-context7.ts`

> 10 hooks · 18 commands · 5 LLM tools · 全覆盖的 Vibe Coding 工作流

---

_Made with ❤️ for the pi ecosystem_
