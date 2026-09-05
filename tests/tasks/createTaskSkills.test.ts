/**
 * 任务类 Skill 单测：假 scheduler，验证登记/校验/取消的行为与参数透传。
 */
import {describe, expect, it} from "vitest";
import type {AddTaskInput} from "../../src/tasks/scheduler";
import {
    createCancelTaskSkill,
    createCreateReminderSkill,
    createListMyTasksSkill,
    createScheduleSportsBookingSkill,
    parseRunAt,
    validateRunAt,
} from "../../src/tasks/createTaskSkills";
import type {AgentTask, BookingTask} from "../../src/tasks/types";

/** 假 scheduler：只记录 add/cancel/list 调用 */
function fakeScheduler(now = Date.now()) {
    const added: AddTaskInput[] = [];
    let seq = 0;
    const tasks: AgentTask[] = [];
    return {
        added,
        tasks,
        add(input: AddTaskInput) {
            added.push(input);
            const task = {
                id: `task_${++seq}`,
                createdAt: now,
                nextRunAt: input.nextRunAt,
                title: input.title,
                sessionId: input.sessionId,
                kind: input.kind,
            } as AgentTask;
            tasks.push(task);
            return task;
        },
        cancel(id: string) {
            const t = tasks.find((x) => x.id === id);
            if (t) t.cancelled = true;
            return t;
        },
        list() { return tasks; },
    };
}

describe("parseRunAt / validateRunAt", () => {
    it("解析本地时区的 YYYY-MM-DD HH:mm", () => {
        expect(parseRunAt("2026-09-05 06:00")).toBe(new Date(2026, 8, 5, 6, 0).getTime());
        expect(parseRunAt("2026-13-05 06:00")).toBeNull();
        expect(parseRunAt("明天早上")).toBeNull();
    });

    it("validateRunAt 拒绝过去的时间（1 分钟宽限）", () => {
        const past = new Date(Date.now() - 2 * 60_000);
        const pastStr = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")} ${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
        expect(validateRunAt(pastStr).error).toContain("将来");
        expect(validateRunAt("2099-01-01 08:00").runAt).toBeDefined();
    });
});

describe("任务类 Skill", () => {
    it("create_reminder：登记任务并返回 taskId", async () => {
        const s = fakeScheduler();
        const skill = createCreateReminderSkill(s as never);
        const result = await skill.execute({title: "去抢场", runAt: "2099-01-01 06:00"});
        expect(result.success).toBe(true);
        expect(s.added).toHaveLength(1);
        expect(s.added[0].kind).toBe("reminder");
        expect(s.added[0].title).toBe("去抢场");
    });

    it("schedule_sports_booking：payType 缺失拒绝、合法参数透传进 booking 任务", async () => {
        const s = fakeScheduler();
        const skill = createScheduleSportsBookingSkill(s as never);
        const noPay = await skill.execute({resourceName: "气膜馆羽毛球", sessionStart: "06:00", runAt: "2099-01-01 06:00"});
        expect(noPay.success).toBe(false);
        expect((noPay as {error?: {code: string}}).error?.code).toBe("INVALID_INPUT");

        const good = await skill.execute({
            resourceName: "气膜馆羽毛球", sessionStart: "06:00", date: "2026-09-06",
            payType: "PAY_ONLINE", runAt: "2099-01-01 06:00",
        });
        expect(good.success).toBe(true);
        const input = s.added[0] as BookingTask extends never ? never : AddTaskInput;
        expect(input.kind).toBe("booking");
        expect(input.input).toEqual({
            resourceName: "气膜馆羽毛球", sessionStart: "06:00", date: "2026-09-06", payType: "PAY_ONLINE",
        });
    });

    it("cancel_task：取消存在的任务，不存在的报 NOT_FOUND", async () => {
        const s = fakeScheduler();
        const task = s.add({kind: "reminder", title: "x", sessionId: "s", nextRunAt: Date.now() + 1});
        const skill = createCancelTaskSkill(s as never);
        const okResult = await skill.execute({taskId: task.id});
        expect(okResult.success).toBe(true);
        expect((task as {cancelled?: boolean}).cancelled).toBe(true);

        const missing = await skill.execute({taskId: "task_nope"});
        expect(missing.success).toBe(false);
        expect((missing as {error?: {code: string}}).error?.code).toBe("NOT_FOUND");
    });

    it("list_my_tasks：列出未完成任务", async () => {
        const s = fakeScheduler();
        s.add({kind: "reminder", title: "提醒A", sessionId: "s", nextRunAt: Date.now() + 1000});
        const skill = createListMyTasksSkill(s as never);
        const result = await skill.execute({});
        const data = (result as {data?: {tasks: unknown[]; note: string}}).data!;
        expect(data.tasks).toHaveLength(1);
        expect(data.note).toContain("1 个");
    });
});
