/**
 * 任务类 Skill（Step 23）：把"创建任务"暴露给模型。
 *
 * 关键语义：这些 skill 只把任务登记进 scheduler（走确认流，确认内容 =
 * 任务的具体参数）；到点执行走 scheduler 的确定性代码路径，不再经过 LLM。
 * booking 任务的执行是真实下单——因此其参数（尤其 payType）必须在创建时
 * 由用户明确确认，执行时不再询问。
 */
import {parseDate} from "../skills/base/dateUtils";
import {fail, ok, type Skill, type SkillResult} from "../skills/base/types";
import type {AddTaskInput, TaskScheduler} from "../tasks/scheduler";
import {currentSessionId} from "./sessionContext";

const RUN_AT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** 解析 "YYYY-MM-DD HH:mm"（本地时区），非法返回 null */
export function parseRunAt(s: string): number | null {
    const m = RUN_AT_RE.exec(s.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
        return null;
    }
    return date.getTime();
}

/** 校验 runAt 是合法的未来时间（1 分钟内的"现在"也算，便于立即测试） */
export function validateRunAt(raw: unknown): {error?: string; runAt?: number} {
    if (typeof raw !== "string") return {error: "runAt 必填：格式 'YYYY-MM-DD HH:mm'"};
    const runAt = parseRunAt(raw);
    if (runAt === null) return {error: `无法解析时间：${raw}，请用 'YYYY-MM-DD HH:mm' 格式`};
    if (runAt < Date.now() - 60_000) return {error: "runAt 必须是将来的时间"};
    return {runAt};
}

/** 公共：scheduler 未装配时的统一报错 */
function noScheduler(): SkillResult<never> {
    return fail("SCHEDULER_UNAVAILABLE", "当前运行环境不支持定时任务（未装配任务调度器）。");
}

export function createCreateReminderSkill(scheduler: TaskScheduler): Skill {
    return {
        name: "create_reminder",
        description:
            "创建定时提醒（到点后网页会弹出通知）。调用前先向用户复述提醒内容和时间，得到明确同意后调用。" +
            "runAt 用 'YYYY-MM-DD HH:mm'（24 小时制）。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                title: {type: "string", description: "提醒内容，如“该去抢周六羽毛球场了”"},
                runAt: {type: "string", description: "提醒时间，'YYYY-MM-DD HH:mm'，必须是将来时间"},
            },
            required: ["title", "runAt"],
        },
        async execute(input: unknown): Promise<SkillResult<{taskId: string}>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.title !== "string" || !raw.title.trim()) {
                return fail("INVALID_INPUT", "title 必填：提醒内容");
            }
            const checked = validateRunAt(raw.runAt);
            if (checked.error || checked.runAt === undefined) {
                return fail("INVALID_INPUT", checked.error ?? "runAt 无效");
            }
            if (!scheduler) return noScheduler();
            const taskInput: AddTaskInput = {
                kind: "reminder",
                title: raw.title.trim(),
                sessionId: currentSessionId(),
                nextRunAt: checked.runAt,
            };
            const task = scheduler.add(taskInput);
            return ok({taskId: task.id, note: "提醒已创建，到点后会在网页通知。"});
        },
    };
}

export function createScheduleSportsBookingSkill(scheduler: TaskScheduler): Skill {
    return {
        name: "schedule_sports_booking",
        description:
            "创建定时抢场任务（到点自动真实下单预约体育场馆，写操作）。" +
            "调用前必须：①向用户复述场馆/日期/时段/费用/支付方式/执行时间；②付费场次让用户明确选择线上或线下支付。" +
            "payType 必填——免费场次传 PAY_OFFLINE 即可；到点执行时不会再询问用户。" +
            "执行结果会在网页通知。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {
                resourceName: {type: "string", description: "场馆项目关键词，如“气膜馆羽毛球”"},
                sessionStart: {type: "string", description: "场次开始时间 HH:MM，如“06:00”"},
                date: {type: "string", description: "目标场次日期 YYYY-MM-DD；省略=执行当天的今天"},
                fieldName: {type: "string", description: "场地名，如“羽03”；省略=自动选第一块空场"},
                payType: {type: "string", enum: ["PAY_ONLINE", "PAY_OFFLINE"], description: "支付方式，必填（免费场次传 PAY_OFFLINE）"},
                runAt: {type: "string", description: "执行时间（放票/开抢时刻），'YYYY-MM-DD HH:mm'"},
            },
            required: ["resourceName", "sessionStart", "payType", "runAt"],
        },
        async execute(input: unknown): Promise<SkillResult<{taskId: string}>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.resourceName !== "string" || !raw.resourceName.trim()) {
                return fail("INVALID_INPUT", "resourceName 必填：场馆项目关键词");
            }
            if (typeof raw.sessionStart !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.sessionStart)) {
                return fail("INVALID_INPUT", "sessionStart 必须是 HH:MM 格式");
            }
            if (raw.payType !== "PAY_ONLINE" && raw.payType !== "PAY_OFFLINE") {
                return fail("INVALID_INPUT", "payType 必填：PAY_ONLINE（线上）或 PAY_OFFLINE（线下）；免费场次传 PAY_OFFLINE");
            }
            if (raw.date !== undefined && typeof raw.date === "string" && parseDate(raw.date) === null) {
                return fail("INVALID_INPUT", "date 必须是 YYYY-MM-DD 格式");
            }
            const checked = validateRunAt(raw.runAt);
            if (checked.error || checked.runAt === undefined) {
                return fail("INVALID_INPUT", checked.error ?? "runAt 无效");
            }
            if (!scheduler) return noScheduler();
            const task = scheduler.add({
                kind: "booking",
                title: `${raw.resourceName.trim()} ${raw.date ?? "今天"} ${raw.sessionStart} 定时预约`,
                sessionId: currentSessionId(),
                nextRunAt: checked.runAt,
                toolName: "book_sports_field",
                input: {
                    resourceName: raw.resourceName.trim(),
                    sessionStart: raw.sessionStart,
                    payType: raw.payType,
                    ...(typeof raw.date === "string" ? {date: raw.date} : {}),
                    ...(typeof raw.fieldName === "string" && raw.fieldName.trim() ? {fieldName: raw.fieldName.trim()} : {}),
                },
            });
            return ok({taskId: task.id, note: "抢场任务已创建，到点自动执行并通知结果。"});
        },
    };
}

export function createListMyTasksSkill(scheduler: TaskScheduler): Skill {
    return {
        name: "list_my_tasks",
        description: "查询当前未完成的定时任务（提醒/监控/抢场）。无参数。",
        inputSchema: {type: "object", properties: {}, required: []},
        async execute(): Promise<SkillResult<unknown>> {
            if (!scheduler) return noScheduler();
            const tasks = scheduler.list(false).map((t) => ({
                id: t.id,
                kind: t.kind,
                title: t.title,
                nextRunAt: new Date(t.nextRunAt).toLocaleString("zh-CN"),
            }));
            return ok({tasks, note: tasks.length === 0 ? "当前没有进行中的任务。" : `共 ${tasks.length} 个进行中的任务。`});
        },
    };
}

export function createCancelTaskSkill(scheduler: TaskScheduler): Skill {
    return {
        name: "cancel_task",
        description: "取消一个定时任务（写操作，不可恢复）。taskId 从 list_my_tasks 获得。",
        requiresConfirmation: true,
        inputSchema: {
            type: "object",
            properties: {taskId: {type: "string", description: "任务 id，如 task_ab12cd34"}},
            required: ["taskId"],
        },
        async execute(input: unknown): Promise<SkillResult<unknown>> {
            const raw = (input ?? {}) as Record<string, unknown>;
            if (typeof raw.taskId !== "string" || !raw.taskId.trim()) {
                return fail("INVALID_INPUT", "taskId 必填");
            }
            if (!scheduler) return noScheduler();
            const task = scheduler.cancel(raw.taskId.trim());
            if (!task) return fail("NOT_FOUND", `找不到可取消的任务 ${raw.taskId}（不存在或已完成）。`);
            return ok({cancelled: task.id, note: `已取消任务：${task.title}`});
        },
    };
}
