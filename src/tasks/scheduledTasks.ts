import {randomUUID} from "node:crypto";
import type {ScheduledRun, ScheduledState, ScheduledTask, ScheduledTaskInput, TaskSchedule} from "./scheduledTypes";

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const LATE_LIMIT = 10 * 60_000;

export class TaskInputError extends Error {}
export class TaskBusyError extends Error {}

export function validateScheduledInput(value: unknown, now: number): ScheduledTaskInput {
    if (!value || typeof value !== "object") throw new TaskInputError("请填写任务内容。");
    const input = value as ScheduledTaskInput;
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!title || title.length > 80) throw new TaskInputError("任务名称需为 1–80 个字符。");
    if (!prompt || prompt.length > 8000) throw new TaskInputError("任务内容需为 1–8000 个字符。");
    const raw = input.schedule;
    if (!raw || !["once", "daily", "weekly"].includes(raw.frequency) || typeof raw.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) {
        throw new TaskInputError("请选择有效的执行时间。");
    }
    const schedule: TaskSchedule = {frequency: raw.frequency, time: raw.time};
    if (raw.frequency === "once") {
        if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) throw new TaskInputError("请选择执行日期。");
        const parsed = new Date(`${raw.date}T00:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw.date) throw new TaskInputError("执行日期无效。");
        schedule.date = raw.date;
    }
    if (raw.frequency === "weekly") {
        if (!Array.isArray(raw.weekdays) || !raw.weekdays.length || !raw.weekdays.every(day => Number.isInteger(day) && day >= 1 && day <= 7)) {
            throw new TaskInputError("每周任务至少选择一天。");
        }
        schedule.weekdays = [...new Set(raw.weekdays)].sort();
    }
    if (!nextScheduledAt(schedule, now)) throw new TaskInputError("单次任务的执行时间必须在未来。");
    return {title, prompt, schedule};
}

/** Strictly after `after`; never replays a backlog of recurring runs. */
export function nextScheduledAt(schedule: TaskSchedule, after: number): number | undefined {
    if (schedule.frequency === "once") {
        const at = Date.parse(`${schedule.date}T${schedule.time}:00+08:00`);
        return at > after ? at : undefined;
    }
    const local = new Date(after + OFFSET);
    const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    const [hours, minutes] = schedule.time.split(":").map(Number);
    for (let offset = 0; offset <= 7; offset++) {
        const day = midnight + offset * DAY;
        const at = day - OFFSET + hours * 3_600_000 + minutes * 60_000;
        const weekday = new Date(day).getUTCDay() || 7;
        if (at > after && (schedule.frequency === "daily" || schedule.weekdays?.includes(weekday))) return at;
    }
    return undefined;
}

interface ScheduledHooks {
    load: () => ScheduledState | undefined;
    save: (state: ScheduledState) => void;
    canRun: () => boolean;
    execute: (task: ScheduledTask, run: ScheduledRun, signal: AbortSignal) => Promise<{status: "completed" | "failed" | "needs_attention"; summary: string}>;
    now?: () => number;
}

/** One executor per local Web process. Persist claims before calling the Agent. */
export class ScheduledTasks {
    private readonly state: ScheduledState;
    private readonly now: () => number;
    private timer?: NodeJS.Timeout;
    private active?: {runId: string; controller: AbortController; done: Promise<void>};
    private stopped = false;

    constructor(private readonly hooks: ScheduledHooks) {
        this.now = hooks.now ?? Date.now;
        this.state = hooks.load() ?? {tasks: [], runs: []};
        for (const run of this.state.runs) {
            if (run.status === "running") Object.assign(run, {status: "interrupted", finishedAt: this.now(), summary: "服务重启中断了此次执行，可手动重新运行。"});
        }
        this.persist();
    }

    snapshot(): ScheduledState { return structuredClone(this.state); }
    whenIdle(): Promise<void> { return this.active?.done ?? Promise.resolve(); }
    start() {
        if (this.timer) return;
        this.stopped = false;
        this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 5000);
        this.timer.unref();
        void this.tick().catch(() => {});
    }
    async stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = undefined;
        this.active?.controller.abort();
        await this.active?.done;
    }

    create(value: unknown) {
        if (this.state.tasks.length >= 100) throw new TaskInputError("最多保留 100 个任务，请删除不再使用的任务。");
        const input = validateScheduledInput(value, this.now());
        const task: ScheduledTask = {...input, id: `scheduled_${randomUUID()}`, createdAt: this.now(), updatedAt: this.now(), enabled: true,
            nextRunAt: nextScheduledAt(input.schedule, this.now())};
        this.state.tasks.push(task);
        this.persist();
        return task;
    }

    private get(id: string) {
        const task = this.state.tasks.find(item => item.id === id);
        if (!task) throw new TaskInputError("任务不存在或已被删除。");
        return task;
    }
    update(id: string, value: unknown) {
        const task = this.get(id);
        const input = validateScheduledInput(value, this.now());
        Object.assign(task, input, {updatedAt: this.now(), nextRunAt: nextScheduledAt(input.schedule, this.now())});
        this.persist();
    }
    toggle(id: string, enabled: boolean) {
        const task = this.get(id);
        const nextRunAt = nextScheduledAt(task.schedule, this.now());
        if (enabled && !nextRunAt) throw new TaskInputError("请先编辑单次任务，设置未来的执行时间。");
        Object.assign(task, {enabled, nextRunAt, updatedAt: this.now()});
        this.persist();
    }
    remove(id: string) {
        this.get(id);
        if (this.state.runs.some(run => run.taskId === id && run.status === "running")) throw new TaskBusyError("请先停止正在执行的任务。");
        this.state.tasks = this.state.tasks.filter(task => task.id !== id);
        this.persist();
    }
    cancelRun(id: string) {
        if (this.active?.runId !== id) throw new TaskInputError("此次执行已结束。");
        this.active.controller.abort();
    }
    deleteRun(id: string) {
        const run = this.state.runs.find(item => item.id === id);
        if (!run) throw new TaskInputError("执行记录不存在。");
        if (run.status === "running") throw new TaskBusyError("请先停止此次执行。");
        this.state.runs = this.state.runs.filter(item => item.id !== id);
        this.persist();
        return run.sessionId;
    }

    runNow(id: string) {
        if (this.stopped || this.active || !this.hooks.canRun()) throw new TaskBusyError("请先完成登录，并等待当前操作结束。");
        return this.launch(this.get(id), "manual");
    }

    async tick() {
        if (this.stopped || this.active) return;
        const now = this.now();
        const tasks = [...this.state.tasks].filter(task => task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= now)
            .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
        for (const task of tasks) {
            if (now - task.nextRunAt! > LATE_LIMIT) {
                this.state.runs.unshift({id: randomUUID(), taskId: task.id, title: task.title, prompt: task.prompt, trigger: "scheduled",
                    scheduledAt: task.nextRunAt!, startedAt: now, finishedAt: now, status: "missed", summary: "错过执行时间超过 10 分钟，已跳过。可手动运行。"});
                this.advance(task, now);
                this.persist();
                continue;
            }
            if (!this.hooks.canRun()) return;
            this.launch(task, "scheduled");
            await this.whenIdle();
            return;
        }
    }

    private advance(task: ScheduledTask, now: number) {
        task.nextRunAt = nextScheduledAt(task.schedule, now);
        if (!task.nextRunAt) task.enabled = false;
    }
    private launch(task: ScheduledTask, trigger: ScheduledRun["trigger"]) {
        const run: ScheduledRun = {id: randomUUID(), taskId: task.id, title: task.title, prompt: task.prompt,
            sessionId: `scheduled_${randomUUID()}`, trigger, scheduledAt: trigger === "scheduled" ? task.nextRunAt! : this.now(),
            startedAt: this.now(), status: "running"};
        this.state.runs.unshift(run);
        // Manual runs do not consume or move the saved schedule.
        if (trigger === "scheduled") this.advance(task, this.now());
        this.persist();
        const controller = new AbortController();
        // Install the lock synchronously, before any executor callback can reenter.
        const done = Promise.resolve().then(async () => {
            const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
            timeout.unref();
            try {
                controller.signal.throwIfAborted();
                Object.assign(run, await this.hooks.execute(structuredClone(task), structuredClone(run), controller.signal));
                if (controller.signal.aborted) Object.assign(run, {status: "cancelled", summary: "执行已停止或超时。"});
            } catch {
                Object.assign(run, {status: controller.signal.aborted ? "cancelled" : "failed",
                    summary: controller.signal.aborted ? "执行已停止或超时。" : "执行失败，请检查登录和模型连接后重试。"});
            } finally {
                clearTimeout(timeout);
                run.finishedAt = this.now();
                this.active = undefined;
                this.persist();
            }
        });
        this.active = {runId: run.id, controller, done};
        // A failed persistence write must not become an unhandled rejection.
        void done.catch(() => {});
        return structuredClone(run);
    }
    private persist() { this.hooks.save(this.state); }
}
