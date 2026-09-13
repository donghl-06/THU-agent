/**
 * 任务归属会话的透传（Step 23）。
 *
 * sessionId 是 server 层概念，模型不该传也不该知道。server 在 ask 外层
 * run() 一次，skill 的 execute 处于同一异步链上即可读到——不改 Skill 接口。
 * CLI/评测等没有 server 的环境读不到，落回 "default"。
 */
import {AsyncLocalStorage} from "node:async_hooks";

export const taskSessionContext = new AsyncLocalStorage<string>();

/** 当前会话 id（skill 层取用）；无上下文时为 default */
export function currentSessionId(): string {
    return taskSessionContext.getStore() ?? "default";
}
