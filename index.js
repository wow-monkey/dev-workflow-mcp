#!/usr/bin/env node
/**
 * dev-workflow MCP server（stdio）
 * 需求处理流程状态机：
 *   clarify -> awaiting_confirm -> implementing -> review -> done
 * 状态文件：~/.config/opencode/workflow-state.json（单一全局状态）
 * 只有 implementing / review 两个步骤允许修改文件。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 步骤定义（canModifyFiles=true 的步骤才允许修改文件） */
const STEPS = [
  {
    key: "clarify",
    index: 0,
    description:
      "需求梳理：只读源码，输出需求梳理（涉及文件/影响面/方案/风险），禁止修改文件",
    canModifyFiles: false,
  },
  {
    key: "awaiting_confirm",
    index: 1,
    description: "待用户确认：等待用户确认梳理结果，禁止修改文件",
    canModifyFiles: false,
  },
  {
    key: "implementing",
    index: 2,
    description: "执行修改：按确认后的方案修改文件",
    canModifyFiles: true,
  },
  {
    key: "review",
    index: 3,
    description: "关联检查：核对改动的全部引用方，可修复发现的问题",
    canModifyFiles: true,
  },
  {
    key: "done",
    index: 4,
    description: "完成",
    canModifyFiles: false,
  },
];

/** 单一全局状态文件 */
const STATE_FILE = join(homedir(), ".config", "opencode", "workflow-state.json");

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      if (parsed && typeof parsed.currentStep === "string" && stepInfo(parsed.currentStep)) {
        if (!Array.isArray(parsed.history)) parsed.history = [];
        return parsed;
      }
    }
  } catch {
    // 状态文件损坏时回退默认值
  }
  return { currentStep: "clarify", updatedAt: new Date().toISOString(), history: [] };
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    // 写失败不中断 MCP（stderr 不会污染 stdio 协议）
    console.error(`[dev-workflow] Failed to save state: ${err?.message ?? err}`);
  }
}

function stepInfo(key) {
  return STEPS.find(s => s.key === key) ?? null;
}

/** 切换步骤并记录历史 */
function transitionTo(state, toKey) {
  const from = state.currentStep;
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ from, to: toKey, at: new Date().toISOString() });
  if (state.history.length > 50) state.history = state.history.slice(-50);
  state.currentStep = toKey;
  state.updatedAt = new Date().toISOString();
  saveState(state);
  return state;
}

function currentView(state) {
  const step = stepInfo(state.currentStep) ?? STEPS[0];
  return {
    step: step.key,
    index: step.index,
    description: step.description,
    canModifyFiles: step.canModifyFiles,
    updatedAt: state.updatedAt,
  };
}

function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** 串行化所有工具调用，避免并发读写状态文件产生竞态 */
let queue = Promise.resolve();
function serialized(fn) {
  return async (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const server = new McpServer(
  { name: "dev-workflow", version: "1.0.0" },
  {
    instructions: [
      "需求处理流程状态机。处理任何需求时必须遵循：",
      "1) 接到新需求先 set_step 到 clarify，输出需求梳理后 set_step 到 awaiting_confirm，等待用户确认；",
      "2) 用户确认后 advance 到 implementing，此时才允许修改文件；",
      "3) 每次调用 edit/write 修改文件前，必须先调用 assert_can_modify；返回不允许时立即停止修改并提示当前步骤；",
      "4) 修改完成后进入 review 做关联检查，检查通过后 set_step 到 done。",
    ].join("\n"),
  }
);

/** 1. 获取当前步骤 */
server.registerTool(
  "get_current_step",
  {
    title: "获取当前流程步骤",
    description:
      "获取需求处理流程当前所在步骤，以及该步骤是否允许修改文件（canModifyFiles）。",
    inputSchema: {},
  },
  serialized(async () => textResult(currentView(loadState()))),
);

/** 2. 切换步骤（可任意跳转，用于回退或跳步） */
server.registerTool(
  "set_step",
  {
    title: "切换流程步骤",
    description: "将需求处理流程切换到指定步骤（可任意跳转，用于回退或跳步）。",
    inputSchema: {
      step: z
        .enum(["clarify", "awaiting_confirm", "implementing", "review", "done"])
        .describe("目标步骤"),
    },
  },
  serialized(async ({ step }) => textResult(currentView(transitionTo(loadState(), step)))),
);

/** 3. 顺序进入下一步 */
server.registerTool(
  "advance",
  {
    title: "进入下一步",
    description: "按顺序进入下一步骤（已在最后一步时保持不变并提示）。",
    inputSchema: {},
  },
  serialized(async () => {
    const state = loadState();
    const cur = stepInfo(state.currentStep) ?? STEPS[0];
    if (cur.index >= STEPS.length - 1) {
      return {
        content: [{ type: "text", text: `已经在最后一步 ${cur.key}，无法继续前进。` }],
      };
    }
    const next = STEPS[cur.index + 1];
    return textResult(currentView(transitionTo(state, next.key)));
  }),
);

/** 4. 重置到 clarify */
server.registerTool(
  "reset",
  {
    title: "重置流程",
    description: "将流程重置回第一步 clarify（接到新需求时使用）。",
    inputSchema: {},
  },
  serialized(async () => textResult(currentView(transitionTo(loadState(), "clarify")))),
);

/** 5. 修改文件前必须调用的强约束断言 */
server.registerTool(
  "assert_can_modify",
  {
    title: "断言是否允许修改文件",
    description:
      "调用 edit/write 修改文件之前必须先调用。当前步骤允许修改时返回 ok；否则返回错误并说明当前步骤，此时必须立即停止修改文件。",
    inputSchema: {},
  },
  serialized(async () => {
    const state = loadState();
    const step = stepInfo(state.currentStep) ?? STEPS[0];
    if (step.canModifyFiles) {
      return {
        content: [
          { type: "text", text: `ok：当前步骤 ${step.key}（${step.description}），允许修改文件。` },
        ],
      };
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `禁止修改文件：当前步骤为 ${step.key}（${step.description}）。只有 implementing / review 步骤允许修改文件。请先完成需求梳理并经用户确认后，用 set_step 或 advance 切换到 implementing 再修改。`,
        },
      ],
    };
  }),
);

/** 6. 列出全部步骤 */
server.registerTool(
  "list_workflow",
  {
    title: "列出流程步骤",
    description: "列出需求处理流程的全部步骤定义、顺序及各步骤是否允许修改文件。",
    inputSchema: {},
  },
  serialized(async () => {
    const state = loadState();
    return textResult({
      current: state.currentStep,
      steps: STEPS,
      note: "只有 implementing / review（canModifyFiles=true）允许修改文件。",
    });
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error("[dev-workflow] Fatal:", err);
  process.exit(1);
});