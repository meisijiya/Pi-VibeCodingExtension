/**
 * pi-context7 — Context7 REST API Extension for pi
 *
 * 通过 Context7 REST API 获取最新官方文档，消除 LLM "编造 API" 问题。
 * 无需 MCP 协议，直接 HTTP 调用，零依赖、零子进程。
 *
 * 前置条件:
 *   1. 注册 Context7: https://context7.com
 *   2. 设置环境变量: export CONTEXT7_API_KEY=ctx7sk-xxx
 *
 * API 文档: https://context7.com/docs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASE = "https://context7.com/api/v2";

async function ctx7(path: string): Promise<unknown> {
  const key = process.env.CONTEXT7_API_KEY || "";
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`Context7 API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

export default function (pi: ExtensionAPI) {
  const key = process.env.CONTEXT7_API_KEY;
  if (!key) {
    console.error("[context7] CONTEXT7_API_KEY not set. Get key at https://context7.com");
    return;
  }

  // ──── Tool 1: context7_resolve ────
  pi.registerTool({
    name: "context7_resolve",
    label: "Context7 Resolve Library",
    description:
      "通过 Context7 搜索库/框架，获取库 ID 和最新版本信息。" +
      " 在调用 context7_docs 前需要先用此工具获取 libraryId。" +
      " 返回库名、描述、版本列表、stars 等。",
    promptSnippet: "Search library on Context7 to get its ID",
    promptGuidelines: [
      "Use context7_resolve to find a library's ID before calling context7_docs.",
      "Context7 provides up-to-date official documentation. Always prefer it over training data for API references.",
    ],
    parameters: Type.Object({
      libraryName: Type.String({
        description: "库/框架名称（如 'next.js', 'react', 'prisma', 'tailwindcss'）",
      }),
      query: Type.Optional(
        Type.String({
          description: "可选：搜索上下文（如 'setup ssr'），帮助排序结果",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const q = params.query
          ? `&query=${encodeURIComponent(params.query)}`
          : "";
        const data = await ctx7(
          `/libs/search?libraryName=${encodeURIComponent(params.libraryName)}${q}`,
        ) as { results?: { id: string; title: string; description: string; versions: string[]; stars: number }[] };

        if (!data.results?.length) {
          return {
            content: [{ type: "text" as const, text: `❌ Context7: No results for "${params.libraryName}"` }],
          };
        }

        const top = data.results.slice(0, 3);
        const lines = [`## Context7 Search: ${params.libraryName}`, ""];
        for (const r of top) {
          lines.push(`- **${r.title}** (\`${r.id}\`) ⭐${r.stars || 0}`);
          lines.push(`  ${r.description}`);
          if (r.versions?.length) lines.push(`  Versions: ${r.versions.slice(0, 5).join(", ")}`);
          lines.push("");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `❌ Context7 resolve failed: ${e}` }] };
      }
    },
  });

  // ──── Tool 2: context7_docs ────
  pi.registerTool({
    name: "context7_docs",
    label: "Context7 Get Docs",
    description:
      "通过 Context7 获取库/框架的最新官方文档和代码示例。" +
      " 需要先用 context7_resolve 获取 libraryId（如 '/vercel/next.js'）。" +
      " 支持 query 参数精准查找特定主题的文档。",
    promptSnippet: "Get latest official docs and code examples via Context7",
    promptGuidelines: [
      "Use context7_docs to get up-to-date API documentation before writing code with a library.",
      "Always resolve the library first with context7_resolve, then call context7_docs with the libraryId.",
      "Specify a query to narrow down documentation (e.g., 'getServerSideProps', 'useState').",
    ],
    parameters: Type.Object({
      libraryId: Type.String({
        description: "context7 库 ID（从 context7_resolve 获取，如 '/vercel/next.js'）",
      }),
      query: Type.String({
        description: "文档查询主题（如 'routing', 'data fetching with getServerSideProps'）",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      try {
        const data = await ctx7(
          `/context?libraryId=${encodeURIComponent(params.libraryId)}&query=${encodeURIComponent(params.query)}&type=txt`,
        ) as string;

        const trimmed = data.length > 8000
          ? data.slice(0, 8000) + "\n\n[... truncated, use a more specific query for focused results]"
          : data;

        return {
          content: [{
            type: "text" as const,
            text: `## Context7 Docs: ${params.libraryId}\n> Query: ${params.query}\n\n${trimmed}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `❌ Context7 docs failed: ${e}` }] };
      }
    },
  });

  console.log("[context7] 2 tools registered (REST API): context7_resolve, context7_docs");
}
