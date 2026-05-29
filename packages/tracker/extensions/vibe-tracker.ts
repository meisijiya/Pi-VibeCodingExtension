/**
 * =============================================================================
 * Vibe Tracker Extension — Bug/Optimization 追踪系统
 * =============================================================================
 *
 * 从 vibe-workflow.ts 提取的 bug/优化追踪功能，包括：
 *   1. BugMarker 类型定义
 *   2. Bug 追踪函数（readBugIndex, getBugsForFile, readBugDetail, writeBugMarker, autoSplitIfNeeded）
 *   3. Bug 命令：vibe-bug, vibe-bug-fix, vibe-bugs, vibe-redo
 *   4. Bug 工具：vibe_bug, vibe_bug_fix, vibe_bug_info, vibe_optimize
 *
 * 安装：
 *   pi install <package-name>
 *
 * @author pi + ljh2923
 * @version 1.0.0
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
import { execSync, execFileSync } from "node:child_process";

/** 工作流持久化状态（通过 pi.appendEntry 持久化，不参与 LLM 上下文） */
interface VibeState {
  /** 是否已启用 */
  enabled: boolean;
  /** 当前任务名称（可以是 task 名或 step 名） */
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

/** Bug 标记 */
interface BugMarker {
  id: string;
  timestamp: string;
  file: string;
  commitHash: string;
  lineRange?: string;
  description: string;
  type: "bug" | "optimize" | "refactor";
  status: "open" | "fixed" | "applied";
  fixCommit?: string;
  fixDescription?: string;
}

/** Plan 中的单个 step */
interface PlanStep {
  text: string;
  done: boolean;
  model?: string;
}

/** Plan 中的 task（包含多个 step） */
interface PlanTask {
  name: string;
  steps: PlanStep[];
}

/** Plan 解析结果 */
interface PlanData {
  file: string;
  tasks: PlanTask[];
  allSteps: PlanStep[];
}

// =============================================================================
// 2. 常量与配置
// =============================================================================

/** vibe 工作流目录（相对于项目根） */
const VIBE_DIR = "docs/vibe";
const BUGS_DIR = `${VIBE_DIR}/bugs`;

/** 文档分片阈值（超过此行数自动分片） */
const MAX_LINES_PER_FILE = 100;

/** 扩展名（用于 pi.getEntry 等） */
const EXT_NAME = "vibe-tracker";

// =============================================================================
// 3. 工具函数
// =============================================================================

/**
 * 同步执行 git 命令，返回 stdout。失败返回 null。
 * 使用 execFileSync 而非 execSync，因为 execSync 不接受参数数组。
 * 对比：execSync("git", args, opts) 会将 args 当作 options，导致 git 无子命令运行失败。
 */
function gitExec(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
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
 * 获取当前时间的 ISO 字符串
 */
function getTimestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
}

// =============================================================================
// 4. Bug 追踪函数
// =============================================================================

/**
 * 读取所有变更标记（从 INDEX.md 解析）
 */
async function readBugIndex(projectRoot: string): Promise<BugMarker[]> {
  const indexPath = path.join(projectRoot, BUGS_DIR, "INDEX.md");
  const content = await readFileSafe(indexPath);
  if (!content) return [];

  const bugs: BugMarker[] = [];
  const entries = content.split(/^## /m).filter(Boolean);
  for (const entry of entries) {
    // 匹配 🐛 bug-001, ⚡ opt-001, 🔧 ref-001 等格式
    const idMatch = entry.match(/(?:🐛|⚡|🔧)\s+(bug|opt|ref)-(\d+)/);
    if (!idMatch) continue;
    const type = idMatch[1] === "bug" ? "bug" : idMatch[1] === "opt" ? "optimize" : "refactor";
    const id = `${idMatch[1]}-${idMatch[2].padStart(3, "0")}`;
    const file = entry.match(/\*\*File\*\*:\s*`([^`]+)`/)?.[1] || "";
    const status = entry.match(/\*\*Status\*\*:\s*(\w+)/)?.[1] as BugMarker["status"] || "open";
    const commitHash = entry.match(/\*\*Commit\*\*:\s*`([^`]+)`/)?.[1] || "";
    const description = entry.match(/\*\*Description\*\*:\s*(.+)/)?.[1]?.trim() || "";
    bugs.push({ id, timestamp: "", file, commitHash, description, type, status });
  }
  return bugs;
}

/**
 * 获取指定文件的 bug 列表
 */
async function getBugsForFile(projectRoot: string, file: string): Promise<BugMarker[]> {
  const bugs = await readBugIndex(projectRoot);
  return bugs.filter((b) => b.file === file || file.endsWith(b.file) || b.file.endsWith(file));
}

/**
 * 读取单个 bug 详情
 */
async function readBugDetail(projectRoot: string, bugId: string): Promise<string | null> {
  const bugPath = path.join(projectRoot, BUGS_DIR, `${bugId}.md`);
  return readFileSafe(bugPath);
}

/**
 * 写入变更标记到 INDEX.md 和独立文件
 */
async function writeBugMarker(
  projectRoot: string,
  bug: BugMarker,
  detailContent: string,
): Promise<void> {
  await ensureDir(path.join(projectRoot, BUGS_DIR));

  // 写入独立文件
  const bugPath = path.join(projectRoot, BUGS_DIR, `${bug.id}.md`);
  await writeFile(bugPath, detailContent);

  // 更新 INDEX.md
  const typeIcon = bug.type === "bug" ? "🐛" : bug.type === "optimize" ? "⚡" : "🔧";
  const indexPath = path.join(projectRoot, BUGS_DIR, "INDEX.md");
  const existing = await readFileSafe(indexPath) || "# Bug Index\n";
  const entry = [
    `## ${typeIcon} ${bug.id}`,
    "",
    `- **File**: \`${bug.file}\``,
    `- **Type**: ${bug.type}`,
    `- **Status**: ${bug.status}`,
    `- **Commit**: \`${bug.commitHash}\``,
    `- **Description**: ${bug.description}`,
    "",
  ].join("\n");
  await writeFile(indexPath, existing.replace(/\n$/, "") + "\n\n" + entry);

  // 自动分片检查
  await autoSplitIfNeeded(indexPath);
}

/**
 * 检查文件是否超过行数限制，超过则自动分片
 * 返回：如果分片了，返回新文件路径；否则返回原路径
 */
async function autoSplitIfNeeded(
  filePath: string,
  maxLines: number = MAX_LINES_PER_FILE,
): Promise<string> {
  const content = await readFileSafe(filePath);
  if (!content) return filePath;

  const lines = content.split("\n");
  if (lines.length <= maxLines) return filePath;

  // 需要分片：找到下一个序号
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  let seq = 1;
  let newPath: string;
  do {
    newPath = path.join(dir, `${base}-${String(seq).padStart(3, "0")}${ext}`);
    seq++;
  } while (fs.existsSync(newPath));

  // 将当前内容移到新文件
  await writeFile(newPath, content);

  // 原文件只保留索引头
  const header = [
    `# ${base} — Part ${seq - 1}`,
    "",
    `> 内容已分片到 ${path.basename(newPath)}`,
    `> 历史文件: ${base}-001${ext}, ${base}-002${ext}, ...`,
    "",
  ].join("\n");
  await writeFile(filePath, header);

  return newPath;
}

// =============================================================================
// 5. Plan 相关函数（vibe-redo 需要）
// =============================================================================

/**
 * 解析 plan step 中的模型提示，如 `step text @deepseek`
 * 返回：{ text, model? }
 */
function parseModelHint(text: string): { text: string; model?: string } {
  const match = text.match(/^(.+?)\s+@(\S+)$/);
  if (match) {
    return { text: match[1].trim(), model: match[2] };
  }
  return { text: text.trim() };
}

/**
 * 反向更新 plan checkbox：将匹配的 `- [x]` 改回 `- [ ]`
 */
async function updatePlanCheckboxReverse(
  projectRoot: string,
  taskName: string,
): Promise<boolean> {
  if (!taskName) return false;

  function normalize(text: string): string {
    return text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function extractStepId(text: string): string | null {
    const m = text.match(/^(?:step\s*)?(\d+)/i);
    return m ? `step ${m[1]}` : null;
  }

  const normalizedTask = normalize(taskName);
  const taskStepId = extractStepId(normalizedTask);
  const plansDir = path.join(projectRoot, "docs", "superpowers", "plans");

  try {
    const files = await fsPromises.readdir(plansDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();

    for (const file of mdFiles) {
      const filePath = path.join(plansDir, file);
      const content = await readFileSafe(filePath);
      if (!content) continue;

      const lines = content.split("\n");
      let updated = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const checked = line.match(/^(\s*-\s*\[[xX]\]\s+)(.+)/);
        if (!checked) continue;

        const prefix = checked[1];
        const planText = checked[2];
        const normalizedPlan = normalize(planText);
        const planStepId = extractStepId(normalizedPlan);

        if (taskStepId && planStepId && taskStepId === planStepId) {
          lines[i] = `${prefix.replace("[x]", "[ ]")} ${planText}`;
          updated = true;
          break;
        }
        if (normalizedPlan.includes(normalizedTask) || normalizedTask.includes(normalizedPlan)) {
          lines[i] = `${prefix.replace("[x]", "[ ]")} ${planText}`;
          updated = true;
          break;
        }
      }

      if (updated) {
        await writeFile(filePath, lines.join("\n"));
        return true;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[vibe-tracker] updatePlanCheckboxReverse failed:", err);
    }
  }
  return false;
}

/**
 * 读取最新 plan 文件，解析 TODO 列表（按 task 分组）
 */
async function readPlanTodos(projectRoot: string): Promise<PlanData | null> {
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

      const tasks: PlanTask[] = [];
      const allSteps: PlanStep[] = [];
      let currentTask: PlanTask | null = null;

      for (const line of content.split("\n")) {
        // 匹配 task 标题: ### Task N: xxx
        const taskHeader = line.match(/^###\s+(Task\s+\d+.*)/i);
        if (taskHeader) {
          currentTask = { name: taskHeader[1].trim(), steps: [] };
          tasks.push(currentTask);
          continue;
        }

        // 匹配 checkbox
        const unchecked = line.match(/^\s*-\s*\[\s*\]\s+(.+)/);
        const checked = line.match(/^\s*-\s*\[[xX]\]\s+(.+)/);
        if (unchecked || checked) {
          const raw = (unchecked || checked)![1];
          const { text, model } = parseModelHint(raw);
          const step: PlanStep = { text, done: !!checked, model };
          allSteps.push(step);
          if (currentTask) {
            currentTask.steps.push(step);
          } else {
            // checkbox 出现在任何 task 之前 → 创建匿名 task
            tasks.push({ name: "(unnamed)", steps: [step] });
          }
        }
      }

      if (allSteps.length > 0) return { file, tasks, allSteps };
    }
  } catch {
    // 目录不存在
  }
  return null;
}

// =============================================================================
// 6. 扩展注册
// =============================================================================

/**
 * 注册 vibe-tracker 扩展
 */
export default function (pi: ExtensionAPI) {
  // 从 vibe-core 获取共享状态
  const state: VibeState = (() => {
    try {
      return pi.getEntry("vibe-core") as VibeState;
    } catch {
      return {
        enabled: false,
        currentTask: "",
        checkpointCount: 0,
        sessionId: "",
        projectRoot: pi.cwd,
        autoSuggestCheckpoint: false,
      };
    }
  })();

  // =========================================================================
  // 6.1 Bug 命令
  // =========================================================================

  /**
   * /vibe-bug <file> [lines] [description] — 标记发现 bug
   */
  pi.registerCommand("vibe-bug", {
    description: "标记发现 bug（记录文件、位置、提交）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }

      const parts = args?.trim().split(/\s+/) || [];
      if (parts.length < 1) {
        ctx.ui.notify("用法: /vibe-bug <file> [lines] [description]", "warning");
        return;
      }

      const file = parts[0];
      const lineMatch = parts[1]?.match(/^(\d+)(?:-(\d+))?$/);
      const lineRange = lineMatch ? parts[1] : undefined;
      const descStart = lineMatch ? 2 : 1;
      const description = parts.slice(descStart).join(" ") || "未描述";

      // 获取最近修改该文件的 commit
      const lastCommit = gitExec(state.projectRoot, [
        "log", "-1", "--format=%h", "--", file,
      ]) || "unknown";

      const bugNum = (await readBugIndex(state.projectRoot)).length + 1;
      const bugId = `bug-${String(bugNum).padStart(3, "0")}`;

      const bug: BugMarker = {
        id: bugId,
        timestamp: getTimestamp(),
        file,
        commitHash: lastCommit,
        lineRange,
        description,
        type: "bug",
        status: "open",
      };

      const detail = [
        `# ${bugId}: ${description}`,
        "",
        `- **Status**: open`,
        `- **File**: \`${file}\``,
        lineRange ? `- **Lines**: ${lineRange}` : "",
        `- **Introduced in**: \`${lastCommit}\``,
        `- **Timestamp**: ${bug.timestamp}`,
        "",
        `## Description`,
        "",
        description,
        "",
      ].filter(Boolean).join("\n");

      await writeBugMarker(state.projectRoot, bug, detail);

      ctx.ui.notify(
        `🐛 Bug 标记: ${bugId}\n` +
          `   文件: ${file}${lineRange ? `:${lineRange}` : ""}\n` +
          `   引入提交: ${lastCommit}\n` +
          `   描述: ${description}`,
        "info",
      );
    },
  });

  /**
   * /vibe-bug-fix <id> [description] — 标记 bug 已修复
   */
  pi.registerCommand("vibe-bug-fix", {
    description: "标记 bug 已修复（记录修复提交和描述）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }

      const parts = args?.trim().split(/\s+/) || [];
      const bugId = parts[0];
      const fixDesc = parts.slice(1).join(" ") || "已修复";

      if (!bugId) {
        ctx.ui.notify("用法: /vibe-bug-fix <bug-id> [description]", "warning");
        return;
      }

      const normalizedId = bugId.startsWith("bug-") ? bugId : `bug-${bugId.padStart(3, "0")}`;
      const detail = await readBugDetail(state.projectRoot, normalizedId);
      if (!detail) {
        ctx.ui.notify(`❌ 未找到 ${normalizedId}`, "error");
        return;
      }

      const fixCommit = gitExec(state.projectRoot, [
        "rev-parse", "--short", "HEAD",
      ]) || "unknown";

      const updatedDetail = detail
        .replace(/\*\*Status\*\*:\s*open/, `**Status**: fixed`)
        + `\n\n## Fix\n\n- **Commit**: \`${fixCommit}\`\n- **Description**: ${fixDesc}\n`;

      const bugPath = path.join(state.projectRoot, BUGS_DIR, `${normalizedId}.md`);
      await writeFile(bugPath, updatedDetail);

      // 更新 INDEX.md
      const indexPath = path.join(state.projectRoot, BUGS_DIR, "INDEX.md");
      const indexContent = await readFileSafe(indexPath) || "";
      const updatedIndex = indexContent.replace(
        new RegExp(`(## ${normalizedId.replace("bug-", "Bug ")}[\\s\\S]*?\\*\\*Status\\*\\*:\\s*)open`),
        `$1fixed`,
      );
      await writeFile(indexPath, updatedIndex);

      ctx.ui.notify(
        `✅ ${normalizedId} 已标记为 fixed\n` +
          `   修复提交: ${fixCommit}\n` +
          `   描述: ${fixDesc}`,
        "info",
      );
    },
  });

  /**
   * /vibe-bugs — 列出所有 bug 标记
   */
  pi.registerCommand("vibe-bugs", {
    description: "列出所有 bug 标记",
    handler: async (_args, ctx) => {
      const bugs = await readBugIndex(state.projectRoot);
      if (bugs.length === 0) {
        ctx.ui.notify("📝 暂无 bug 标记", "info");
        return;
      }

      const lines = ["## 🐛 Bug 标记列表", ""];
      for (const bug of bugs) {
        const icon = bug.status === "open" ? "🔴" : "✅";
        lines.push(`${icon} **${bug.id}** — \`${bug.file}\` — ${bug.description}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /**
   * /vibe-redo <step> — 标记 step 为未完成（反向更新 checkbox）
   */
  pi.registerCommand("vibe-redo", {
    description: "标记 plan step 为未完成（反向更新 checkbox）",
    handler: async (args, ctx) => {
      if (!state.enabled) {
        ctx.ui.notify("⚠️ Vibe 工作流未启用", "warning");
        return;
      }

      const stepName = args?.trim();
      if (!stepName) {
        ctx.ui.notify("用法: /vibe-redo <step名或编号>", "warning");
        return;
      }

      const result = await updatePlanCheckboxReverse(state.projectRoot, stepName);
      if (result) {
        ctx.ui.notify(
          `🔄 已标记为未完成: ${stepName}\n` +
            `   面板已更新，待完成数 +1`,
          "info",
        );
      } else {
        ctx.ui.notify(`❌ 未找到匹配的 step: ${stepName}`, "error");
      }
    },
  });

  // =========================================================================
  // 6.2 Bug 工具（LLM 可调用）
  // =========================================================================

  /**
   * vibe_bug — LLM 标记发现 bug
   */
  pi.registerTool({
    name: "vibe_bug",
    label: "Vibe Bug",
    description:
      "标记发现 bug。记录问题文件、位置、引入提交。用于开发过程中发现问题时调用。",
    promptSnippet: "Mark a bug found during development",
    promptGuidelines: [
      "Use vibe_bug when you discover a bug, error, or issue in the codebase.",
      "Provide the file path, optional line range, and a description of the issue.",
      "The tool auto-detects which commit last modified the file.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "问题文件路径" }),
      lines: Type.Optional(Type.String({ description: "问题行范围，如 '15-23' 或 '42'" })),
      description: Type.String({ description: "问题描述" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return { content: [{ type: "text", text: "⚠️ Vibe 工作流未启用" }] };
      }

      const lastCommit = gitExec(state.projectRoot, [
        "log", "-1", "--format=%h", "--", params.file,
      ]) || "unknown";

      const bugNum = (await readBugIndex(state.projectRoot)).length + 1;
      const bugId = `bug-${String(bugNum).padStart(3, "0")}`;

      const bug: BugMarker = {
        id: bugId,
        timestamp: getTimestamp(),
        file: params.file,
        commitHash: lastCommit,
        lineRange: params.lines,
        description: params.description,
        type: "bug",
        status: "open",
      };

      const detail = [
        `# ${bugId}: ${params.description}`,
        "",
        `- **Status**: open`,
        `- **File**: \`${params.file}\``,
        params.lines ? `- **Lines**: ${params.lines}` : "",
        `- **Introduced in**: \`${lastCommit}\``,
        `- **Timestamp**: ${bug.timestamp}`,
        "",
        `## Description`, "",
        params.description, "",
      ].filter(Boolean).join("\n");

      await writeBugMarker(state.projectRoot, bug, detail);

      return {
        content: [{
          type: "text",
          text: `🐛 Bug 标记: ${bugId}\n文件: ${params.file}${params.lines ? `:${params.lines}` : ""}\n引入提交: ${lastCommit}\n描述: ${params.description}`,
        }],
      };
    },
  });

  /**
   * vibe_bug_fix — LLM 标记 bug 已修复
   */
  pi.registerTool({
    name: "vibe_bug_fix",
    label: "Vibe Bug Fix",
    description: "标记 bug 已修复。记录修复提交和描述。",
    promptSnippet: "Mark a bug as fixed",
    promptGuidelines: [
      "IMPORTANT: Call vibe_bug_fix AFTER vibe_checkpoint, not before. The fix commit hash is only available after the checkpoint is created.",
      "Use vibe_bug_fix after you have fixed a previously reported bug and committed the fix.",
      "Provide the bug ID and a description of the fix.",
    ],
    parameters: Type.Object({
      bugId: Type.String({ description: "Bug ID，如 'bug-001' 或 '001'" }),
      description: Type.Optional(Type.String({ description: "修复描述" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return { content: [{ type: "text", text: "⚠️ Vibe 工作流未启用" }] };
      }

      const normalizedId = params.bugId.startsWith("bug-") ? params.bugId : `bug-${params.bugId.padStart(3, "0")}`;
      const detail = await readBugDetail(state.projectRoot, normalizedId);
      if (!detail) {
        return { content: [{ type: "text", text: `❌ 未找到 ${normalizedId}` }] };
      }

      const fixCommit = gitExec(state.projectRoot, ["rev-parse", "--short", "HEAD"]) || "unknown";
      const fixDesc = params.description || "已修复";
      const updatedDetail = detail
        .replace(/\*\*Status\*\*:\s*open/, `**Status**: fixed`)
        + `\n\n## Fix\n\n- **Commit**: \`${fixCommit}\`\n- **Description**: ${fixDesc}\n`;

      await writeFile(path.join(state.projectRoot, BUGS_DIR, `${normalizedId}.md`), updatedDetail);

      const indexPath = path.join(state.projectRoot, BUGS_DIR, "INDEX.md");
      const indexContent = await readFileSafe(indexPath) || "";
      await writeFile(indexPath, indexContent.replace(
        new RegExp(`(## ${normalizedId.replace("bug-", "Bug ")}[\\s\\S]*?\\*\\*Status\\*\\*:\\s*)open`),
        `$1fixed`,
      ));

      return {
        content: [{
          type: "text",
          text: `✅ ${normalizedId} 已标记为 fixed\n修复提交: ${fixCommit}\n描述: ${fixDesc}`,
        }],
      };
    },
  });

  /**
   * vibe_bug_info — LLM 按需读取 bug 详情
   */
  pi.registerTool({
    name: "vibe_bug_info",
    label: "Vibe Bug Info",
    description:
      "读取指定文件的变更历史（bug + 优化）。在修改有变更记录的文件前调用，了解问题和优化记录。",
    promptSnippet: "Read change history for a file before modifying it",
    promptGuidelines: [
      "Use vibe_bug_info before modifying files that have change history (bugs or optimizations).",
      "The context injection lists files with changes — call this tool to read details.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "要查询的文件路径" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const bugs = await getBugsForFile(state.projectRoot, params.file);
      if (bugs.length === 0) {
        return { content: [{ type: "text", text: `✅ ${params.file} 无 bug 记录` }] };
      }

      const lines = [`## ${params.file} Bug History\n`];
      for (const bug of bugs) {
        const detail = await readBugDetail(state.projectRoot, bug.id);
        lines.push(detail || `(${bug.id}: ${bug.description})`);
      }
      return { content: [{ type: "text", text: lines.join("\n---\n") }] };
    },
  });

  /**
   * vibe_optimize — LLM 标记优化点
   */
  pi.registerTool({
    name: "vibe_optimize",
    label: "Vibe Optimize",
    description:
      "标记优化点。记录优化的文件、位置、内容。用于开发过程中发现可优化代码时调用。",
    promptSnippet: "Mark an optimization made during development",
    promptGuidelines: [
      "Use vibe_optimize when you optimize, refactor, or improve existing code.",
      "Provide the file path, optional line range, and a description of the optimization.",
      "Call vibe_optimize AFTER vibe_checkpoint (same as vibe_bug_fix).",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "优化文件路径" }),
      lines: Type.Optional(Type.String({ description: "优化行范围，如 '15-23' 或 '42'" })),
      description: Type.String({ description: "优化描述" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return { content: [{ type: "text", text: "⚠️ Vibe 工作流未启用" }] };
      }

      const lastCommit = gitExec(state.projectRoot, [
        "log", "-1", "--format=%h", "--", params.file,
      ]) || "unknown";

      const allMarkers = await readBugIndex(state.projectRoot);
      const optNum = allMarkers.filter((m) => m.type === "optimize").length + 1;
      const optId = `opt-${String(optNum).padStart(3, "0")}`;

      const marker: BugMarker = {
        id: optId,
        timestamp: getTimestamp(),
        file: params.file,
        commitHash: lastCommit,
        lineRange: params.lines,
        description: params.description,
        type: "optimize",
        status: "applied",
      };

      const detail = [
        `# ⚡ ${optId}: ${params.description}`,
        "",
        `- **Status**: applied`,
        `- **File**: \`${params.file}\``,
        params.lines ? `- **Lines**: ${params.lines}` : "",
        `- **Commit**: \`${lastCommit}\``,
        `- **Timestamp**: ${marker.timestamp}`,
        "",
        `## Description`, "",
        params.description, "",
      ].filter(Boolean).join("\n");

      await writeBugMarker(state.projectRoot, marker, detail);

      return {
        content: [{
          type: "text",
          text: `⚡ 优化标记: ${optId}\n文件: ${params.file}${params.lines ? `:${params.lines}` : ""}\n提交: ${lastCommit}\n描述: ${params.description}`,
        }],
      };
    },
  });

  console.log(
    "[vibe-tracker] Extension loaded — Bug/Optimization tracking ready",
  );
}
