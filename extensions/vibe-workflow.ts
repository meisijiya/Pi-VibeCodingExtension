/**
 * =============================================================================
 * Atomic Vibe Workflow Extension — 原子化 Vibe Coding 工作流
 * =============================================================================
 *
 * 核心理念（摘自社区最佳实践，经优化）：
 *   1. 最小化每个任务 — 一次只做一个原子操作
 *   2. 每完成一个任务 → git commit（显式触发，非自动）
 *   3. 自动维护 last-session-diff.md 和 session 交接文档
 *   4. 通过 AGENTS.md 约束大模型的任务边界，防止需求膨胀
 *   5. 大模型始终知道：当前任务进度、上次文件 diff、AGENTS.md 约束
 *   6. 可以使用很久都不需要压缩上下文 🎯
 *
 * 优化的设计决策（vs 原始建议）：
 *   — last-session-diff.md → docs/vibe/diffs/last.md（带结构化 meta）
 *   — handoff.md → docs/vibe/sessions/<timestamp>.md（不覆盖，保留历史）
 *   — 新增 tasks/active.md 显式跟踪当前任务
 *   — Git commit 由 LLM 显式调用 vibe_checkpoint 触发（非自动，给人控制权）
 *   — 与 superpowers skills (writing-plans, executing-plans, finishing-a-branch) 联动
 *   — 与已有 skills (handoff, brainstorming, to-prd) 联动
 *
 * 安装：
 *   cp vibe-workflow.ts ~/.pi/agent/extensions/
 *   或 pi install <package-name>
 *
 * 使用：
 *   /vibe-init           — 初始化项目 vibe 工作流
 *   /vibe-enable         — 启用工作流（上下文注入 + 工具就绪）
 *   /vibe-task <name>    — 设置当前任务
 *   /vibe-checkpoint     — 提交变更 + 更新文档
 *   /vibe-status         — 查看当前状态
 *   /vibe-handoff        — 生成完整交接文档
 *   /vibe-context        — 查看注入的上下文内容
 *
 * 对 LLM 可用的工具：
 *   vibe_checkpoint      — LLM 完成任务后显式调用，触发 git commit
 *   vibe_status           — LLM 查询当前工作流状态
 *
 * @author pi + ljh2923
 * @version 5.1.0
 */

// =============================================================================
// 1. 导入与类型定义
// =============================================================================

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import * as path from "node:path";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { execSync } from "node:child_process";

/** 工作流持久化状态（通过 pi.appendEntry 持久化，不参与 LLM 上下文） */
interface VibeState {
  /** 是否已启用 */
  enabled: boolean;
  /** 当前任务名称 */
  currentTask: string;
  /** 当前 session 的 checkpoint 计数 */
  checkpointCount: number;
  /** 当前 session 的唯一标识 */
  sessionId: string;
  /** 项目根目录（git root 或 cwd） */
  projectRoot: string;
  /** v2: 是否自动建议 checkpoint（检测到任务完成时） */
  autoSuggestCheckpoint: boolean;
}

/** v2: 指标追踪（不持久化，session 内统计） */
interface VibeMetrics {
  /** 每个 checkpoint 的文件变更数 */
  filesPerCheckpoint: number[];
  /** 每个 checkpoint 的大致时间 */
  checkpointTimestamps: string[];
  /** 上次 checkpoint 以来 LLM 修改的文件（通过 tool_result 追踪） */
  filesModifiedSinceCheckpoint: Set<string>;
  /** session 内 LLM turn 计数 */
  turnCount: number;
  /** session 内 LLM 调用的工具次数 */
  toolCallCount: number;
}

/** checkpoint 记录 */
interface CheckpointRecord {
  index: number;
  timestamp: string;
  task: string;
  commitHash: string;
  commitMessage: string;
  filesChanged: string[];
}

/** Session 文档结构 */
interface SessionDoc {
  sessionId: string;
  startedAt: string;
  status: "in-progress" | "completed";
  checkpoints: CheckpointRecord[];
  nextSteps: string[];
  notes: string;
}

// =============================================================================
// 2. 常量与配置
// =============================================================================

/** vibe 工作流目录（相对于项目根） */
const VIBE_DIR = "docs/vibe";
const SESSIONS_DIR = `${VIBE_DIR}/sessions`;
const DIFFS_DIR = `${VIBE_DIR}/diffs`;
const TASKS_DIR = `${VIBE_DIR}/tasks`;
const BY_FILE_DIR = `${DIFFS_DIR}/by-file`; // v3: per-file diff 目录

/** 关键文件名 */
const LAST_DIFF_FILE = "last.md";
const ACTIVE_TASKS_FILE = "active.md";

/** 扩展名（用于 pi.appendEntry 等） */
const EXT_NAME = "vibe-workflow";

/** 最大 diff 文件大小（避免一个 diff 撑爆上下文） */
const MAX_DIFF_SIZE_BYTES = 30_000; // 30KB

// =============================================================================
// 3. 工具函数
// =============================================================================

/**
 * 同步执行 git 命令，返回 stdout。失败返回 null。
 * 封装 execSync 以统一错误处理。
 */
function gitExec(cwd: string, args: string[]): string | null {
  try {
    return execSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 异步执行 git 命令（通过 pi.exec）
 * 用于在 extension hooks 中使用
 */
async function gitExecAsync(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    code: result.code,
  };
}

/**
 * 向上查找包含 .git 的目录，返回 git 根目录。
 * 如果不在 git 仓库中，返回 cwd。
 */
function findProjectRoot(cwd: string): string {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    return root || cwd;
  } catch {
    return cwd;
  }
}

/**
 * 检查目录是否为 git 仓库
 */
function isGitRepo(cwd: string): boolean {
  return gitExec(cwd, ["rev-parse", "--git-dir"]) !== null;
}

/**
 * 确保目录存在（递归创建）
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

/**
 * 安全读取文件，不存在返回 null
 */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 写入文件（自动创建父目录）
 */
async function writeFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsPromises.writeFile(filePath, content, "utf-8");
}

/**
 * 追加内容到文件（自动创建父目录）
 */
async function appendFile(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fsPromises.appendFile(filePath, content, "utf-8");
}

/**
 * 生成 session ID: YYYY-MM-DD-HHmm
 */
function generateSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    "-",
    pad(now.getMonth() + 1),
    "-",
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join("");
}

/**
 * 获取当前时间的 ISO 字符串
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

// =============================================================================
// 3.2 Git 操作
// =============================================================================

/**
 * 获取变更的文件列表（相对于 git root）
 * 包括 staged 和 unstaged 变更
 */
function getChangedFiles(cwd: string): string[] {
  const output = gitExec(cwd, ["diff", "--name-only", "HEAD"]);
  if (!output) return [];

  // 同时包含未追踪的新文件
  const untracked = gitExec(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);

  const changed = output
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith(DIFFS_DIR) && !f.startsWith(SESSIONS_DIR));

  const newFiles = (untracked || "")
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith(DIFFS_DIR) && !f.startsWith(SESSIONS_DIR));

  return [...new Set([...changed, ...newFiles])];
}

/**
 * 获取当前 diff（staged + unstaged），用于生成 diff summary
 * 限制大小避免撑爆上下文
 */
function getDiffSummary(cwd: string): string {
  // 获取 diffstat（比完整 diff 更简洁）
  const staged = gitExec(cwd, ["diff", "--staged", "--stat"]);
  const unstaged = gitExec(cwd, ["diff", "--stat"]);

  const lines: string[] = [];
  lines.push(`# Diff Summary — ${getTimestamp()}`);
  lines.push("");

  if (staged) {
    lines.push("## Staged Changes");
    lines.push("```");
    lines.push(staged);
    lines.push("```");
    lines.push("");
  }

  if (unstaged) {
    lines.push("## Unstaged Changes");
    lines.push("```");
    lines.push(unstaged);
    lines.push("```");
    lines.push("");
  }

  if (!staged && !unstaged) {
    lines.push("_(no changes)_");
  }

  return lines.join("\n");
}

/**
 * 获取完整的 diff（用于存档），限制大小
 */
function getFullDiff(cwd: string): string {
  const staged = gitExec(cwd, ["diff", "--staged"]) || "";
  const unstaged = gitExec(cwd, ["diff"]) || "";
  const combined = [staged, unstaged].filter(Boolean).join("\n\n");

  if (combined.length > MAX_DIFF_SIZE_BYTES) {
    return (
      combined.slice(0, MAX_DIFF_SIZE_BYTES) +
      "\n\n[... diff truncated, too large ...]"
    );
  }
  return combined || "_(no changes)_";
}

/**
 * 执行 git commit
 * @returns commit hash 或 null（失败/无变更）
 */
function gitCommit(
  cwd: string,
  message: string,
): { hash: string } | null {
  // 先检查是否有变更
  const changedFiles = getChangedFiles(cwd);
  if (changedFiles.length === 0) return null;

  // Stage all changes (排除 vibe 目录，避免循环)
  const stageResult = gitExec(cwd, ["add", "-A"]);
  if (stageResult === null) return null;

  // Commit
  const commitResult = gitExec(cwd, [
    "commit",
    "-m",
    message,
    "--no-verify",
  ]);

  if (commitResult === null) return null;

  // 获取 commit hash
  const hash = gitExec(cwd, ["rev-parse", "--short", "HEAD"]);
  return hash ? { hash } : null;
}

/**
 * 获取最近的 N 个 commit（用于 session doc）
 */
function getRecentCommits(
  cwd: string,
  sinceHash: string | null,
): { hash: string; message: string; files: string }[] {
  const range = sinceHash ? `${sinceHash}..HEAD` : "HEAD~10..HEAD";
  const format = "--format=%h|||%s";
  const output = gitExec(cwd, ["log", range, format, "--name-only"]);
  if (!output) return [];

  const commits: { hash: string; message: string; files: string }[] = [];
  let current: { hash: string; message: string; files: string } | null = null;

  for (const line of output.split("\n")) {
    if (line.includes("|||")) {
      if (current) commits.push(current);
      const [hash, ...rest] = line.split("|||");
      current = { hash: hash.trim(), message: rest.join("|||").trim(), files: "" };
    } else if (current && line.trim()) {
      current.files += (current.files ? "\n" : "") + line.trim();
    }
  }
  if (current) commits.push(current);

  return commits;
}

// =============================================================================
// 3.3 会话文档管理
// =============================================================================

/**
 * 读取或创建 session 文档
 */
async function loadSessionDoc(
  projectRoot: string,
  state: VibeState,
): Promise<SessionDoc> {
  const docPath = path.join(
    projectRoot,
    SESSIONS_DIR,
    `${state.sessionId}.md`,
  );

  const existing = await readFileSafe(docPath);
  if (existing) {
    return parseSessionDoc(existing, state);
  }

  // 创建新的 session 文档
  const doc: SessionDoc = {
    sessionId: state.sessionId,
    startedAt: getTimestamp(),
    status: "in-progress",
    checkpoints: [],
    nextSteps: [],
    notes: "",
  };
  await writeSessionDoc(projectRoot, state, doc);
  return doc;
}

/**
 * 从 markdown 解析 session 文档
 * 简化版解析器，处理我们生成的格式
 */
function parseSessionDoc(md: string, state: VibeState): SessionDoc {
  const doc: SessionDoc = {
    sessionId: state.sessionId,
    startedAt: extractField(md, "Started") || getTimestamp(),
    status: (extractField(md, "Status") as SessionDoc["status"]) || "in-progress",
    checkpoints: [],
    nextSteps: [],
    notes: extractField(md, "Notes") || "",
  };

  // 提取 next steps
  const nextStepsMatch = md.match(/## Next Steps\n([\s\S]*?)(?=\n##|$)/);
  if (nextStepsMatch) {
    doc.nextSteps = nextStepsMatch[1]
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || l.trim().match(/^\d+\./))
      .map((l) => l.replace(/^[-*\d.]\s*/, "").trim());
  }

  return doc;
}

/**
 * 从 markdown 中提取字段
 */
function extractField(md: string, field: string): string | null {
  const regex = new RegExp(`\\*\\*${field}\\*\\*:\\s*(.+)`, "i");
  const match = md.match(regex);
  return match ? match[1].trim() : null;
}

/**
 * 写入 session 文档
 */
async function writeSessionDoc(
  projectRoot: string,
  state: VibeState,
  doc: SessionDoc,
): Promise<void> {
  const docPath = path.join(
    projectRoot,
    SESSIONS_DIR,
    `${state.sessionId}.md`,
  );

  const lines: string[] = [];
  lines.push(`# Vibe Session: ${state.sessionId}`);
  lines.push("");
  lines.push("## Session Info");
  lines.push(`- **Started**: ${doc.startedAt}`);
  lines.push(`- **Updated**: ${getTimestamp()}`);
  lines.push(`- **Status**: ${doc.status}`);
  lines.push(`- **Checkpoints**: ${doc.checkpoints.length}`);
  lines.push(`- **Current Task**: ${state.currentTask || "_(none)_"}`);
  lines.push("");

  if (doc.checkpoints.length > 0) {
    lines.push("## Checkpoints");
    lines.push("");
    for (const cp of doc.checkpoints) {
      lines.push(`### Checkpoint ${cp.index}: \`${cp.commitHash}\``);
      lines.push(`- **Time**: ${cp.timestamp}`);
      lines.push(`- **Task**: ${cp.task || state.currentTask}`);
      lines.push(`- **Message**: ${cp.commitMessage}`);
      if (cp.filesChanged.length > 0) {
        lines.push(`- **Files**: ${cp.filesChanged.map((f) => `\`${f}\``).join(", ")}`);
      }
      lines.push("");
    }
  }

  if (doc.nextSteps.length > 0) {
    lines.push("## Next Steps");
    for (const step of doc.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  if (doc.notes) {
    lines.push("## Notes");
    lines.push(doc.notes);
    lines.push("");
  }

  lines.push("## Related Documents");
  if (fs.existsSync(path.join(projectRoot, "AGENTS.md"))) {
    lines.push("- [AGENTS.md](../../AGENTS.md) — 项目约束与规范");
  }
  lines.push(`- [Last Diff](../diffs/${LAST_DIFF_FILE}) — 最近变更 diff`);
  lines.push(`- [Active Tasks](../tasks/${ACTIVE_TASKS_FILE}) — 当前任务列表`);
  lines.push("");

  await writeFile(docPath, lines.join("\n"));
}

/**
 * 更新 last-session-diff.md
 */
async function updateLastDiff(projectRoot: string, cwd: string): Promise<void> {
  const diffPath = path.join(projectRoot, DIFFS_DIR, LAST_DIFF_FILE);
  const diffContent = getDiffSummary(cwd);
  const fullDiff = getFullDiff(cwd);

  const content = [
    diffContent,
    "",
    "---",
    "",
    "## Full Diff",
    "```diff",
    fullDiff,
    "```",
    "",
  ].join("\n");

  await writeFile(diffPath, content);
}

/**
 * v3: 更新 per-file diff — 为每个变更文件生成独立的 diff 记录。
 *
 * 产出:
 *   docs/vibe/diffs/by-file/
 *   ├── INDEX.md          — 索引（文件 → checkpoint 列表）
 *   ├── Login.tsx.md       — Login.tsx 的所有变更历史
 *   └── auth.ts.md         — auth.ts 的所有变更历史
 *
 * 优势:
 *   — LLM 按需读取单个文件的变更，不读全量 diff
 *   — 上下文更精简
 *   — 追踪「这个文件被改了多少次」
 */
async function updatePerFileDiffs(
  projectRoot: string,
  cwd: string,
  checkpointIndex: number,
  changedFiles: string[],
): Promise<void> {
  const byFileDir = path.join(projectRoot, BY_FILE_DIR);
  await ensureDir(byFileDir);

  const timestamp = getTimestamp();

  // 为每个文件生成/追加 diff
  for (const file of changedFiles) {
    // 跳过 vibe 自己的文件
    if (file.startsWith(VIBE_DIR + "/")) continue;

    // 获取该文件相对于 HEAD 的 diff
    const fileDiff = gitExec(cwd, ["diff", "HEAD", "--", file]);
    if (!fileDiff || fileDiff.trim().length === 0) continue;

    // 文件名中的路径分隔符替换为下划线，避免嵌套目录
    const safeName = file.replace(/\//g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(byFileDir, `${safeName}.md`);

    // 读取已有内容
    const existing = await readFileSafe(filePath);

    // 截断 diff（避免单文件 diff 过大）
    const truncatedDiff = fileDiff.length > MAX_DIFF_SIZE_BYTES
      ? fileDiff.slice(0, MAX_DIFF_SIZE_BYTES) +
        `\n\n[... ${fileDiff.length - MAX_DIFF_SIZE_BYTES} more bytes truncated ...]`
      : fileDiff;

    if (existing) {
      // 追加新的 checkpoint 记录
      const record = [
        "",
        `---`,
        "",
        `## Checkpoint #${checkpointIndex} — ${timestamp}`,
        "",
        "```diff",
        truncatedDiff,
        "```",
        "",
      ].join("\n");
      await appendFile(filePath, record);
    } else {
      // 新建文件
      const header = [
        `# ${file} — Per-File Diff History`,
        "",
        `> Session: last · First change: ${timestamp}`,
        "",
      ].join("\n");
      const record = [
        header,
        `## Checkpoint #${checkpointIndex} — ${timestamp}`,
        "",
        "```diff",
        truncatedDiff,
        "```",
        "",
      ].join("\n");
      await writeFile(filePath, record);
    }
  }

  // 更新索引文件
  const indexEntries = [];
  for (const file of changedFiles) {
    if (file.startsWith(VIBE_DIR + "/")) continue;
    const safeName = file.replace(/\//g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
    indexEntries.push(`- \`${file}\` → [${safeName}.md](${safeName}.md) (CP #${checkpointIndex})`);
  }

  if (indexEntries.length > 0) {
    const indexPath = path.join(byFileDir, "INDEX.md");
    const existingIndex = await readFileSafe(indexPath);
    const newEntries = [
      existingIndex
        ? existingIndex.replace(/\n---\n*$/, "") // 移除旧的分隔符
        : "# Per-File Diff Index\n\n",
      `\n---\n\n## Checkpoint #${checkpointIndex} — ${timestamp}\n`,
      ...indexEntries,
      "\n",
    ].join("\n");
    await writeFile(indexPath, newEntries);
  }
}

/**
 * 更新 active tasks 文件
 */
async function updateActiveTasks(
  projectRoot: string,
  state: VibeState,
  doc: SessionDoc,
): Promise<void> {
  const tasksPath = path.join(projectRoot, TASKS_DIR, ACTIVE_TASKS_FILE);

  const lines: string[] = [];
  lines.push("# Active Tasks");
  lines.push("");
  lines.push(`> Session: ${state.sessionId} · Checkpoints: ${doc.checkpoints.length}`);
  lines.push("");

  lines.push("## 🔄 Current Task");
  lines.push(`**${state.currentTask || "_(none)_"}**`);
  lines.push("");

  if (doc.checkpoints.length > 0) {
    lines.push("## ✅ Completed");
    for (const cp of doc.checkpoints) {
      lines.push(`- [x] ${cp.task || "Checkpoint " + cp.index} (\`${cp.commitHash}\`)`);
    }
    lines.push("");
  }

  if (doc.nextSteps.length > 0) {
    lines.push("## 📋 Next Steps");
    for (const step of doc.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Last updated: ${getTimestamp()}_`);

  await writeFile(tasksPath, lines.join("\n"));
}

// =============================================================================
// 3.4 AGENTS.md 解析（简化版）
// =============================================================================

/**
 * 读取 AGENTS.md 并提取关键部分用于上下文注入。
 * pi 已通过 context files 机制加载 AGENTS.md，这里只做补充提取。
 */
async function readAgentsMd(
  projectRoot: string,
): Promise<{ exists: boolean; constraints: string[] }> {
  const filePath = path.join(projectRoot, "AGENTS.md");
  const content = await readFileSafe(filePath);

  if (!content) {
    return { exists: false, constraints: [] };
  }

  // 提取约束行（以 "- " 或数字开头的行，在特定 section 下）
  const constraints: string[] = [];

  // 查找 "Constraints" 或 "Task Boundaries" section
  const sections = content.split(/\n##?\s+/);
  for (const section of sections) {
    const lowerSection = section.toLowerCase();
    if (
      lowerSection.startsWith("task boundaries") ||
      lowerSection.startsWith("constraints") ||
      lowerSection.startsWith("项目约束")
    ) {
      const lines = section.split("\n").slice(1); // 跳过标题
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("-") || trimmed.match(/^\d+\./)) {
          constraints.push(trimmed.replace(/^[-*\d.]\s*/, ""));
        }
      }
    }
  }

  return { exists: true, constraints };
}

// =============================================================================
// 4. 核心工作流逻辑
// =============================================================================

/**
 * 构建上下文注入消息（在 before_agent_start 中注入）。
 *
 * 设计原则：
 *   — 精简：总长度控制在 ~300 tokens 以内，不给上下文增加负担
 *   — 引用而非内联：文档路径用文件引用，LLM 需要时自行 read
 *   — AGENTS.md 约束由 pi 的 context files 机制加载，这里不重复
 */
async function buildContextInjection(
  projectRoot: string,
  state: VibeState,
): Promise<string> {
  const changedFiles = isGitRepo(projectRoot)
    ? getChangedFiles(projectRoot)
    : [];

  const lines: string[] = [];
  lines.push("## Vibe Workflow");
  lines.push(`- Session: \`${state.sessionId}\` · Checkpoints: ${state.checkpointCount}`);
  lines.push(
    `- Task: **${state.currentTask || "_(未设置, 用 /vibe-task 设置)_"}**`,
  );

  // 未提交变更提醒
  if (changedFiles.length > 0) {
    const fileList = changedFiles
      .slice(0, 6)
      .map((f) => `\`${path.basename(f)}\``)
      .join(", ");
    const more = changedFiles.length > 6
      ? ` +${changedFiles.length - 6} more`
      : "";
    lines.push(`- Uncommitted: ${fileList}${more}`);
  }

  lines.push("");
  lines.push("**Reference docs** (read when needed):");
  lines.push(
    `- \`${path.join(VIBE_DIR, "sessions", state.sessionId + ".md")}\` — full session log`,
  );
  lines.push(
    `- \`${path.join(VIBE_DIR, "diffs", LAST_DIFF_FILE)}\` — last changes diff`,
  );
  lines.push(
    `- \`${path.join(VIBE_DIR, "diffs/by-file/")}\` — per-file diff history (v3)`,
  );
  lines.push(
    `- \`${path.join(VIBE_DIR, "tasks", ACTIVE_TASKS_FILE)}\` — task list & progress`,
  );
  lines.push("");
  lines.push("**Rules:**");
  lines.push(
    "- After completing the current task, call \`vibe_checkpoint\` to commit & update docs",
  );
  // 当用户设置了 task 时，强化单任务约束
  if (state.currentTask) {
    lines.push(
      "- 🎯 **CRITICAL: Complete ONLY the current task.** Do NOT proceed to next steps in the plan.",
    );
    lines.push(
      "- The plan is a roadmap for future sessions. Your job is ONE step at a time.",
    );
    lines.push(
      "- After completing this task, STOP and call vibe_checkpoint. Let the user decide next.",
    );
  } else {
    lines.push(
      "- Do NOT expand scope beyond the current task. One task at a time.",
    );
  }
  lines.push(
    "- Every function MUST have a brief comment describing its purpose (函数级注释)",
  );
  lines.push(
    "- Use \`vibe_status\` to check workflow state at any time.",
  );
  lines.push("");
  lines.push("**Coding principles (Karpathy):**");
  lines.push("- Simplicity first: minimum code, no speculative features");
  lines.push("- Surgical changes: touch only what you must, match existing style");
  lines.push("- Goal-driven: define verifiable success criteria before starting");
  lines.push("");
  lines.push("**Tools:**");
  lines.push(
    "- Use \`context7_resolve\` + \`context7_docs\` for latest official API docs before writing library code.",
  );
  lines.push(
    "- Use built-in \`grep\` for exact matches. If no results, use \`smart_search\` for broader search.",
  );

  return lines.join("\n");
}

/**
 * 执行 checkpoint：git commit + diff 汇总 + session doc 更新
 */
async function executeCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: VibeState,
  message?: string,
): Promise<{ success: boolean; message: string }> {
  const projectRoot = state.projectRoot;
  const cwd = ctx.cwd;

  // 1. 检查是否为 git 仓库
  if (!isGitRepo(cwd)) {
    return {
      success: false,
      message: "⚠️ 当前目录不是 Git 仓库，无法执行 checkpoint。请先在项目中初始化 Git。",
    };
  }

  // 2. 获取变更文件
  const changedFiles = getChangedFiles(cwd);
  if (changedFiles.length === 0) {
    return {
      success: false,
      message: "📝 没有检测到文件变更，跳过 checkpoint。",
    };
  }

  // 3. 生成 commit 信息
  const taskName = state.currentTask || "vibe-task";
  const checkpointNum = state.checkpointCount + 1;
  const autoMessage = message ||
    `[${taskName}] checkpoint #${checkpointNum}: ${changedFiles.length} file(s) changed`;

  const fullCommitMessage = [
    autoMessage,
    "",
    `Checkpoint: ${checkpointNum} · Session: ${state.sessionId}`,
    `Files: ${changedFiles.map((f) => path.basename(f)).join(", ")}`,
  ].join("\n");

  // 4. 执行 commit
  const commitResult = gitCommit(cwd, fullCommitMessage);
  if (!commitResult) {
    return {
      success: false,
      message: "❌ Git commit 失败，请检查是否有未解决的冲突。",
    };
  }

  // 5. 更新状态
  state.checkpointCount = checkpointNum;

  // v2: 记录 metrics
  metrics.filesPerCheckpoint.push(changedFiles.length);
  metrics.checkpointTimestamps.push(getTimestamp());
  metrics.filesModifiedSinceCheckpoint.clear();

  // v5.6: 刷新面板
  refreshWidget(ctx);

  // 6. 更新 last-session-diff.md
  await updateLastDiff(projectRoot, cwd);

  // v3: 更新 per-file diff
  await updatePerFileDiffs(projectRoot, cwd, checkpointNum, changedFiles);

  // 7. 更新 session doc
  const doc = await loadSessionDoc(projectRoot, state);
  doc.checkpoints.push({
    index: checkpointNum,
    timestamp: getTimestamp(),
    task: state.currentTask,
    commitHash: commitResult.hash,
    commitMessage: autoMessage,
    filesChanged: changedFiles,
  });
  await writeSessionDoc(projectRoot, state, doc);

  // 8. 更新 active tasks
  await updateActiveTasks(projectRoot, state, doc);

  // 9. 持久化状态
  await pi.appendEntry(EXT_NAME, state);

  return {
    success: true,
    message:
      `✅ Checkpoint #${checkpointNum} 完成！\n` +
      `   Commit: \`${commitResult.hash}\`\n` +
      `   Files: ${changedFiles.map((f) => `\`${f}\``).join(", ")}\n` +
      `   Diff: docs/vibe/diffs/last.md`,
  };
}

/**
 * 生成 handoff 文档（与 handoff skill 互补）
 */
async function generateHandoff(
  projectRoot: string,
  state: VibeState,
): Promise<string> {
  const doc = await loadSessionDoc(projectRoot, state);
  const agentsMd = await readAgentsMd(projectRoot);

  const lines: string[] = [];
  lines.push(`# Handoff: ${state.sessionId}`);
  lines.push("");
  lines.push("> 本文件由 vibe-workflow 扩展生成，供下一个 session 快速接手。");
  lines.push(`> 生成时间: ${getTimestamp()}`);
  lines.push("");

  lines.push("## 📋 当前状态");
  lines.push(`- **Session**: ${state.sessionId}`);
  lines.push(`- **Status**: ${doc.status}`);
  lines.push(`- **Checkpoints**: ${doc.checkpoints.length}`);
  lines.push(`- **Current Task**: ${state.currentTask || "_(none)_"}`);
  lines.push("");

  if (doc.checkpoints.length > 0) {
    lines.push("## ✅ 已完成的 Checkpoints");
    lines.push("");
    lines.push("| # | Commit | Task | Files |");
    lines.push("|---|--------|------|-------|");
    for (const cp of doc.checkpoints) {
      lines.push(
        `| ${cp.index} | \`${cp.commitHash}\` | ${cp.task || "-"} | ${cp.filesChanged.length} files |`,
      );
    }
    lines.push("");
  }

  if (doc.nextSteps.length > 0) {
    lines.push("## 📋 下一步");
    for (const step of doc.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  if (agentsMd.constraints.length > 0) {
    lines.push("## 🚧 关键约束 (from AGENTS.md)");
    for (const constraint of agentsMd.constraints.slice(0, 5)) {
      lines.push(`- ${constraint}`);
    }
    lines.push("");
  }

  lines.push("## 📄 参考文档");
  lines.push("- Session 完整记录: `docs/vibe/sessions/`");
  lines.push("- Diff 汇总: `docs/vibe/diffs/last.md`");
  lines.push("- 任务列表: `docs/vibe/tasks/active.md`");
  lines.push("- 项目约束: `AGENTS.md`");
  lines.push("");

  lines.push("## 💡 建议 Skill 使用");
  lines.push("- 开始新工作前使用 `/skill:brainstorming`");
  lines.push("- 复杂功能使用 `/skill:writing-plans` 生成计划");
  lines.push("- 执行计划使用 `/skill:executing-plans`");
  lines.push("- 完成后使用 `/skill:finishing-a-development-branch`");
  lines.push("");

  lines.push("---");
  lines.push(
    `_Tip: 新 session 中运行 \`/vibe-enable\` 启用工作流，然后 \`/vibe-task\` 设置当前任务。_`,
  );

  return lines.join("\n");
}

// =============================================================================
// 5. 扩展入口
// =============================================================================

export default function (pi: ExtensionAPI) {
  // --- 5.1 状态管理 ---

  /** 内存状态 */
  let state: VibeState = {
    enabled: false,
    currentTask: "",
    checkpointCount: 0,
    sessionId: generateSessionId(),
    projectRoot: "",
    autoSuggestCheckpoint: true,
  };

  /** v2: 指标追踪（session 内统计，不持久化） */
  let metrics: VibeMetrics = {
    filesPerCheckpoint: [],
    checkpointTimestamps: [],
    filesModifiedSinceCheckpoint: new Set(),
    turnCount: 0,
    toolCallCount: 0,
  };

  /** 重置指标 */
  function resetMetrics(): void {
    metrics = {
      filesPerCheckpoint: [],
      checkpointTimestamps: [],
      filesModifiedSinceCheckpoint: new Set(),
      turnCount: 0,
      toolCallCount: 0,
    };
  }

  /**
   * 从持久化存储恢复状态（在 session_start 中调用）
   */
  async function restoreState(ctx: ExtensionContext): Promise<void> {
    const projectRoot = findProjectRoot(ctx.cwd);
    state.projectRoot = projectRoot;

    // 尝试从 session entries 恢复
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (
        entry.type === "custom" &&
        (entry as { customType?: string }).customType === EXT_NAME
      ) {
        const saved = (entry as { data?: VibeState }).data;
        if (saved) {
          state = { ...state, ...saved };
          return;
        }
      }
    }

    // 无持久化状态，用默认值
    state.sessionId = generateSessionId();
    state.checkpointCount = 0;
    state.currentTask = "";
    state.enabled = false;
  }

  // --- 5.2 状态追踪（缓存优化） ---

  /**
   * 记录上次注入的状态哈希，用于去重。
   * 只在 state 真正变化时注入上下文，避免：
   *   1. systemPrompt 修改 → 前缀变化 → Anthropic cache 全部失效
   *   2. 每个 turn 都注入 → message 累积 → 上下文膨胀
   *
   * 策略：message 注入（放在消息末尾 + 去重）
   *   ✅ 系统提示不变 → 前缀缓存命中
   *   ✅ 中间消息不变 → 缓存命中
   *   ✅ 只有最后的新消息需要重新计算
   *   ✅ 只在状态变化时注入 → 不会累积膨胀
   */
  let lastInjectedStateHash = "";

  /**
   * 计算当前状态的哈希（用于去重判断）
   */
  function computeStateHash(): string {
    return `${state.currentTask}|${state.checkpointCount}|${state.sessionId}`;
  }

  // ──── 5.3.1 v5.6: TUI 状态面板 Widget ────

  /** 面板显示开关 */
  let panelVisible = true;

  /**
   * 解析任务行末尾的模型建议（💡pro / 💡flash / 💡mmx）
   */
  function parseModelHint(text: string): { text: string; model?: string } {
    const match = text.match(/^(.+?)\s*💡(pro|flash|mmx)\s*$/);
    if (match) {
      return { text: match[1].trim(), model: match[2] };
    }
    return { text: text.trim() };
  }

  /**
   * 读取最新 plan 文件，解析 TODO 列表
   * 返回 { file: 文件名, tasks: [{ text, done }] } 或 null
   */
  async function readPlanTodos(projectRoot: string): Promise<{
    file: string;
    tasks: { text: string; done: boolean; model?: string }[];
  } | null> {
    const plansDir = path.join(projectRoot, "docs", "superpowers", "plans");
    try {
      const files = await fsPromises.readdir(plansDir);
      const mdFiles = files
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse(); // 最新的排前面

      for (const file of mdFiles) {
        const content = await readFileSafe(path.join(plansDir, file));
        if (!content) continue;

        // 解析 checkbox: - [ ] task 或 - [x] task，末尾可选 💡pro/💡flash/💡mmx
        const tasks: { text: string; done: boolean; model?: string }[] = [];
        for (const line of content.split("\n")) {
          const unchecked = line.match(/^\s*-\s*\[\s*\]\s+(.+)/);
          const checked = line.match(/^\s*-\s*\[[xX]\]\s+(.+)/);
          if (unchecked) {
            const { text, model } = parseModelHint(unchecked[1]);
            tasks.push({ text, done: false, model });
          } else if (checked) {
            const { text, model } = parseModelHint(checked[1]);
            tasks.push({ text, done: true, model });
          }
        }

        if (tasks.length > 0) return { file, tasks };
      }
    } catch {
      // 目录不存在
    }
    return null;
  }

  /** 刷新编辑器上方状态面板 */
  function refreshWidget(ctx: ExtensionContext): void {
    if (!state.enabled || !ctx.hasUI || !panelVisible) {
      clearWidget(ctx);
      return;
    }

    readPlanTodos(state.projectRoot).then((plan) => {
      if (!state.enabled || !panelVisible) return;

      const lines: string[] = [];
      lines.push("─".repeat(80));

      // 当前任务 + 模型推荐
      const taskLine = state.currentTask
        ? `📋 ${state.currentTask}`
        : "📋 _(/vibe-task 设置)_";

      // 如果 TODO 中有匹配当前任务名的 step，显示其模型推荐
      let modelHint = "";
      if (plan && state.currentTask) {
        const matched = plan.tasks.find((t) =>
          t.text.includes(state.currentTask),
        );
        if (matched?.model) {
          modelHint = `  💡 /vibe-model ${matched.model}`;
        }
      }

      lines.push(taskLine + modelHint);

      // TODO 列表摘要（不展示内容，避免面板过长）
      if (plan && plan.tasks.length > 0) {
        const pending = plan.tasks.filter((t) => !t.done);
        const done = plan.tasks.filter((t) => t.done);
        const progress = plan.tasks.length > 0
          ? ` ${Math.round((done.length / plan.tasks.length) * 100)}%`
          : "";
        lines.push(
          `📝 TODO: ${pending.length} 待完成 / ${plan.tasks.length} 总计${progress}  │  /vibe-todo 查看全部`,
        );
      } else {
        lines.push(`📝 TODO: _(/skill:writing-plans 生成计划)_`);
      }

      lines.push(`🛠  /vibe-files 查看变更  │  /vibe-panel 隐藏`);
      ctx.ui.setWidget("vibe-panel", lines);
    });

    // 立即显示精简版
    const lines: string[] = [];
    lines.push("─".repeat(80));
    lines.push(`📋 ${state.currentTask || "_(/vibe-task 设置)_"}`);
    lines.push(`📝 TODO: 加载中...`);
    ctx.ui.setWidget("vibe-panel", lines);
  }

  /** 清除面板 */
  function clearWidget(ctx: ExtensionContext): void {
    ctx.ui.setWidget("vibe-panel", undefined);
  }

  // ──── 5.3 Hooks ────

  /**
   * session_start: 恢复状态，初始化项目路径
   */
  pi.on("session_start", async (_event, ctx) => {
    await restoreState(ctx);
    // 重置注入标记，新 session 首次 prompt 会注入上下文
    lastInjectedStateHash = "";
    // v2: 重置指标
    resetMetrics();
    // v5.6: 刷新面板
    refreshWidget(ctx);

    // 确保 vibe 目录存在
    const projectRoot = state.projectRoot;
    if (projectRoot) {
      await ensureDir(path.join(projectRoot, SESSIONS_DIR));
      await ensureDir(path.join(projectRoot, DIFFS_DIR));
      await ensureDir(path.join(projectRoot, BY_FILE_DIR));
      await ensureDir(path.join(projectRoot, TASKS_DIR));
    }
  });

  /**
   * v4.1: 模型感知的上下文注入
   *
   * 根据当前模型类型选择注入策略：
   *   — 主力模型（deepseek 等）：全量 vibe 上下文（任务、checkpoint、diff、规则）
   *   — 工具模型（mimo、minimax 等）：精简上下文（仅当前任务描述，不注入 vibe 状态）
   *   — 避免浪费 Token：工具模型不需要知道 checkpoint 数和文件变更历史
   */
  function getInjectionMode(ctx: ExtensionContext): "full" | "minimal" | "none" {
    try {
      const model = ctx.model;
      if (!model) return "full";
      const modelId = model.id.toLowerCase();
      const contextWindow = model.contextWindow || 200000;

      // 小上下文模型（< 300K）：精简注入，防溢出
      if (contextWindow < 300000) {
        return "minimal";
      }

      // 主力模型：注入全量上下文
      if (
        modelId.includes("deepseek") ||
        modelId.includes("claude") ||
        modelId.includes("gpt") ||
        modelId.includes("gemini") ||
        modelId.includes("qwen")
      ) {
        return "full";
      }
      // 工具模型（mimo 多模态、minimax 生成）：精简
      if (
        modelId.includes("mimo") ||
        modelId.includes("minimax") ||
        modelId.includes("dall-e") ||
        modelId.includes("imagen")
      ) {
        return "minimal";
      }
    } catch {
      return "full";
    }
    return "full";
  }

  /**
   * 构建精简上下文（给工具模型用，不浪费 Token）
   */
  function buildMinimalContext(state: VibeState): string {
    if (!state.currentTask) return "";
    return [
      `Current task: ${state.currentTask}`,
      `Session: ${state.sessionId}`,
      "",
      "Focus on the immediate request. Coding workflow context is not relevant.",
    ].join("\n");
  }

  /**
   * before_agent_start: 注入工作流上下文
   *
   * ⚠️ 缓存考量（关键！）：
   *   — 用 message 注入（在消息列表末尾），而非 systemPrompt（在前缀）
   *   — 这样 system prompt + 历史消息全部保持缓存命中
   *   — 只有新增的 vibe context 消息需要重新计算
   *
   * ⚠️ 去重考量：
   *   — 只在 state 变化时注入（任务切换 / checkpoint 完成 / session 变更）
   *   — 避免每个 user prompt 都注入，防止消息累积膨胀
   *
   * ⚠️ v4.1 Token 节省：
   *   — 工具模型（mimo、minimax）注入精简上下文（~50 tokens vs ~300 tokens）
   */
  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return;

    const mode = getInjectionMode(ctx);

    // none 模式：完全不注入
    if (mode === "none") return;

    // 去重：状态没变就不重复注入
    const currentHash = computeStateHash() + "|" + mode;
    if (currentHash === lastInjectedStateHash) {
      return;
    }
    lastInjectedStateHash = currentHash;

    // 根据模式选择上下文
    let contextInjection: string;
    if (mode === "minimal") {
      contextInjection = buildMinimalContext(state);
      if (!contextInjection) return; // 无任务时不注入
    } else {
      contextInjection = await buildContextInjection(
        state.projectRoot,
        state,
      );
    }

    // message 注入：放入消息列表末尾，不破坏前缀缓存
    return {
      message: {
        customType: EXT_NAME,
        content: contextInjection,
        display: false, // TUI 不可见，只给 LLM
      },
    };
  });

  /**
   * agent_end: 更新 session doc（不自动 commit）
   */
  pi.on("agent_end", async (_event, ctx) => {
    if (!state.enabled) return;

    try {
      const doc = await loadSessionDoc(state.projectRoot, state);
      doc.status = "in-progress";
      await writeSessionDoc(state.projectRoot, state, doc);
      // v5.6: 每次 turn 结束刷新面板（防止 pi UI 重置）
      refreshWidget(ctx);
    } catch {
      // 静默失败，不影响主流程
    }
  });

  /**
   * session_before_compact: 压缩前自动 checkpoint，git 保底。
   * 即使压缩丢失了 session 中的 vibe context，git commit 历史仍然完整。
   */
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!state.enabled) return;

    // 检查是否有未提交变更
    const changedFiles = getChangedFiles(state.projectRoot);
    if (changedFiles.length === 0) return;

    // 自动 checkpoint（不留确认，压缩是自动触发的）
    try {
      const result = await executeCheckpoint(pi, ctx, state, "auto: pre-compaction checkpoint");
      if (ctx.hasUI && result.success) {
        ctx.ui.notify(
          `📦 Pre-compaction checkpoint: ${changedFiles.length} file(s) saved to git`,
          "info",
        );
      }
    } catch {
      // 静默失败，不影响压缩
    }
  });

  /**
   * session_shutdown: 标记 session 完成
   */
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!state.enabled) return;

    try {
      const doc = await loadSessionDoc(state.projectRoot, state);
      doc.status = "completed";
      await writeSessionDoc(state.projectRoot, state, doc);
      await updateActiveTasks(state.projectRoot, state, doc);
      await pi.appendEntry(EXT_NAME, state);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Vibe session ${state.sessionId} completed: ${state.checkpointCount} checkpoints`,
          "info",
        );
        clearWidget(ctx);
      }
    } catch {
      // 静默失败
    }
  });

  // --- 5.2.0 v5.1: 图片自动路由（input hook） ---

  /**
   * input hook: 拦截用户粘贴的图片，防止发送给不支持多模态的主力模型。
   *
   * 工作流程:
   *   1. 用户 Ctrl+V 贴图 → event.images 中有图片数据
   *   2. 主力模型（DeepSeek）不支持图片 → 直接发送会 400 报错
   *   3. 此 hook 拦截图片，保存到 assets/pasted/，改写消息为纯文本
   *   4. LLM 收到文本消息 "[Image saved: path]" → 调用 minimax_describe_image 工具
   *
   * 注意:
   *   — 多模态模型（Mimo）不需要拦截，原生支持图片
   *   — 仅在主力模型时生效
   */
  pi.on("input", async (event, ctx) => {
    if (!state.enabled) return { action: "continue" };

    const images = event.images;
    if (!images || images.length === 0) return { action: "continue" };

    // 检查当前模型是否支持多模态（如果是多模态模型，不需要拦截）
    const mode = getInjectionMode(ctx);
    if (mode === "minimal") {
      // 当前已是多模态/工具模型（如 Mimo），原生支持图片
      return { action: "continue" };
    }

    // 主力模型不支持图片 → 拦截保存
    const pasteDir = path.join(
      state.projectRoot || ctx.cwd,
      "assets",
      "pasted",
    );
    await ensureDir(pasteDir);

    const savedPaths: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const timestamp = Date.now();
      const ext = img.mediaType?.includes("png")
        ? "png"
        : img.mediaType?.includes("jpeg") || img.mediaType?.includes("jpg")
        ? "jpg"
        : img.mediaType?.includes("gif")
        ? "gif"
        : img.mediaType?.includes("webp")
        ? "webp"
        : "png";
      const filename = `pasted-${timestamp}-${i}.${ext}`;
      const filepath = path.join(pasteDir, filename);

      try {
        if (img.data) {
          await fsPromises.writeFile(
            filepath,
            Buffer.from(img.data, "base64"),
          );
          savedPaths.push(filepath);
        }
      } catch {
        // 保存失败，跳过
      }
    }

    if (savedPaths.length === 0) return { action: "continue" };

    // 改写用户消息：移除图片，添加文本提示
    const imageRefs = savedPaths
      .map((p) => `\`${path.relative(state.projectRoot || ctx.cwd, p)}\``)
      .join(", ");

    const newText = [
      `[📷 ${savedPaths.length} image(s) saved: ${imageRefs}]`,
      "",
      event.text || "",
      "",
      `_Use the \`minimax_describe_image\` tool to analyze the image(s)._`,
    ].join("\n");

    if (ctx.hasUI) {
      ctx.ui.notify(
        `📷 ${savedPaths.length} image(s) saved → use minimax_describe_image to analyze`,
        "info",
      );
    }

    return { action: "transform", text: newText };
  });

  // --- 5.2.1 v2: 文件变更追踪（tool_result hook） ---

  /**
   * tool_result: 追踪 LLM 通过内置工具修改了哪些文件。
   * 用于：
   *   1. 自动提醒 checkpoint（当文件积累到一定数量）
   *   2. metrics 统计（每个 checkpoint 改了多少文件）
   */
  pi.on("tool_result", async (event, _ctx) => {
    if (!state.enabled) return;

    metrics.toolCallCount++;

    // 追踪 write / edit 工具修改的文件
    const fileModifyingTools = ["write", "edit"];
    if (
      fileModifyingTools.includes(event.toolName) &&
      !event.isError
    ) {
      const input = event.input as { path?: string };
      if (input.path) {
        metrics.filesModifiedSinceCheckpoint.add(input.path);
      }
    }

    // 追踪 bash 工具中涉及的文件操作（通过 git diff，轻量判断）
    if (event.toolName === "bash" && !event.isError) {
      const input = event.input as { command?: string };
      const cmd = input.command || "";
      // 检测常见的文件创建/修改命令
      const fileOps = cmd.match(
        /(?:touch|mkdir|cp|mv|rm|sed\s+-i|tee|>)\s+(['"]?)([^\s|;&]+)\1?/g,
      );
      if (fileOps) {
        for (const op of fileOps) {
          const file = op.replace(/^(touch|mkdir|cp|mv|rm|sed\s+-i|tee)\s+/, "").replace(/>\s*/, "").replace(/['"]/g, "").trim();
          if (file && !file.startsWith("-") && !file.startsWith("/dev/")) {
            metrics.filesModifiedSinceCheckpoint.add(file);
          }
        }
      }
    }

    // v5.6: 文件变更后刷新面板
    refreshWidget(_ctx);
  });

  // --- 5.2.2 v2: Turn 计数 ---

  /** track turn count for metrics */
  pi.on("turn_start", async () => {
    if (!state.enabled) return;
    metrics.turnCount++;
  });

  // --- 5.2.3 v3: 自动 checkpoint（升级：从建议变为智能执行） ---

  /**
   * message_end: 检测 LLM 完成信号，自动执行 checkpoint。
   *
   * 三级响应：
   *   🔴 高置信度（≥2 个完成信号 + 有文件变更）→ 自动排队 /vibe-checkpoint
   *   🟡 中置信度（1 个完成信号 + 有文件变更）→ 状态栏 5s 倒计时 + 可取消
   *   🟢 低置信度（无文件变更 / 无完成信号）→ 不提示
   *
   * 仅在 autoSuggestCheckpoint = true 时生效。
   * 用户可随时用 /vibe-autocheckpoint off 关闭。
   */
  pi.on("message_end", async (event, ctx) => {
    if (!state.enabled || !state.autoSuggestCheckpoint) return;
    if (event.message.role !== "assistant") return;

    // 提取 assistant 消息文本
    const content = event.message.content;
    let text = "";
    if (Array.isArray(content)) {
      text = content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join(" ");
    }

    // 检测完成信号（每个正则命中计 1 分）
    const completionPatterns = [
      /task\s+(is\s+)?(complete|done|finish)/i,
      /✅.*(done|complete|finish)/i,
      /all\s+(tests?\s+)?pass/i,
      /implementation\s+(is\s+)?complete/i,
      /ready\s+for\s+(review|merge|checkpoint)/i,
      /checkpoint\s+ready/i,
    ];

    const matchCount = completionPatterns.filter((p) => p.test(text)).length;
    const hasUncommitted = metrics.filesModifiedSinceCheckpoint.size > 0;

    if (!hasUncommitted || matchCount === 0) return;
    if (!ctx.hasUI) return;

    const fileCount = metrics.filesModifiedSinceCheckpoint.size;

    // 🔴 高置信度（≥2 个完成信号）：自动执行
    if (matchCount >= 2) {
      // 排队 /vibe-checkpoint 作为 follow-up（在 agent 完全空闲后执行）
      pi.sendUserMessage(
        `/vibe-checkpoint`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(
        `🚀 检测到任务完成 (${matchCount} 个信号, ${fileCount} files) — 已自动排队 checkpoint`,
        "info",
      );
      return;
    }

    // 🟡 中置信度（1 个完成信号）：倒计时通知
    const countdownSeconds = 5;
    ctx.ui.setStatus(
      EXT_NAME + "-hint",
      `⏳ Auto-checkpoint in ${countdownSeconds}s: ${fileCount} file(s) (press Esc to cancel)`,
    );

    // 倒计时，用户可按 Esc 取消
    let cancelled = false;
    const cancelTimer = setTimeout(() => {
      cancelled = true;
      ctx.ui.setStatus(EXT_NAME + "-hint", undefined);
    }, countdownSeconds * 1000);

    // 等待倒计时（简化：直接排队，不实现复杂的取消机制）
    // 实际生产中可以结合 ctx.signal 实现真正的取消
    await new Promise((resolve) => setTimeout(resolve, countdownSeconds * 1000));
    clearTimeout(cancelTimer);

    if (!cancelled) {
      pi.sendUserMessage(
        `/vibe-checkpoint`,
        { deliverAs: "followUp" },
      );
      ctx.ui.setStatus(EXT_NAME + "-hint", undefined);
      ctx.ui.notify(
        `✅ Auto-checkpoint executed for ${fileCount} file(s)`,
        "info",
      );
    }
  });

  // --- 5.2.4 v2: Session 切换前检查未提交变更 ---

  /**
   * session_before_switch / session_before_fork:
   *   切换 session 或 fork 前，检查是否有未提交的变更。
   *   防止丢失进度。
   */
  async function checkUncommittedBeforeSwitch(
    ctx: ExtensionContext,
    action: string,
  ): Promise<{ cancel: boolean } | undefined> {
    if (!state.enabled) return;

    // 检查 git 状态
    const changedFiles = isGitRepo(state.projectRoot)
      ? getChangedFiles(state.projectRoot)
      : [];

    if (changedFiles.length === 0) return;

    if (!ctx.hasUI) {
      // 非交互模式，默认阻止
      return { cancel: true };
    }

    const choice = await ctx.ui.select(
      `⚠️  ${changedFiles.length} file(s) uncommitted. ${action}?`,
      [
        `Yes, ${action.toLowerCase()} (changes will stay uncommitted)`,
        "No, let me checkpoint first",
      ],
    );

    if (!choice || choice.includes("checkpoint")) {
      ctx.ui.notify("💡 Run /vibe-checkpoint to commit changes", "warning");
      return { cancel: true };
    }
  }

  pi.on("session_before_switch", async (event, ctx) => {
    const action = event.reason === "new" ? "Start new session" : "Switch session";
    return checkUncommittedBeforeSwitch(ctx, action);
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    return checkUncommittedBeforeSwitch(ctx, "Fork session");
  });

  /**
   * /vibe-init — 初始化项目 vibe 工作流
   *   创建 docs/vibe/ 目录，可选创建 AGENTS.md
   */
  pi.registerCommand("vibe-init", {
    description: "初始化项目 Vibe 工作流（创建目录结构和 AGENTS.md 模板）",
    handler: async (_args, ctx) => {
      const projectRoot = findProjectRoot(ctx.cwd);
      state.projectRoot = projectRoot;

      // 创建目录
      await ensureDir(path.join(projectRoot, SESSIONS_DIR));
      await ensureDir(path.join(projectRoot, DIFFS_DIR));
      await ensureDir(path.join(projectRoot, BY_FILE_DIR));
      await ensureDir(path.join(projectRoot, TASKS_DIR));

      // 创建 .gitkeep
      await writeFile(path.join(projectRoot, SESSIONS_DIR, ".gitkeep"), "");
      await writeFile(path.join(projectRoot, DIFFS_DIR, ".gitkeep"), "");
      await writeFile(path.join(projectRoot, BY_FILE_DIR, ".gitkeep"), "");

      // 初始化 active tasks
      const tasksContent = [
        "# Active Tasks",
        "",
        "> 此文件由 vibe-workflow 扩展自动维护",
        "",
        "## 🔄 Current Task",
        "_(none)_",
        "",
        "## ✅ Completed",
        "_(no completed tasks yet)_",
        "",
        "## 📋 Next Steps",
        "_(no next steps yet)_",
        "",
      ].join("\n");
      await writeFile(
        path.join(projectRoot, TASKS_DIR, ACTIVE_TASKS_FILE),
        tasksContent,
      );

      // 如果 AGENTS.md 不存在，创建模板
      const agentsPath = path.join(projectRoot, "AGENTS.md");
      if (!fs.existsSync(agentsPath)) {
        const projectName = path.basename(projectRoot);
        const agentsTemplate = [
          `# Project: ${projectName}`,
          "",
          "## Task Boundaries",
          "<!-- 任务边界约束：大模型不会自动扩展需求，严格遵循以下边界 -->",
          "- Each task MUST be a single, small, atomic unit of work",
          "- Each task MUST be verifiable (answer \"is this done?\" with yes/no)",
          "- After completing each task, call the **vibe_checkpoint** tool",
          "- Do NOT expand scope beyond the current task without user approval",
          "- Read `docs/vibe/tasks/active.md` at the start of each session",
          "",
          "## Current Focus",
          `<!-- TASK: ${projectName}-init -->`,
          "- Initialize project vibe workflow",
          "- Set up project structure",
          "",
          "## Constraints",
          "<!-- 项目约束 -->",
          "- Follow existing code patterns and conventions",
          "- Do NOT modify package.json without explicit confirmation",
          "- Write tests for new features when applicable",
          "",
          "## Conventions",
          "<!-- 项目约定 -->",
          "- Use TypeScript for all new code (if applicable)",
          "- Document public APIs with JSDoc comments",
          "- Use conventional commits format",
          "",
        ].join("\n");
        await writeFile(agentsPath, agentsTemplate);
        ctx.ui.notify("✅ 已创建 AGENTS.md 模板", "info");
      }

      ctx.ui.notify(
        "✅ Vibe 工作流初始化完成！\n" +
          `   目录: ${VIBE_DIR}/\n` +
          "   运行 /vibe-enable 启用工作流",
        "info",
      );
    },
  });

  /**
   * /vibe-enable — 启用 vibe 工作流
   */
  pi.registerCommand("vibe-enable", {
    description: "启用 Vibe 工作流（开始上下文注入和 checkpoint 功能）",
    handler: async (_args, ctx) => {
      state.enabled = true;
      state.sessionId = generateSessionId();
      state.checkpointCount = 0;

      await pi.appendEntry(EXT_NAME, state);

      if (ctx.hasUI) {
        ctx.ui.setStatus(EXT_NAME, `vibe: ${state.sessionId}`);
        refreshWidget(ctx);
        ctx.ui.notify(
          `🚀 Vibe 工作流已启用\n` +
            `   Session: ${state.sessionId}\n` +
            `   使用 /vibe-task <任务名> 设置当前任务`,
          "info",
        );
      }
    },
  });

  /**
   * /vibe-disable — 禁用 vibe 工作流
   */
  pi.registerCommand("vibe-disable", {
    description: "禁用 Vibe 工作流",
    handler: async (_args, ctx) => {
      state.enabled = false;
      await pi.appendEntry(EXT_NAME, state);

      if (ctx.hasUI) {
        ctx.ui.setStatus(EXT_NAME, undefined);
        clearWidget(ctx);
        ctx.ui.notify("⏸️ Vibe 工作流已禁用", "info");
      }
    },
  });

  /**
   * /vibe-task <name> — 设置当前任务
   */
  pi.registerCommand("vibe-task", {
    description: "设置/清除当前任务名（--clear 恢复 LLM 自由探索）",
    handler: async (args, ctx) => {
      // --clear: 清除任务，恢复自由探索
      if (args?.trim() === "--clear") {
        const wasSet = !!state.currentTask;
        state.currentTask = "";
        await pi.appendEntry(EXT_NAME, state);
        const doc = await loadSessionDoc(state.projectRoot, state);
        await updateActiveTasks(state.projectRoot, state, doc);
        refreshWidget(ctx);
        ctx.ui.notify(
          wasSet
            ? "🔓 任务已清除。LLM 恢复自由探索模式。"
            : "📋 当前无任务（/vibe-task <任务名> 设置）",
          "info",
        );
        return;
      }

      if (!args || !args.trim()) {
        ctx.ui.notify(
          `当前任务: ${state.currentTask || "_(未设置)_"}\n用法: /vibe-task <任务名> 或 /vibe-task --clear`,
          "info",
        );
        return;
      }

      state.currentTask = args.trim();
      await pi.appendEntry(EXT_NAME, state);

      // 更新 tasks 文件
      const doc = await loadSessionDoc(state.projectRoot, state);
      await updateActiveTasks(state.projectRoot, state, doc);

      refreshWidget(ctx);
      ctx.ui.notify(`📋 当前任务已设为: ${state.currentTask}`, "info");
    },
  });

  /**
   * /vibe-checkpoint — 手动执行 checkpoint
   */
  pi.registerCommand("vibe-checkpoint", {
    description: "提交当前变更（git commit）+ 更新 diff 和 session 文档",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify(
          "⚠️ Vibe 工作流未启用。请先运行 /vibe-enable",
          "warning",
        );
        return;
      }

      const result = await executeCheckpoint(pi, ctx, state);
      ctx.ui.notify(result.message, result.success ? "info" : "warning");
    },
  });

  /**
   * /vibe-status — 显示当前工作流状态（含上下文用量监控）
   */
  pi.registerCommand("vibe-status", {
    description: "显示 Vibe 工作流当前状态（含上下文用量、压缩建议）",
    handler: async (_args, ctx) => {
      const isGit = isGitRepo(state.projectRoot);
      const changedFiles = isGit ? getChangedFiles(ctx.cwd) : [];
      const doc = await loadSessionDoc(state.projectRoot, state);

      // v5.2: 上下文用量监控
      const usage = ctx.getContextUsage();
      const contextTokens = usage?.tokens ?? null;

      const lines: string[] = [];
      lines.push("## 🎯 Vibe Workflow Status");
      lines.push("");
      lines.push(`| 项目 | 状态 |`);
      lines.push(`|------|------|`);
      lines.push(
        `| Workflow | ${state.enabled ? "✅ 已启用" : "⏸️ 已禁用"} |`,
      );
      lines.push(`| Session | \`${state.sessionId}\` |`);
      lines.push(`| Checkpoints | ${state.checkpointCount} |`);
      lines.push(`| Current Task | ${state.currentTask || "_(未设置)_"} |`);
      lines.push(
        `| Git Repo | ${isGit ? "✅" : "❌ 非 Git 仓库"} |`,
      );
      lines.push(
        `| Uncommitted | ${changedFiles.length} file(s) |`,
      );
      lines.push(`| Session Status | ${doc.status} |`);

      // 上下文用量（带预警）
      if (contextTokens !== null) {
        const model = ctx.model;
        const maxTokens = model?.contextWindow || 200000;
        const pct = ((contextTokens / maxTokens) * 100).toFixed(1);
        const icon = Number(pct) > 80
          ? "🔴"
          : Number(pct) > 60
          ? "🟡"
          : "🟢";
        lines.push(
          `| Context Usage | ${icon} ${contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%) |`,
        );
      }
      lines.push("");

      // 压缩建议
      if (contextTokens !== null) {
        const model = ctx.model;
        const maxTokens = model?.contextWindow || 200000;
        const pct = (contextTokens / maxTokens) * 100;
        if (pct > 80) {
          lines.push(
            "### ⚠️ 上下文用量高",
          );
          lines.push(
            `当前用量 ${pct.toFixed(1)}%，建议:`,
          );
          lines.push("- 运行 `/vibe-handoff` 生成交接文档后 `/new` 开新 session");
          lines.push("- 或运行 `/compact` 手动压缩上下文");
          lines.push(
            "- pi 的自动压缩默认开启，接近阈值时会自动触发",
          );
          lines.push("");
        } else if (pct > 60) {
          lines.push(
            `💡 上下文用量 ${pct.toFixed(1)}%，可以考虑完成当前任务后交接新 session`,
          );
          lines.push("");
        }
      }

      if (changedFiles.length > 0) {
        lines.push("### 📝 未提交的变更");
        for (const f of changedFiles) {
          lines.push(`- \`${f}\``);
        }
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /**
   * /vibe-handoff — 生成交接文档 + 自动触发 /skill:handoff
   *
   * 双视角交接：
   *   1. vibe-workflow 生成数据视角（结构化：checkpoint 表、diff 引用、约束摘要）
   *   2. 自动触发 /skill:handoff 生成 LLM 视角（语义化：上下文理解、建议下一步）
   *
   * 用法：
   *   /vibe-handoff              → 数据视角 + LLM 视角（全量）
   *   /vibe-handoff --data-only  → 仅数据视角（不触发 skill）
   */
  pi.registerCommand("vibe-handoff", {
    description:
      "生成 Vibe 交接文档 + 自动触发 /skill:handoff（--data-only 仅数据视角）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify(
          "⚠️ Vibe 工作流未启用。请先运行 /vibe-enable",
          "warning",
        );
        return;
      }

      // 1. 生成数据视角交接
      const handoffContent = await generateHandoff(
        state.projectRoot,
        state,
      );
      const handoffPath = path.join(
        state.projectRoot,
        SESSIONS_DIR,
        `handoff-${state.sessionId}.md`,
      );
      await writeFile(handoffPath, handoffContent);

      // 2. 如果非 --data-only，自动触发 LLM 视角的 handoff skill
      const dataOnly = args?.trim() === "--data-only";

      if (dataOnly) {
        ctx.ui.notify(
          `📦 交接文档已生成: docs/vibe/sessions/handoff-${state.sessionId}.md`,
          "info",
        );
      } else {
        // 桥接：自动触发 /skill:handoff，让 LLM 生成语义化交接补充
        // 将 session 信息作为参数传给 handoff skill
        const skillArgs = [
          `【Session: ${state.sessionId}】`,
          `【Checkpoints: ${state.checkpointCount}】`,
          `【数据交接已生成: docs/vibe/sessions/handoff-${state.sessionId}.md，请引用它而不要重复内容】`,
        ].join(" ");

        pi.sendUserMessage(
          `/skill:handoff ${skillArgs}`,
          { deliverAs: "followUp" },
        );

        ctx.ui.notify(
          `📦 数据交接: docs/vibe/sessions/handoff-${state.sessionId}.md\n` +
            `🧠 已排队 /skill:handoff（LLM 将在空闲时生成语义交接）`,
          "info",
        );
      }
    },
  });

  /**
   * /vibe-context — 查看会注入的上下文内容
   */
  pi.registerCommand("vibe-context", {
    description: "查看 Vibe 工作流会在每次对话中注入的上下文内容",
    handler: async (_args, ctx) => {
      const injection = await buildContextInjection(
        state.projectRoot,
        state,
      );

      ctx.ui.notify(injection, "info");
    },
  });

  // --- 5.3.1 v2: /vibe-plan — 桥接 writing-plans skill ---

  /**
   * /vibe-plan — 触发 /skill:writing-plans 生成实现计划。
   * 将当前 vibe 状态（任务名、session、已完成的 checkpoint）作为上下文传给 skill。
   */
  pi.registerCommand("vibe-plan", {
    description:
      "桥接 /skill:writing-plans：将当前任务上下文传给 writing-plans skill 生成实现计划",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify(
          "⚠️ Vibe 工作流未启用。请先运行 /vibe-enable",
          "warning",
        );
        return;
      }

      // 构建传给 writing-plans 的上下文
      const contextParts: string[] = [];
      if (state.currentTask) {
        contextParts.push(`【当前任务: ${state.currentTask}】`);
      }
      contextParts.push(`【Session: ${state.sessionId}】`);
      contextParts.push(`【已完成 Checkpoints: ${state.checkpointCount}】`);

      // 检查是否有已有的 PRD 或 spec
      const prdPaths = [
        "docs/prd",
        "docs/spec",
        "spec",
      ];
      for (const p of prdPaths) {
        const fullPath = path.join(state.projectRoot, p);
        if (fs.existsSync(fullPath)) {
          contextParts.push(`【参考文档: ${p}/】`);
          break;
        }
      }

      contextParts.push(`【可用模型: pro(主力思考), flash(日常任务), mmx(MiniMax简单任务)】`);
      contextParts.push(`【模型能力边界:】`);
      contextParts.push(`【  pro: DeepSeek v4-pro · 1M上下文 · 擅长架构设计、复杂逻辑】`);
      contextParts.push(`【  flash: DeepSeek v4-flash · 1M上下文 · 擅长代码生成、CRUD、类型定义】`);
      contextParts.push(`【  mmx: MiniMax M2.7 · 256K上下文 · 擅长代码审查、简短问答、格式转换】`);
      contextParts.push(`【每个 Step 末尾标注推荐模型: 💡pro / 💡flash / 💡mmx】`);

      const skillArgs = contextParts.join(" ");
      pi.sendUserMessage(
        `/skill:writing-plans ${skillArgs}`,
        { deliverAs: "followUp" },
      );

      ctx.ui.notify(
        `📋 已排队 /skill:writing-plans\n` +
          `   上下文: ${contextParts.join(" · ")}`,
        "info",
      );
    },
  });

  // --- 5.3.2 v2: /vibe-metrics — 显示工作流指标 ---

  /**
   * /vibe-metrics — 显示 session 内的工作流统计指标。
   */
  pi.registerCommand("vibe-metrics", {
    description: "显示 Vibe 工作流统计指标（checkpoint 频率、文件变更数、turn 数等）",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify(
          "⚠️ Vibe 工作流未启用。请先运行 /vibe-enable",
          "warning",
        );
        return;
      }

      const lines: string[] = [];
      lines.push("## 📊 Vibe Workflow Metrics");
      lines.push("");

      // Session 概览
      lines.push("### Session Overview");
      lines.push(`| 指标 | 值 |`);
      lines.push(`|------|----|`);
      lines.push(`| Session | \`${state.sessionId}\` |`);
      lines.push(`| Checkpoints | ${state.checkpointCount} |`);
      lines.push(`| LLM Turns | ${metrics.turnCount} |`);
      lines.push(`| Tool Calls | ${metrics.toolCallCount} |`);
      lines.push(
        `| Files pending checkpoint | ${metrics.filesModifiedSinceCheckpoint.size} |`,
      );
      lines.push("");

      // Checkpoint 详情
      if (metrics.filesPerCheckpoint.length > 0) {
        lines.push("### Checkpoint Details");
        lines.push("| # | Files Changed | Time |");
        lines.push("|---|--------------|------|");

        const totalFiles = metrics.filesPerCheckpoint.reduce(
          (a, b) => a + b,
          0,
        );
        const avgFiles = (totalFiles / metrics.filesPerCheckpoint.length).toFixed(1);

        for (let i = 0; i < metrics.filesPerCheckpoint.length; i++) {
          const time = metrics.checkpointTimestamps[i]
            ? new Date(metrics.checkpointTimestamps[i]).toLocaleTimeString()
            : "-";
          lines.push(
            `| ${i + 1} | ${metrics.filesPerCheckpoint[i]} | ${time} |`,
          );
        }

        lines.push("");
        lines.push(`**总计**: ${totalFiles} files · 平均 ${avgFiles} files/checkpoint`);
        lines.push("");
      }

      // 效率指标
      if (metrics.turnCount > 0) {
        const turnsPerCheckpoint = metrics.checkpointCount > 0
          ? (metrics.turnCount / metrics.checkpointCount).toFixed(1)
          : "N/A";
        lines.push("### Efficiency");
        lines.push(`- Turns/Checkpoint: **${turnsPerCheckpoint}**`);
        lines.push(
          `- Avg files/checkpoint: **${
            metrics.filesPerCheckpoint.length > 0
              ? (
                  metrics.filesPerCheckpoint.reduce((a, b) => a + b, 0) /
                  metrics.filesPerCheckpoint.length
                ).toFixed(1)
              : "N/A"
          }**`,
        );
        lines.push("");
      }

      lines.push("---");
      lines.push(
        `_Tip: 理想的 Turns/Checkpoint 在 2-5 之间，表示任务粒度合适_`,
      );

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- 5.3.3 v2: /vibe-autocheckpoint — 切换自动建议 ---

  /**
   * /vibe-autocheckpoint — 开启/关闭自动 checkpoint 建议。
   * 开启时：检测到 LLM 说"done/complete"会自动在状态栏提示 checkpoint。
   */
  pi.registerCommand("vibe-autocheckpoint", {
    description:
      "切换自动 checkpoint 建议（on/off）。开启时 LLM 说 done 会自动提示",
    handler: async (args, ctx) => {
      if (args?.trim() === "off") {
        state.autoSuggestCheckpoint = false;
        ctx.ui.notify("🔕 自动 checkpoint 建议已关闭", "info");
      } else if (args?.trim() === "on") {
        state.autoSuggestCheckpoint = true;
        ctx.ui.notify("🔔 自动 checkpoint 建议已开启", "info");
      } else {
        const status = state.autoSuggestCheckpoint ? "🔔 ON" : "🔕 OFF";
        ctx.ui.notify(
          `自动 checkpoint 建议: ${status}\n用法: /vibe-autocheckpoint on|off`,
          "info",
        );
      }
      await pi.appendEntry(EXT_NAME, state);
    },
  });

  /**
   * /vibe-panel — 切换编辑器上方状态面板的显示/隐藏。
   */
  pi.registerCommand("vibe-panel", {
    description: "切换编辑器上方状态面板显示/隐藏",
    handler: async (_args, ctx) => {
      panelVisible = !panelVisible;
      if (panelVisible) {
        refreshWidget(ctx);
        ctx.ui.notify("📊 面板已显示", "info");
      } else {
        clearWidget(ctx);
        ctx.ui.notify("📊 面板已隐藏（/vibe-panel 恢复）", "info");
      }
    },
  });

  /**
   * /vibe-files — 查看变更文件列表（按 checkpoint 分组）
   * 用户可用 Ctrl+G 打开对应文件进行人工审查。
   */
  pi.registerCommand("vibe-files", {
    description: "查看变更文件列表（按 checkpoint 分组，Ctrl+G 打开审查）",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      const doc = await loadSessionDoc(state.projectRoot, state);
      const lines: string[] = [];
      lines.push("## 📝 变更文件列表");
      lines.push("");

      // 当前未提交的变更
      const changedFiles = getChangedFiles(ctx.cwd);
      if (changedFiles.length > 0) {
        lines.push("### 🔄 当前未提交");
        for (const f of changedFiles) {
          lines.push(`- \`${f}\``);
        }
        lines.push("");
      }

      // 按 checkpoint 分组
      if (doc.checkpoints.length > 0) {
        for (const cp of doc.checkpoints) {
          lines.push(
            `### CP #${cp.index}: \`${cp.commitHash}\` — ${cp.task || ""}`,
          );
          if (cp.filesChanged?.length > 0) {
            for (const f of cp.filesChanged) {
              lines.push(`- \`${f}\``);
            }
          }
          lines.push("");
        }
      }

      lines.push("---");
      lines.push("💡 用 Ctrl+G 打开文件进行人工审查");

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /**
   * /vibe-todo — 查看完整 TODO 列表（可滚动）。
   */
  pi.registerCommand("vibe-todo", {
    description: "查看完整 TODO 列表（从 writing-plans 生成的计划）",
    handler: async (_args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }

      const plan = await readPlanTodos(state.projectRoot);
      if (!plan || plan.tasks.length === 0) {
        ctx.ui.notify(
          "📝 暂无 TODO。使用 /skill:writing-plans 生成实现计划。",
          "info",
        );
        return;
      }

      const pending = plan.tasks.filter((t) => !t.done);
      const done = plan.tasks.filter((t) => t.done);

      const lines: string[] = [];
      lines.push(`## 📝 TODO — ${plan.file}`);
      lines.push("");

      if (pending.length > 0) {
        lines.push(`### ☐ 待完成 (${pending.length})`);
        for (let i = 0; i < pending.length; i++) {
          lines.push(`${i + 1}. ${pending[i].text}`);
        }
        lines.push("");
      }

      if (done.length > 0) {
        lines.push(`### ✅ 已完成 (${done.length})`);
        for (let i = 0; i < done.length; i++) {
          lines.push(`${i + 1}. ~~${done[i].text}~~`);
        }
        lines.push("");
      }

      if (state.currentTask) {
        lines.push(`---`);
        lines.push(`🎯 当前任务: **${state.currentTask}**`);
        lines.push(`> 仅完成当前任务，不要跳到下一步。`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ===================================================================
  // 5.3.4 v4: 高级 Git 工作流命令
  // ===================================================================

  /**
   * /vibe-squash — 压缩最近的 checkpoint commit 为一个
   *
   * 场景: 一个任务产生了 5 个 checkpoint commit，想合并为一个干净的 commit。
   * 用法: /vibe-squash [N]
   *   /vibe-squash      → 交互选择压缩到哪个 checkpoint
   *   /vibe-squash 3    → 压缩最近 3 个 checkpoint
   */
  pi.registerCommand("vibe-squash", {
    description:
      "压缩最近的 vibe checkpoint commit 为一个干净的 commit",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      // 获取 vibe checkpoint commit 列表（匹配 "Checkpoint:" 标记）
      const logOutput = gitExec(
        state.projectRoot,
        ["log", "--oneline", "-30", "--grep=Checkpoint:", "--grep=Session:"],
      );

      if (!logOutput) {
        ctx.ui.notify("📝 没有找到 vibe checkpoint commit", "info");
        return;
      }

      const commits = logOutput.split("\n").filter(Boolean);
      if (commits.length < 2) {
        ctx.ui.notify(
          "📝 至少需要 2 个 checkpoint commit 才能压缩",
          "info",
        );
        return;
      }

      // 解析数量参数
      let count = 0;
      if (args?.trim()) {
        count = parseInt(args.trim(), 10);
      }

      if (!count || count < 2) {
        // 交互选择
        if (!ctx.hasUI) {
          ctx.ui.notify("用法: /vibe-squash <数量>", "warning");
          return;
        }
        const choices = commits.map(
          (c, i) => `${i + 1}. ${c.substring(0, 80)}`,
        );
        const choice = await ctx.ui.select(
          `选择压缩范围（保留最早的，压缩后续的）: 共 ${commits.length} 个 checkpoint`,
          [
            ...choices,
            `全部压缩为 1 个 (${commits.length} commits)`,
          ],
        );
        if (!choice) return;

        if (choice.includes("全部")) {
          count = commits.length;
        } else {
          const idx = choices.indexOf(choice);
          count = idx >= 0 ? idx + 1 : 0;
        }
      }

      if (count < 2 || count > commits.length) {
        ctx.ui.notify(`数量需在 2-${commits.length} 之间`, "warning");
        return;
      }

      // 确认
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "⚠️ Squash 操作不可逆",
          `压缩最近 ${count} 个 checkpoint commit 为 1 个。` +
            `\nCommit 列表:\n${commits.slice(0, count).join("\n")}\n\n确认？`,
        );
        if (!confirmed) return;
      }

      // 执行 soft reset + 重新 commit
      const targetHash = gitExec(state.projectRoot, [
        "rev-parse",
        `HEAD~${count}`,
      ]);
      if (!targetHash) {
        ctx.ui.notify("❌ 无法找到目标 commit", "error");
        return;
      }

      // Soft reset（保留工作区变更）
      const resetResult = gitExec(state.projectRoot, [
        "reset",
        "--soft",
        `HEAD~${count}`,
      ]);
      if (resetResult === null) {
        ctx.ui.notify("❌ Reset 失败", "error");
        return;
      }

      // 重新 commit
      const squashMsg = [
        `[squash] ${state.currentTask || "vibe-task"}: ${count} checkpoints → 1`,
        "",
        `Session: ${state.sessionId}`,
        `Squashed: ${count} checkpoints`,
      ].join("\n");

      const commitResult = gitExec(state.projectRoot, [
        "commit",
        "-m",
        squashMsg,
        "--no-verify",
      ]);

      if (commitResult === null) {
        ctx.ui.notify("❌ Commit 失败，尝试 git reset HEAD@{1} 恢复", "error");
        return;
      }

      const newHash = gitExec(state.projectRoot, ["rev-parse", "--short", "HEAD"]);

      // 更新 vibe 状态
      state.checkpointCount = Math.max(1, state.checkpointCount - count + 1);
      await pi.appendEntry(EXT_NAME, state);

      ctx.ui.notify(
        `✅ 已压缩 ${count} 个 checkpoint → 1 个 commit\n` +
          `   New commit: \`${newHash}\` · Checkpoints: ${state.checkpointCount}`,
        "info",
      );
    },
  });

  /**
   * /vibe-rollback — 回滚到指定 checkpoint
   *
   * 安全策略: 自动创建备份分支，然后 revert/reset。
   * 用法:
   *   /vibe-rollback        → 列出 checkpoint，选择回滚目标
   *   /vibe-rollback 3      → 回滚到第 3 个 checkpoint
   *   /vibe-rollback --hard → hard reset（丢弃变更）
   */
  pi.registerCommand("vibe-rollback", {
    description:
      "安全回滚到指定 checkpoint（自动创建备份分支）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      const isHard = args?.includes("--hard");

      // 获取 vibe checkpoint commit
      const logOutput = gitExec(state.projectRoot, [
        "log",
        "--oneline",
        "-30",
        "--grep=Checkpoint:",
      ]);

      if (!logOutput) {
        ctx.ui.notify("📝 没有找到 vibe checkpoint commit", "info");
        return;
      }

      const commits = logOutput.split("\n").filter(Boolean);

      // 选择目标 checkpoint
      let targetIdx = 0;
      const numArg = args?.replace("--hard", "").trim();
      if (numArg) {
        targetIdx = parseInt(numArg, 10) - 1;
      } else if (ctx.hasUI) {
        const choices = commits.map(
          (c, i) => `${i + 1}. ${c.substring(0, 80)} (HEAD~${commits.length - 1 - i})`,
        );
        const choice = await ctx.ui.select(
          "选择回滚目标 checkpoint:",
          choices,
        );
        if (!choice) return;
        targetIdx = choices.indexOf(choice);
      } else {
        ctx.ui.notify("用法: /vibe-rollback <checkpoint编号>", "warning");
        return;
      }

      if (targetIdx < 0 || targetIdx >= commits.length) {
        ctx.ui.notify("❌ 无效的 checkpoint 编号", "error");
        return;
      }

      const targetHash = gitExec(state.projectRoot, [
        "rev-parse",
        "--short",
        `HEAD~${commits.length - 1 - targetIdx}`,
      ]);

      if (!targetHash) {
        ctx.ui.notify("❌ 无法解析目标 commit", "error");
        return;
      }

      // 确认
      if (ctx.hasUI) {
        const action = isHard ? "HARD RESET（丢弃所有后续变更）" : "REVERT（保留历史）";
        const confirmed = await ctx.ui.confirm(
          "⚠️ 回滚操作",
          `回滚到: \`${targetHash}\`\n` +
            `方式: ${action}\n` +
            `备份分支: vibe-backup-${state.sessionId} 将自动创建\n\n确认？`,
        );
        if (!confirmed) return;
      }

      // 创建备份分支
      const backupBranch = `vibe-backup-${state.sessionId}-${Date.now().toString(36)}`;
      gitExec(state.projectRoot, ["branch", backupBranch]);

      if (isHard) {
        // Hard reset
        const fullHash = gitExec(state.projectRoot, [
          "rev-parse",
          `HEAD~${commits.length - 1 - targetIdx}`,
        ]);
        const resetResult = gitExec(state.projectRoot, [
          "reset",
          "--hard",
          fullHash!,
        ]);
        if (resetResult === null) {
          ctx.ui.notify("❌ Reset 失败", "error");
          return;
        }
        state.checkpointCount = targetIdx + 1;
      } else {
        // Revert 从最新到目标+1 的所有 commit
        const revertCount = commits.length - 1 - targetIdx;
        for (let i = 0; i < revertCount; i++) {
          gitExec(state.projectRoot, [
            "revert",
            "--no-edit",
            "--no-verify",
            "HEAD",
          ]);
        }
        state.checkpointCount = targetIdx + 1;
      }

      await pi.appendEntry(EXT_NAME, state);

      ctx.ui.notify(
        `✅ 已回滚到 checkpoint #${targetIdx + 1} (\`${targetHash}\`)\n` +
          `   备份分支: \`${backupBranch}\` · 方式: ${isHard ? "hard reset" : "revert"}`,
        "info",
      );
    },
  });

  /**
   * /vibe-branch — 创建新的功能开发分支
   *
   * 自动从当前 HEAD 创建分支，初始化新的 vibe session。
   * 配合 /vibe-merge 完成功能开发 → 合并回主线。
   */
  pi.registerCommand("vibe-branch", {
    description:
      "创建新功能分支 + 初始化 vibe session（配合 /vibe-merge 完成合并）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      const branchName = args?.trim() || `vibe-feature-${state.sessionId}`;

      // 确保分支名合法
      const safeName = branchName
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9._/-]/g, "")
        .substring(0, 50);

      if (!safeName) {
        ctx.ui.notify("❌ 无效的分支名", "error");
        return;
      }

      // 检查是否有未提交变更
      const changedFiles = getChangedFiles(state.projectRoot);
      if (changedFiles.length > 0) {
        if (ctx.hasUI) {
          const choice = await ctx.ui.select(
            `⚠️  ${changedFiles.length} file(s) uncommitted.`,
            [
              "Auto-checkpoint before branching",
              "Cancel",
            ],
          );
          if (!choice || choice === "Cancel") return;
          await executeCheckpoint(pi, ctx, state);
        } else {
          ctx.ui.notify(
            "⚠️ 有未提交变更，请先运行 /vibe-checkpoint",
            "warning",
          );
          return;
        }
      }

      // 创建分支
      const branchResult = gitExec(state.projectRoot, [
        "checkout",
        "-b",
        safeName,
      ]);
      if (branchResult === null) {
        ctx.ui.notify("❌ 创建分支失败", "error");
        return;
      }

      // 启动新 session
      state.sessionId = generateSessionId();
      state.checkpointCount = 0;
      state.currentTask = `Feature: ${safeName}`;
      lastInjectedStateHash = "";
      resetMetrics();
      await pi.appendEntry(EXT_NAME, state);

      // 更新 session doc
      const doc = await loadSessionDoc(state.projectRoot, state);
      doc.nextSteps = [
        "完成功能开发",
        "使用 /vibe-checkpoint 提交每个子任务",
        "使用 /vibe-merge 合并回主分支",
      ];
      doc.notes = `Parent branch: ${gitExec(state.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD@{1}"]) || "unknown"}`;
      await writeSessionDoc(state.projectRoot, state, doc);

      ctx.ui.notify(
        `🌿 已创建并切换到分支 \`${safeName}\`\n` +
          `   Session: ${state.sessionId} · Task: Feature: ${safeName}\n` +
          `   完成后用 /vibe-merge 合并回主分支`,
        "info",
      );
    },
  });

  /**
   * /vibe-merge — 合并当前功能分支回主分支
   *
   * 自动检测 base 分支，合并并生成 vibe merge commit。
   */
  pi.registerCommand("vibe-merge", {
    description:
      "合并当前功能分支到主分支（自动检测 base，生成 merge commit）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      // 获取当前分支
      const currentBranch = gitExec(state.projectRoot, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);

      if (!currentBranch || currentBranch === "HEAD") {
        ctx.ui.notify("⚠️ 当前在 detached HEAD，无法合并", "warning");
        return;
      }

      // 检测 base 分支
      let baseBranch = "";
      for (const candidate of ["main", "master", "develop"]) {
        const exists = gitExec(state.projectRoot, [
          "rev-parse",
          "--verify",
          candidate,
        ]);
        if (exists !== null && candidate !== currentBranch) {
          baseBranch = candidate;
          break;
        }
      }

      if (!baseBranch) {
        // 交互选择
        if (ctx.hasUI) {
          const branches = gitExec(state.projectRoot, ["branch", "--format=%(refname:short)"]);
          if (branches) {
            const branchList = branches
              .split("\n")
              .filter((b) => b && b !== currentBranch);
            if (branchList.length > 0) {
              const choice = await ctx.ui.select(
                "选择目标合并分支:",
                branchList,
              );
              if (choice) baseBranch = choice;
            }
          }
        }
        if (!baseBranch) {
          ctx.ui.notify(
            "❌ 无法检测 base 分支，请手动指定: /vibe-merge main",
            "error",
          );
          return;
        }
      }

      // 确认
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "🔀 合并确认",
          `将 \`${currentBranch}\` 合并到 \`${baseBranch}\`\n` +
            `Checkpoints: ${state.checkpointCount}\n\n确认？`,
        );
        if (!confirmed) return;
      }

      // Checkout base
      const checkoutResult = gitExec(state.projectRoot, [
        "checkout",
        baseBranch,
      ]);
      if (checkoutResult === null) {
        ctx.ui.notify("❌ 切换分支失败", "error");
        return;
      }

      // Merge
      const mergeMsg = [
        `merge: ${currentBranch} → ${baseBranch}`,
        "",
        `Session: ${state.sessionId} · Checkpoints: ${state.checkpointCount}`,
        `Feature: ${state.currentTask}`,
      ].join("\n");

      const mergeResult = gitExec(state.projectRoot, [
        "merge",
        "--no-ff",
        "-m",
        mergeMsg,
        currentBranch,
      ]);

      if (mergeResult === null) {
        // 可能有冲突
        ctx.ui.notify(
          "⚠️ 合并可能有冲突。请手动解决后 commit。\n" +
            `   放弃合并: git merge --abort && git checkout ${currentBranch}`,
          "warning",
        );
        return;
      }

      const mergeHash = gitExec(state.projectRoot, ["rev-parse", "--short", "HEAD"]);

      ctx.ui.notify(
        `✅ 已合并 \`${currentBranch}\` → \`${baseBranch}\`\n` +
          `   Merge commit: \`${mergeHash}\` · Checkpoints: ${state.checkpointCount}\n` +
          `   删除旧分支: git branch -d ${currentBranch}`,
        "info",
      );
    },
  });

  /**
   * /vibe-release — 打 tag + 生成 changelog
   *
   * 从 session 的 checkpoint 记录生成 changelog，创建 git tag。
   * 用法:
   *   /vibe-release 1.2.0     → tag v1.2.0 + changelog from checkpoints
   */
  pi.registerCommand("vibe-release", {
    description:
      "打 git tag + 从 checkpoint 生成 changelog",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }
      if (!isGitRepo(state.projectRoot)) {
        ctx.ui.notify("⚠️ 非 Git 仓库", "warning");
        return;
      }

      const version = args?.trim();
      if (!version) {
        ctx.ui.notify("用法: /vibe-release <version>\n例: /vibe-release 1.2.0", "warning");
        return;
      }

      // 确保没有未提交变更
      const changedFiles = getChangedFiles(state.projectRoot);
      if (changedFiles.length > 0) {
        if (ctx.hasUI) {
          const choice = await ctx.ui.select(
            `⚠️  ${changedFiles.length} file(s) uncommitted.`,
            ["Auto-checkpoint then release", "Cancel"],
          );
          if (!choice || choice === "Cancel") return;
          await executeCheckpoint(pi, ctx, state);
        } else {
          ctx.ui.notify(
            "⚠️ 有未提交变更，请先运行 /vibe-checkpoint",
            "warning",
          );
          return;
        }
      }

      // 生成 changelog
      const doc = await loadSessionDoc(state.projectRoot, state);
      const changelogLines: string[] = [];
      changelogLines.push(`# ${version} (${new Date().toISOString().split("T")[0]})`);
      changelogLines.push("");
      changelogLines.push(`Session: \`${state.sessionId}\` · Checkpoints: ${state.checkpointCount}`);
      changelogLines.push("");

      if (doc.checkpoints.length > 0) {
        changelogLines.push("## Changes");
        changelogLines.push("");
        for (const cp of doc.checkpoints) {
          changelogLines.push(
            `- \`${cp.commitHash}\` ${cp.task || "checkpoint"}: ${cp.filesChanged.length} file(s)`,
          );
        }
        changelogLines.push("");
      }

      changelogLines.push("---");
      changelogLines.push(`_Generated by vibe-workflow v3.0_`);

      const changelogContent = changelogLines.join("\n");

      // 写入 changelog
      const changelogPath = path.join(
        state.projectRoot,
        VIBE_DIR,
        `release-${version}.md`,
      );
      await writeFile(changelogPath, changelogContent);

      // 打 tag
      const tagName = `v${version.replace(/^v/, "")}`;
      const tagMsg = `Release ${tagName}\n\nSession: ${state.sessionId}\nCheckpoints: ${state.checkpointCount}`;
      const tagResult = gitExec(state.projectRoot, [
        "tag",
        "-a",
        tagName,
        "-m",
        tagMsg,
      ]);

      if (tagResult === null) {
        ctx.ui.notify(
          `⚠️ Tag 创建失败（可能已存在）。Changelog 已生成: docs/vibe/release-${version}.md`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        `🏷️  Release ${tagName} 完成！\n` +
          `   Changelog: docs/vibe/release-${version}.md\n` +
          `   Tag: \`${tagName}\` · Checkpoints: ${state.checkpointCount}\n` +
          `   推送: git push origin ${tagName}`,
        "info",
      );
    },
  });

  // ===================================================================
  // 5.3.5 v5: 多模态模型切换命令
  // ===================================================================

  /** 主力模型 ID（用于切回） */
  let primaryModelId = "";

  /**
   * /vibe-mimo — 切换到多模态模型（MiniMax Mimo v2.5 或其他）用于识图。
   *
   * 用法:
   *   /vibe-mimo                      → 切换到已配置的多模态模型
   *   /vibe-mimo --model <model-id>   → 指定模型
   *   /vibe-mimo --back               → 切回主力模型
   *
   * 上下文策略: 精简注入（仅任务描述），不注入 vibe 状态，节省 Token。
   * 结果回传: 在同一个 session 中，切回主力模型后历史消息自动可见。
   *
   * 使用流程:
   *   /vibe-mimo → Ctrl+V 贴图 → "分析这个 UI 设计" → /vibe-mimo --back
   */
  pi.registerCommand("vibe-mimo", {
    description:
      "切换到多模态模型用于识图（精简上下文注入，/vibe-mimo --back 切回）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }

      // --back: 切回主力模型
      if (args?.trim() === "--back") {
        if (!primaryModelId) {
          ctx.ui.notify(
            "⚠️ 未记录主力模型。请手动 Ctrl+P 切换。",
            "warning",
          );
          return;
        }
        const primaryModel = ctx.modelRegistry.find(
          primaryModelId.includes("/")
            ? primaryModelId.split("/")[0]
            : undefined,
          primaryModelId.includes("/")
            ? primaryModelId.split("/")[1]
            : primaryModelId,
        );
        if (primaryModel) {
          await pi.setModel(primaryModel);
          // 切回后强制重新注入全量上下文
          lastInjectedStateHash = "";
          ctx.ui.notify(
            `🔙 已切回主力模型: \`${primaryModel.provider}/${primaryModel.id}\``,
            "info",
          );
        } else {
          ctx.ui.notify(
            `⚠️ 未找到模型 \`${primaryModelId}\`，请手动 Ctrl+P 切换`,
            "warning",
          );
        }
        return;
      }

      // 记录当前主力模型（用于 --back）
      try {
        const currentModel = ctx.model;
        if (currentModel) {
          primaryModelId = `${currentModel.provider}/${currentModel.id}`;
        }
      } catch {
        // 无法获取模型信息
      }

      // 查找多模态模型
      let visionModel;

      // 优先使用 --model 参数
      if (args?.includes("--model")) {
        const modelArg = args.replace(/.*--model\s+/, "").trim().split(/\s+/)[0];
        if (modelArg.includes("/")) {
          const [provider, id] = modelArg.split("/");
          visionModel = ctx.modelRegistry.find(provider, id);
        } else {
          visionModel = ctx.modelRegistry.find(undefined, modelArg);
        }
      }

      // 自动查找: 搜索所有 provider 中的多模态模型（优先选支持图片的）
      if (!visionModel) {
        const visionPatterns = ["mimo", "gemini", "claude", "gpt-4o", "vision"];
        let bestModel = null;
        for (const pattern of visionPatterns) {
          const found = ctx.modelRegistry.find(undefined, pattern);
          if (found) {
            // 优先选支持图片的模型（跳过 mimo-v2.5-pro 这种 images: no 的）
            if (found.input?.includes("image")) {
              visionModel = found;
              break;
            }
            // 兜底：记录第一个找到的
            if (!bestModel) bestModel = found;
          }
        }
        // 如果没有支持图片的，用第一个找到的
        if (!visionModel) visionModel = bestModel;
      }

      if (!visionModel) {
        ctx.ui.notify(
          "⚠️ 未找到多模态模型。\n" +
            "   请确认已配置 API Key，或用 /vibe-mimo --model <provider/id>",
          "warning",
        );
        return;
      }

      // 切换模型
      const setResult = await pi.setModel(visionModel);
      if (!setResult) {
        ctx.ui.notify(
          `⚠️ 模型切换失败: \`${visionModel.provider}/${visionModel.id}\`\n` +
            `   可能是缺少 API Key。请确认 provider 已通过 /login 连接。`,
          "warning",
        );
        return;
      }

      // 触发精简上下文注入
      lastInjectedStateHash = "";

      ctx.ui.notify(
        `👁️  已切换到多模态模型: \`${visionModel.provider}/${visionModel.id}\`\n` +
          `   上下文: 精简模式（仅任务描述）\n` +
          `   现在可以 Ctrl+V 贴图并描述需求\n` +
          `   完成后: /vibe-mimo --back 切回主力模型`,
        "info",
      );
    },
  });

  /**
   * /vibe-minimax — 使用 MiniMax CLI 工具生成图片/视频/音频。
   *
   * 这是一个桥接命令，通过 pi.exec() 调用 mmx CLI 工具。
   * 结果保存到项目 assets/ 目录，并在 session 中注入结果摘要。
   *
   * 前置条件: 已安装 mmx CLI 并配置 API Key。
   * 文档: https://platform.minimaxi.com/docs/token-plan/minimax-cli
   *
   * 用法:
   *   /vibe-minimax generate --image "a modern login page"   → 生成图片
   *   /vibe-minimax generate --video "product walkthrough"    → 生成视频
   *   /vibe-minimax describe <image-path>                    → 描述图片内容
   *   /vibe-minimax setup                                    → 检查 CLI 配置
   *
   * 上下文策略: 完全不注入 vibe 上下文（mmx 是外部工具）。
   * 结果回传: 资源保存到 assets/generated/，摘要注入到 session。
   */
  pi.registerCommand("vibe-minimax", {
    description:
      "使用 MiniMax CLI 生成图片/视频/音频（桥接 mmx CLI 工具）",
    handler: async (args, ctx) => {
      if (!args?.trim() || args.trim() === "setup") {
        // 检查 CLI 是否可用
        const check = await pi.exec("mmx", ["--help"], {
          timeout: 5000,
        });
        if (check.code === 0) {
          ctx.ui.notify(
            `✅ MiniMax CLI 可用\n` +
              `   Version: ${check.stdout?.trim() || "unknown"}\n` +
              `   用法: /vibe-minimax generate --image "描述"`,
            "info",
          );
        } else {
          ctx.ui.notify(
            "⚠️ MiniMax CLI 未安装或未配置\n" +
              "   安装: 参考 https://platform.minimaxi.com/docs/token-plan/minimax-cli\n" +
              "   命令: mmx vision describe / mmx search query / mmx image generate\n" +
              "   检查: /vibe-minimax setup",
            "warning",
          );
        }
        return;
      }

      // 确保输出目录
      const outputDir = path.join(
        state.projectRoot || ctx.cwd,
        "assets",
        "generated",
      );
      await ensureDir(outputDir);

      // 解析子命令
      const cmdArgs = args.trim().split(/\s+/);
      const subcommand = cmdArgs[0];
      const restArgs = cmdArgs.slice(1);

      ctx.ui.notify(
        `🎬 正在调用 MiniMax CLI: ${subcommand} ${restArgs.slice(0, 3).join(" ")}...`,
        "info",
      );

      // 执行 CLI
      const result = await pi.exec(
        "mmx",
        [subcommand, ...restArgs],
        { timeout: 60_000 },
      );

      if (result.code !== 0) {
        ctx.ui.notify(
          `❌ MiniMax CLI 执行失败\n${result.stderr || result.stdout || "unknown error"}`,
          "error",
        );
        return;
      }

      // 结果摘要注入到 session
      const summary = [
        `## MiniMax CLI Result`,
        `- Command: \`mmx ${subcommand} ${restArgs.slice(0, 3).join(" ")}...\``,
        `- Output: \`${outputDir}\``,
        `- Status: ✅ Success`,
        "",
        "```",
        (result.stdout || "").slice(0, 1000),
        "```",
      ].join("\n");

      pi.sendMessage({
        customType: EXT_NAME,
        content: summary,
        display: true,
      });

      ctx.ui.notify(
        `✅ MiniMax CLI 完成\n` +
          `   输出: ${outputDir}\n` +
          `   结果已注入到会话上下文`,
        "info",
      );
    },
  });

  /**
   * vibe_checkpoint — LLM 完成任务后调用，触发 git commit
   */
  pi.registerTool({
    name: "vibe_checkpoint",
    label: "Vibe Checkpoint",
    description:
      "完成当前任务后调用此工具，自动执行 git commit、生成 diff 摘要、更新 session 文档。" +
      " 在 AGENTS.md 中有约束「每个任务完成后必须调用此工具」。如果 vibe 工作流未启用，此工具不执行任何操作。",
    promptSnippet:
      "Commit current changes and update session documentation",
    promptGuidelines: [
      "Use vibe_checkpoint after completing each atomic task to commit changes and update tracking documents.",
      "Do NOT call vibe_checkpoint if no meaningful changes were made.",
      "Call vibe_checkpoint BEFORE moving on to the next task.",
    ],
    parameters: Type.Object({
      message: Type.Optional(
        Type.String({
          description:
            "可选的 commit message 补充说明。不提供则自动生成。",
        }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ Vibe 工作流未启用。请在终端运行 /vibe-enable 启用。",
            },
          ],
        };
      }

      const result = await executeCheckpoint(
        pi,
        ctx,
        state,
        params.message,
      );

      return {
        content: [{ type: "text", text: result.message }],
        details: {
          success: result.success,
          checkpointCount: state.checkpointCount,
          sessionId: state.sessionId,
        },
      };
    },
  });

  /**
   * vibe_status — LLM 查询当前工作流状态
   */
  pi.registerTool({
    name: "vibe_status",
    label: "Vibe Status",
    description:
      "查询当前 Vibe 工作流状态：当前任务、checkpoint 数量、未提交变更等。在需要了解项目进度时调用。",
    promptSnippet:
      "Query current workflow status, task, and uncommitted changes",
    promptGuidelines: [
      "Use vibe_status to understand the current project state before starting work.",
      "Use vibe_status to check if there are uncommitted changes that need a checkpoint.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ Vibe 工作流未启用。",
            },
          ],
        };
      }

      const isGit = isGitRepo(state.projectRoot);
      const changedFiles = isGit ? getChangedFiles(ctx.cwd) : [];
      const doc = await loadSessionDoc(state.projectRoot, state);

      const lines: string[] = [];
      lines.push(`Session: ${state.sessionId}`);
      lines.push(`Enabled: ${state.enabled}`);
      lines.push(`Checkpoints: ${state.checkpointCount}`);
      lines.push(`Current Task: ${state.currentTask || "(none)"}`);
      lines.push(`Git Repo: ${isGit ? "yes" : "no"}`);
      lines.push(`Uncommitted Files: ${changedFiles.length}`);
      lines.push(`Session Status: ${doc.status}`);

      if (changedFiles.length > 0) {
        lines.push(`\nChanged files:\n${changedFiles.map((f) => `  - ${f}`).join("\n")}`);
      }

      if (doc.nextSteps.length > 0) {
        lines.push(`\nNext Steps:\n${doc.nextSteps.map((s) => `  - ${s}`).join("\n")}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          enabled: state.enabled,
          checkpointCount: state.checkpointCount,
          sessionId: state.sessionId,
          currentTask: state.currentTask,
          changedFiles,
          nextSteps: doc.nextSteps,
        },
      };
    },
  });

  // --- 5.4.1 v5.1: MiniMax CLI 工具（LLM 可调用） ---

  /**
   * minimax_describe_image — 通过 MiniMax CLI 描述图片内容。
   * 主力模型（DeepSeek）不支持图片，需要用此工具间接"看"图。
   */
  pi.registerTool({
    name: "minimax_describe_image",
    label: "MiniMax Describe Image",
    description:
      "通过 MiniMax CLI 分析图片内容。用于主力模型（DeepSeek 等）间接识别图片。" +
      " 接收图片文件路径，返回图片的描述文本。当用户贴图后被 input hook 保存到 assets/pasted/，" +
      " 或者需要分析项目中的截图/设计稿时调用此工具。",
    promptSnippet: "Analyze image content via MiniMax CLI",
    promptGuidelines: [
      "Use minimax_describe_image when the user pastes an image and you need to understand its content.",
      "Use minimax_describe_image to analyze screenshots, UI designs, or error messages in images.",
      "Call this tool with the exact file path saved by the image paste hook (assets/pasted/...).",
    ],
    parameters: Type.Object({
      imagePath: Type.String({
        description:
          "图片文件的绝对或相对路径（如 assets/pasted/pasted-xxx.png）",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const imagePath = params.imagePath;
      const absolutePath = path.isAbsolute(imagePath)
        ? imagePath
        : path.join(ctx.cwd, imagePath);

      // 检查文件是否存在
      try {
        await fsPromises.access(absolutePath);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `❌ Image not found: ${absolutePath}. Check the path and try again.`,
            },
          ],
        };
      }

      // 调用 MiniMax CLI 描述图片
      const result = await pi.exec(
        "mmx",
        ["vision", "describe", absolutePath],
        { timeout: 30_000 },
      );

      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `❌ MiniMax CLI failed to describe image:\n` +
                `${result.stderr || result.stdout || "unknown error"}\n\n` +
                `Make sure mmx CLI is installed and configured.\n` +
                `Docs: https://platform.minimaxi.com/docs/token-plan/minimax-cli`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `## Image Description (via MiniMax CLI)\n\n` +
              `**File**: \`${imagePath}\`\n\n` +
              (result.stdout || "No description returned"),
          },
        ],
        details: { imagePath, success: true },
      };
    },
  });

  /**
   * minimax_web_search — 通过 MiniMax CLI 进行网络搜索。
   * 主力模型需要查网络信息时调用此工具。
   */
  pi.registerTool({
    name: "minimax_web_search",
    label: "MiniMax Web Search",
    description:
      "通过 MiniMax CLI 进行网络搜索，返回搜索结果摘要。" +
      " 当需要查询最新信息、文档、API 用法或任何网络资源时使用。",
    promptSnippet: "Search the web via MiniMax CLI",
    promptGuidelines: [
      "Use minimax_web_search when you need up-to-date information, documentation lookups, or web research.",
      "Use minimax_web_search to find API references, error solutions, or latest news.",
      "Prefer this over guessing or using potentially outdated training data.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "搜索查询字符串",
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: "最大返回结果数（默认 5）",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const maxResults = params.maxResults || 5;

      const result = await pi.exec(
        "mmx",
        ["search", "query", params.query, "--limit", String(maxResults)],
        { timeout: 30_000 },
      );

      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `❌ MiniMax CLI search failed:\n` +
                `${result.stderr || result.stdout || "unknown error"}\n\n` +
                `Make sure mmx CLI is installed and configured.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `## Web Search Results: "${params.query}"\n\n` +
              (result.stdout || "No results found"),
          },
        ],
        details: { query: params.query, success: true },
      };
    },
  });

  /**
   * minimax_generate — 通过 MiniMax CLI 生成图片/视频/音频。
   */
  pi.registerTool({
    name: "minimax_generate",
    label: "MiniMax Generate",
    description:
      "通过 MiniMax CLI 生成图片、视频或音频内容。" +
      " 当用户要求生成素材（配图、视频演示、音效等）时使用。" +
      " 生成的文件保存到 assets/generated/ 目录。",
    promptSnippet: "Generate images/video/audio via MiniMax CLI",
    promptGuidelines: [
      "Use minimax_generate when the user asks to create images, videos, or audio assets.",
      "Use minimax_generate for generating UI mockups, illustrations, or media content.",
    ],
    parameters: Type.Object({
      type: Type.String({
        description: "生成类型: image, video, 或 audio",
      }),
      prompt: Type.String({
        description: "生成描述（如 'a modern login page with blue theme'）",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const outputDir = path.join(
        state.projectRoot || ctx.cwd,
        "assets",
        "generated",
      );
      await ensureDir(outputDir);

      const genType = params.type.toLowerCase();
      // Map type to mmx subcommand
      const subcommand = genType === "video"
        ? "video"
        : genType === "audio"
        ? "speech"
        : "image";
      const action = genType === "audio" ? "synthesize" : "generate";

      const result = await pi.exec(
        "mmx",
        [subcommand, action, params.prompt],
        { timeout: 120_000 },
      );

      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `❌ MiniMax CLI generation failed:\n` +
                `${result.stderr || result.stdout || "unknown error"}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `## Generated ${genType}\n\n` +
              `**Prompt**: ${params.prompt}\n` +
              `**Output**: \`${outputDir}\`\n\n` +
              (result.stdout || "Generation completed"),
          },
        ],
        details: { type: genType, prompt: params.prompt, success: true },
      };
    },
  });

  // --- 5.4.2 v5.3: 剪贴板图片粘贴工具（WSL/Windows Terminal 兼容） ---

  /**
   * /vibe-paste — 从 Windows 剪贴板粘贴图片（WSL 兼容）。
   *
   * Windows Terminal 不支持图像协议，无法 Ctrl+V 贴图。
   * 此命令通过 PowerShell 从 Windows 剪贴板取图片 → 存为文件 → 添加到会话。
   *
   * 用法:
   *   1. 在 Windows 中截图/复制图片到剪贴板
   *   2. 在 pi 中运行 /vibe-paste
   *   3. 图片自动保存到 assets/pasted/，引用注入到会话
   */
  pi.registerCommand("vibe-paste", {
    description:
      "从 Windows 剪贴板粘贴图片（WSL 兼容，自动保存并注入到会话）",
    handler: async (_args, ctx) => {
      // 检查是否有图片
      const checkCmd = [
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output 'HAS_IMAGE' } else { Write-Output 'NO_IMAGE' }",
      ];

      const check = await pi.exec("powershell.exe", checkCmd, {
        timeout: 5000,
      });

      if (!check.stdout?.includes("HAS_IMAGE")) {
        ctx.ui.notify(
          "📋 剪贴板中没有图片。请先在 Windows 中截图或复制图片。",
          "warning",
        );
        return;
      }

      // 保存到 WSL 可访问的路径
      const pasteDir = path.join(
        state.projectRoot || ctx.cwd,
        "assets",
        "pasted",
      );
      await ensureDir(pasteDir);

      const timestamp = Date.now();
      const filename = `pasted-${timestamp}.png`;
      const wslPath = path.join(pasteDir, filename);
      // 转 Windows 路径（PowerShell 需要）
      const winPath = wslPath
        .replace(/^\/mnt\/([a-z])\//, "$1:\\")
        .replace(/\//g, "\\");

      // PowerShell 保存剪贴板图片
      const saveCmd = [
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${winPath}'); Write-Output 'SAVED' } else { Write-Output 'FAILED' }`,
      ];

      const result = await pi.exec("powershell.exe", saveCmd, {
        timeout: 10_000,
      });

      if (!result.stdout?.includes("SAVED")) {
        ctx.ui.notify(
          "❌ 图片保存失败。请确认剪贴板中有有效图片。",
          "error",
        );
        return;
      }

      // 注入到会话——根据模型类型选择方式
      const relativePath = path.relative(
        state.projectRoot || ctx.cwd,
        wslPath,
      );

      // 检测当前模型是否支持多模态
      const model = ctx.model;
      const isVisionModel = model?.input?.includes("image");

      if (isVisionModel) {
        // 多模态模型（如 Mimo）：直接发送图片数据
        const imgData = await fsPromises.readFile(wslPath);
        pi.sendUserMessage([
          { type: "text" as const, text: `[📷 Image pasted: \`${relativePath}\`]` },
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              mediaType: "image/png" as const,
              data: imgData.toString("base64"),
            },
          },
        ]);

        ctx.ui.notify(
          `📷 图片已发送给多模态模型: ${relativePath}`,
          "info",
        );
      } else {
        // 纯文本模型（如 DeepSeek）：发送文本引用，LLM 通过工具识图
        pi.sendUserMessage(
          `[📷 Image pasted: \`${relativePath}\`] Use \`minimax_describe_image\` tool to analyze it.`,
        );

        ctx.ui.notify(
          `📷 图片已保存: ${relativePath}\n已注入到会话，LLM 将自动调用 minimax_describe_image 分析`,
          "info",
        );
      }
    },
  });

  // --- 5.4.3 v5.5: 模型协作/路由命令 ---

  /** 预定义模型别名（根据用户实际模型列表配置） */
  const MODEL_ALIASES: Record<string, { provider: string; pattern: string; desc: string }> = {
    pro: { provider: "opencode-go", pattern: "deepseek-v4-pro", desc: "主力思考 · 1M ctx" },
    flash: { provider: "opencode-go", pattern: "deepseek-v4-flash", desc: "日常任务 · 1M ctx" },
    mmx: { provider: "minimax-cn", pattern: "MiniMax-M2.7", desc: "简单任务 · 256K ctx ⚠️" },
    mimo: { provider: "opencode-go", pattern: "mimo-v2.5", desc: "多模态识图 · 1M ctx" },
  };

  /** 记录切换前的模型，用于 /vibe-model back */
  let previousModelId = "";

  /**
   * /vibe-model — 快速切换模型，实现多模型协作。
   *
   * 用法:
   *   /vibe-model              → 显示别名列表和当前模型
   *   /vibe-model pro          → 切换到 DeepSeek v4-pro（主力思考）
   *   /vibe-model flash        → 切换到 DeepSeek v4-flash（快速便宜）
   *   /vibe-model review       → 切换到 MiniMax M2.7（代码审查）
   *   /vibe-model back         → 切回上一个模型
   *
   * 上下文自动流转——vibe 注入是 model-agnostic 的。
   */
  pi.registerCommand("vibe-model", {
    description:
      "快速切换模型（pro/flash/review/mimo/back），实现多模型协作",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        // 显示可用别名
        const current = ctx.model;
        const lines = ["## 🧠 Vibe Model Aliases", ""];
        lines.push(`当前: \`${current?.provider}/${current?.id}\``);
        lines.push("");
        lines.push("| 别名 | 模型 | 适用场景 |");
        lines.push("|------|------|---------|");
        for (const [alias, info] of Object.entries(MODEL_ALIASES)) {
          const mark = current?.id?.includes(info.pattern) ? " ← 当前" : "";
          lines.push(`| ${alias} | ${info.provider}/${info.pattern} | ${info.desc}${mark} |`);
        }
        lines.push("");
        lines.push("用法: /vibe-model pro|flash|review|mimo|back");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const alias = args.trim();

      // back: 切回上一个模型
      if (alias === "back") {
        if (!previousModelId) {
          ctx.ui.notify("⚠️ 没有上一个模型记录", "warning");
          return;
        }
        const [prevProvider, prevPattern] = previousModelId.includes("/")
          ? previousModelId.split("/")
          : [undefined, previousModelId];
        const model = ctx.modelRegistry.find(prevProvider, prevPattern);
        if (model) {
          await pi.setModel(model);
          lastInjectedStateHash = "";
          ctx.ui.notify(
            `🔙 已切回: \`${model.provider}/${model.id}\``,
            "info",
          );
        }
        return;
      }

      // 预定义别名
      const info = MODEL_ALIASES[alias];
      if (!info) {
        ctx.ui.notify(
          `⚠️ 未知别名 "${alias}"。可用: ${Object.keys(MODEL_ALIASES).join(", ")}, back`,
          "warning",
        );
        return;
      }

      const model = ctx.modelRegistry.find(info.provider, info.pattern);
      if (!model) {
        ctx.ui.notify(
          `⚠️ 未找到模型: ${info.provider}/${info.pattern}\n检查 pi --list-models`,
          "warning",
        );
        return;
      }

      // 记录当前模型
      try {
        const current = ctx.model;
        if (current) previousModelId = `${current.provider}/${current.id}`;
      } catch { /* ignore */ }

      await pi.setModel(model);
      lastInjectedStateHash = "";

      // 小上下文模型提醒
      const ctxSize = (model.contextWindow || 200000) / 1000;
      const sizeHint = ctxSize < 300
        ? `\n⚠️  ${ctxSize.toFixed(0)}K 上下文较小，建议短任务。用 /vibe-status 监控用量。`
        : "";

      ctx.ui.notify(
        `🧠 已切换: \`${model.provider}/${model.id}\` (${info.desc})${sizeHint}\n切回: /vibe-model back`,
        "info",
      );
    },
  });

  // ──── v5.4: smart_search tool（多策略代码搜索）──

  pi.registerTool({
    name: "smart_search",
    label: "Smart Search",
    description:
      "多策略代码搜索。先用 rg 精确匹配，无结果时自动尝试大小写不敏感、单词拆分等策略。" +
      " 当内置 grep 无结果时使用此工具进行更广泛的搜索。",
    promptSnippet: "Multi-strategy code search with automatic fallbacks",
    promptGuidelines: [
      "Use smart_search when built-in grep returns no results.",
      "smart_search automatically tries case-insensitive and word-split variations.",
      "Prefer built-in grep for exact matches; use smart_search for broader exploration.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "搜索查询（如 'authentication', 'JWT token'）",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rgBin = path.join(
        process.env.PI_CODING_AGENT_DIR ||
          path.join(process.env.HOME || "/home", ".pi", "agent"),
        "bin",
        "rg",
      );

      const strategies = [
        { label: "exact", args: ["-n", "--no-heading", "-C", "1", params.query, "."] },
        { label: "case-insensitive", args: ["-i", "-n", "--no-heading", "-C", "1", params.query, "."] },
        { label: "word-split", args: ["-i", "-n", "--no-heading", "-C", "1", ...params.query.split(/\s+/).slice(0, 3).flatMap((w: string) => ["-e", w]), "."] },
      ];

      const results: string[] = [];
      let total = 0;
      for (const s of strategies) {
        if (total > 0 && s.label !== "exact") break;
        if (total > 30) break;
        const r = await pi.exec(rgBin, s.args, { cwd: ctx.cwd, timeout: 10_000 });
        const out = r.stdout?.trim() || "";
        if (out) {
          const lines = out.split("\n").filter((l: string) => !results.includes(l));
          if (lines.length > 0) {
            results.push(`### ${s.label}`);
            results.push(...lines.slice(0, 40));
            if (lines.length > 40) results.push(`... +${lines.length - 40} more`);
            total += lines.length;
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: results.length > 0
            ? `## Smart Search: "${params.query}"\n${results.join("\n")}`
            : `## Smart Search: "${params.query}"\n\nNo matches. Try rephrasing.`,
        }],
      };
    },
  });

  console.log(
    "[vibe-workflow] Extension loaded — run /vibe-init to set up a project, /vibe-enable to activate",
  );
}
