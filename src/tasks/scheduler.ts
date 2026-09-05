/**
 * 任务调度器（Step 23）：进程内 setInterval 轮询 + 到点执行。
 *
 * 设计约束（plan4ai.md：每加一层都要有理由）：
 *   - 不引任务队列/cron 库：单用户本机应用，30s 轮询足够；
 *   - 执行是确定性代码路径：booking 直接调 skill.execute（确认在创建时已完成），
 *     不再经过 LLM；
 *   - 过期保护：nextRunAt 落后超过 MAX_LATE_MS 的 booking 任务不再执行
 *     （服务停摆后重启绝不该突然下单），转通知"已过期"。
 */
import {randomUUID} from "node:crypto";
import {TaskStore} from "./taskStore";
import {MAX_LATE_MS, type AgentTask, type BookingTask, type MonitorTask} from "./types";

export interface SchedulerHooks {
    /** 通知回调（由 server 层实现：推进通知队列，前端轮询取走） */
    notify: (task: AgentTask, message: string) => void;
    /** booking 执行器：装配层注入 book skill 的 execute；返回给用户看的结果消息 */
    executeBooking: (task: BookingTask) => Promise<string>;
    /** monitor 条件检查：triggered=true 触发通知并结束任务 */
    checkMonitor: (task: MonitorTask) => Promise<{triggered: boolean; message: string}>;
    /** 时间源（测试注入用） */
    now?: () => number;
}

export interface AddTaskInput {
    kind: AgentTask["kind"];
    title: string;
    sessionId: string;
    nextRunAt: number;
    /** monitor 专用 */
    monitor?: MonitorTask["monitor"];
    thresholdKwh?: number;
    intervalMinutes?: number;
    /** booking 专用 */
    toolName?: BookingTask["toolName"];
    input?: Record<string, unknown>;
}

export class TaskScheduler {
    private readonly tasks: Map<string, AgentTask>;
    private timer?: NodeJS.Timeout;
    private readonly now: () => number;

    constructor(
        private readonly hooks: SchedulerHooks,
        private readonly store?: TaskStore,
        private readonly intervalMs = 30_000,
    ) {
        this.now = hooks.now ?? (() => Date.now());
        this.tasks = store?.load() ?? new Map();
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            void this.tick();
        }, this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    list(includeFinished = true): AgentTask[] {
        return [...this.tasks.values()]
            .filter((t) => includeFinished || (!t.done && !t.cancelled))
            .sort((a, b) => a.nextRunAt - b.nextRunAt);
    }

    get(id: string): AgentTask | undefined {
        return this.tasks.get(id);
    }

    add(input: AddTaskInput): AgentTask {
        const base = {
            id: `task_${randomUUID().slice(0, 8)}`,
            createdAt: this.now(),
            nextRunAt: input.nextRunAt,
            title: input.title,
            sessionId: input.sessionId,
        };
        let task: AgentTask;
        if (input.kind === "booking") {
            task = {
                ...base,
                kind: "booking",
                toolName: input.toolName ?? "book_sports_field",
                input: input.input ?? {},
            };
        } else if (input.kind === "monitor") {
            task = {
                ...base,
                kind: "monitor",
                monitor: input.monitor ?? "electricity",
                thresholdKwh: input.thresholdKwh ?? 20,
                intervalMinutes: input.intervalMinutes ?? 360,
            };
        } else {
            task = {...base, kind: "reminder"};
        }
        this.tasks.set(task.id, task);
        this.persist();
        return task;
    }

    cancel(id: string): AgentTask | undefined {
        const task = this.tasks.get(id);
        if (!task || task.done) return undefined;
        task.cancelled = true;
        task.lastMessage = "已被用户取消";
        this.persist();
        return task;
    }

    /** 执行所有到期任务。暴露为方法便于测试；start 后由 interval 调用 */
    async tick(): Promise<void> {
        const now = this.now();
        const due = [...this.tasks.values()].filter((t) => !t.done && !t.cancelled && t.nextRunAt <= now);
        for (const task of due) {
            try {
                if (task.kind === "reminder") {
                    this.hooks.notify(task, task.title);
                    task.done = true;
                    task.lastMessage = "已提醒";
                } else if (task.kind === "booking") {
                    if (now - task.nextRunAt > MAX_LATE_MS) {
                        this.hooks.notify(task, `定时预约"${task.title}"已过期（超出 ${MAX_LATE_MS / 60_000} 分钟宽限），未执行。`);
                        task.done = true;
                        task.lastMessage = "已过期未执行";
                    } else {
                        const message = await this.hooks.executeBooking(task);
                        this.hooks.notify(task, message);
                        task.done = true;
                        task.lastMessage = message;
                    }
                } else {
                    const res = await this.hooks.checkMonitor(task);
                    if (res.triggered) {
                        this.hooks.notify(task, res.message);
                        task.done = true;
                        task.lastMessage = res.message;
                    } else {
                        task.nextRunAt = now + task.intervalMinutes * 60_000;
                    }
                }
            } catch (e) {
                // 执行器异常不炸调度循环：作为任务失败通知出去
                const message = `任务"${task.title}"执行异常：${(e as Error).message}`;
                this.hooks.notify(task, message);
                task.done = true;
                task.lastMessage = message;
            }
            this.persist();
        }
    }

    private persist(): void {
        this.store?.save(this.tasks);
    }
}
