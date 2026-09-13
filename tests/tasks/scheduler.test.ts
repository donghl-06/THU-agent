/**
 * 任务调度器单测：注入假时钟与假执行器，直接调 tick() 验证各类任务行为。
 * 不真 setInterval、不碰网络。
 */
import {describe, expect, it} from "vitest";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {TaskScheduler, type SchedulerHooks} from "../../src/tasks/scheduler";
import {TaskStore} from "../../src/tasks/taskStore";
import type {AgentTask, BookingTask, MonitorTask} from "../../src/tasks/types";

function makeHooks(now: () => number) {
    const notifications: {task: AgentTask; message: string}[] = [];
    const hooks: SchedulerHooks = {
        notify: (task, message) => notifications.push({task, message}),
        executeBooking: async (task: BookingTask) => `已下单：${JSON.stringify(task.input)}`,
        checkMonitor: async (task: MonitorTask) => ({triggered: false, message: "电量充足"}),
        now,
    };
    return {hooks, notifications};
}

describe("TaskScheduler", () => {
    it("reminder 到点通知并结束；未到点不执行", async () => {
        let t = 1_000_000;
        const {hooks, notifications} = makeHooks(() => t);
        const s = new TaskScheduler(hooks);
        const task = s.add({kind: "reminder", title: "去抢场", sessionId: "s1", nextRunAt: t + 1000});
        await s.tick();
        expect(notifications).toHaveLength(0);
        t += 1001;
        await s.tick();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toBe("去抢场");
        expect(s.get(task.id)?.done).toBe(true);
    });

    it("booking 到点执行注入的执行器并把结果通知出去", async () => {
        let t = 1_000_000;
        const {hooks, notifications} = makeHooks(() => t);
        const s = new TaskScheduler(hooks);
        s.add({
            kind: "booking",
            title: "明早6点抢气膜馆羽毛球",
            sessionId: "s1",
            nextRunAt: t + 60_000,
            toolName: "book_sports_field",
            input: {resourceName: "气膜馆羽毛球", sessionStart: "06:00", payType: "PAY_ONLINE"},
        });
        t += 61_000;
        await s.tick();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toContain("气膜馆羽毛球");
        expect(notifications[0].message).toContain("06:00");
    });

    it("过期超过宽限期的 booking 不执行，只通知过期", async () => {
        let t = 1_000_000;
        const {hooks, notifications} = makeHooks(() => t);
        const s = new TaskScheduler(hooks);
        s.add({kind: "booking", title: "很久前的抢场", sessionId: "s1", nextRunAt: t + 1000, toolName: "book_sports_field", input: {}});
        t += 1000 + 11 * 60_000; // 超过 10 分钟宽限
        await s.tick();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].message).toContain("已过期");
        expect(notifications[0].message).not.toContain("已下单");
    });

    it("monitor 未触发按间隔顺延，触发后通知并结束", async () => {
        let t = 1_000_000;
        const hooks = makeHooks(() => t);
        let triggered = false;
        hooks.hooks.checkMonitor = async () => ({triggered, message: "电量不足 10 度"});
        const s = new TaskScheduler(hooks.hooks);
        s.add({kind: "monitor", title: "电费监控", sessionId: "s1", nextRunAt: t, monitor: "electricity", thresholdKwh: 10, intervalMinutes: 60});
        await s.tick();
        expect(hooks.notifications).toHaveLength(0);
        const task = s.list()[0] as MonitorTask;
        expect(task.nextRunAt).toBe(1_000_000 + 60 * 60_000); // 顺延 60 分钟
        triggered = true;
        t += 60 * 60_000;
        await s.tick();
        expect(hooks.notifications).toHaveLength(1);
        expect(hooks.notifications[0].message).toContain("电量不足");
        expect(s.list()[0].done).toBe(true);
    });

    it("执行器异常转失败通知，不炸调度循环", async () => {
        let t = 1_000_000;
        const hooks = makeHooks(() => t);
        hooks.hooks.executeBooking = async () => { throw new Error("网络挂了"); };
        const s = new TaskScheduler(hooks.hooks);
        s.add({kind: "booking", title: "会炸的抢场", sessionId: "s1", nextRunAt: t, toolName: "book_sports_field", input: {}});
        await s.tick();
        expect(hooks.notifications).toHaveLength(1);
        expect(hooks.notifications[0].message).toContain("网络挂了");
        expect(s.list()[0].done).toBe(true);
    });

    it("cancel 后不再执行；persist 后新实例可恢复任务", async () => {
        let t = 1_000_000;
        const file = join(tmpdir(), `thu-tasks-test-${Date.now()}-${randomUUID().slice(0, 6)}.json`);
        const store = new TaskStore(file);
        const hooks = makeHooks(() => t);
        const s = new TaskScheduler(hooks.hooks, store);
        const task = s.add({kind: "reminder", title: "别提醒我", sessionId: "s1", nextRunAt: t + 500});
        s.cancel(task.id);
        t += 600;
        await s.tick();
        expect(hooks.notifications).toHaveLength(0);

        // 新实例从文件恢复（cancel 状态也被保留）
        const s2 = new TaskScheduler(makeHooks(() => t).hooks, store);
        const restored = s2.get(task.id);
        expect(restored?.cancelled).toBe(true);
    });
});
