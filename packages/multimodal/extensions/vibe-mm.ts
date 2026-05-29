/**
 * =============================================================================
 * Vibe Multimodal Extension — MiniMax/Mimo 多模态工具集
 * =============================================================================
 *
 * 从 vibe-workflow.ts 提取的多模态相关功能：
 *   - /vibe-mimo      — 切换到多模态模型用于识图
 *   - /vibe-minimax   — 使用 MiniMax CLI 生成图片/视频/音频
 *   - /vibe-paste     — 从 Windows 剪贴板粘贴图片（WSL 兼容）
 *   - /vibe-model     — 快速切换模型，实现多模型协作
 *
 * LLM 工具：
 *   - minimax_describe_image — 通过 MiniMax CLI 描述图片内容
 *   - minimax_web_search     — 通过 MiniMax CLI 进行网络搜索
 *   - minimax_generate       — 通过 MiniMax CLI 生成图片/视频/音频
 *   - smart_search           — 多策略代码搜索
 *
 * 状态共享：通过 pi.getEntry("vibe-core") 读取 vibe-core 的状态。
 *
 * @author pi + ljh2923
 * @version 5.8.0
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

/** 工作流持久化状态（与 vibe-core 共享） */
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

// =============================================================================
// 2. 常量与配置
// =============================================================================

/** 扩展名（用于 pi.appendEntry 等） */
const EXT_NAME = "vibe-multimodal";

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
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
}

/**
 * 从 vibe-core 读取共享状态
 */
function getSharedState(pi: ExtensionAPI): VibeState {
  const entries = pi.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry.type === "custom" &&
      (entry as { customType?: string }).customType === "vibe-core"
    ) {
      const saved = (entry as { data?: VibeState }).data;
      if (saved) {
        return saved;
      }
    }
  }
  // 默认状态
  return {
    enabled: false,
    currentTask: "",
    checkpointCount: 0,
    sessionId: generateSessionId(),
    projectRoot: "",
    autoSuggestCheckpoint: true,
  };
}

// =============================================================================
// 4. 扩展入口
// =============================================================================

export default function (pi: ExtensionAPI) {
  // --- 4.1 状态管理 ---

  /** 记录切换前的模型，用于 /vibe-model back */
  let previousModelId = "";

  /** 记录主力模型（用于 /vibe-mimo --back） */
  let primaryModelId = "";

  /** 重注入哈希（用于去重） */
  let lastInjectedStateHash = "";

  /**
   * 计算当前状态的哈希（用于去重判断）
   */
  function computeStateHash(state: VibeState): string {
    return `${state.currentTask}|${state.checkpointCount}|${state.sessionId}`;
  }

  // --- 4.2 模型别名 ---

  /** 预定义模型别名（根据用户实际模型列表配置） */
  const MODEL_ALIASES: Record<string, { provider: string; pattern: string; desc: string }> = {
    pro: { provider: "opencode-go", pattern: "deepseek-v4-pro", desc: "主力思考 · 1M ctx" },
    flash: { provider: "opencode-go", pattern: "deepseek-v4-flash", desc: "日常任务 · 1M ctx" },
    mmx: { provider: "minimax-cn", pattern: "MiniMax-M2.7", desc: "简单任务 · 256K ctx ⚠️" },
    mimo: { provider: "opencode-go", pattern: "mimo-v2.5", desc: "多模态识图 · 1M ctx" },
  };

  // =============================================================================
  // 5. 命令注册
  // =============================================================================

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
      const state = getSharedState(pi);
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
      const state = getSharedState(pi);

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
        "✅ MiniMax CLI 执行完成！\n" +
          `   输出目录: ${outputDir}`,
        "info",
      );
    },
  });

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
    handler: async (args, ctx) => {
      const state = getSharedState(pi);

      // 用户附加的文本（/vibe-paste 后面的内容）
      const userText = args?.trim() || "";

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
          { type: "text" as const, text: `[📷 Image pasted: \`${relativePath}\`]${userText ? "\n" + userText : ""}` },
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
          `[📷 Image pasted: \`${relativePath}\`] Use \`minimax_describe_image\` tool to analyze it.${userText ? "\n" + userText : ""}`,
        );

        ctx.ui.notify(
          `📷 图片已保存: ${relativePath}\n已注入到会话，LLM 将自动调用 minimax_describe_image 分析`,
          "info",
        );
      }
    },
  });

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

  // =============================================================================
  // 6. 工具注册（LLM 可调用）
  // =============================================================================

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
      const state = getSharedState(pi);
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

  // ──── smart_search tool（多策略代码搜索）──

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
    "[vibe-multimodal] Extension loaded — MiniMax/Mimo tools ready",
  );
}
