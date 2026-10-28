/**
 * dev-workflow MCP 串行调用回归测试（模拟 agent 真实的一次一调用场景）
 * 用法：node test-serial.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(__dirname, "index.js")], {
  cwd: __dirname,
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let nextId = 0;
let stderrBuf = "";

child.stdout.setEncoding("utf-8");
child.stdout.on("data", chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", chunk => (stderrBuf += chunk));

function send(method, params) {
  return new Promise(resolve => {
    const id = ++nextId;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function textOf(msg) {
  return msg?.result?.content?.[0]?.text ?? "";
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected: ${expected}\n      actual:   ${actual}`);
}

// 串行流程
await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "regression", version: "1.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

await send("tools/call", { name: "reset", arguments: {} });

// 1. clarify 下断言：禁止修改
const r1 = await send("tools/call", { name: "assert_can_modify", arguments: {} });
check("clarify 下 assert_can_modify 返回 isError", r1?.result?.isError === true, true);

// 2. 切到 implementing 后断言：允许修改
await send("tools/call", { name: "set_step", arguments: { step: "implementing" } });
const r2 = await send("tools/call", { name: "assert_can_modify", arguments: {} });
check("implementing 下 assert_can_modify 返回 ok", r2?.result?.isError == null, true);

// 3. get_current_step 与状态文件一致
const r3 = await send("tools/call", { name: "get_current_step", arguments: {} });
check("get_current_step 为 implementing", textOf(r3).includes('"step": "implementing"'), true);

// 4. advance 到 review
await send("tools/call", { name: "advance", arguments: {} });
const r4 = await send("tools/call", { name: "get_current_step", arguments: {} });
check("advance 后为 review", textOf(r4).includes('"step": "review"'), true);

// 5. 非法步骤名被拒（zod 校验）
const r5 = await send("tools/call", { name: "set_step", arguments: { step: "hack" } });
check("非法步骤名被拒绝", r5?.error != null || r5?.result?.isError === true, true);

// 6. 收尾：重置回 clarify
await send("tools/call", { name: "reset", arguments: {} });
const r6 = await send("tools/call", { name: "get_current_step", arguments: {} });
check("reset 后为 clarify", textOf(r6).includes('"step": "clarify"'), true);

child.kill();
if (stderrBuf.trim()) console.log(`\n[stderr]\n${stderrBuf.trim()}`);
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);