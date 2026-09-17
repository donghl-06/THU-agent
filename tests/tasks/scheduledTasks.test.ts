import {describe, expect, it, vi} from "vitest";
import {nextScheduledAt, ScheduledTasks, validateScheduledInput} from "../../src/tasks/scheduledTasks";
import type {ScheduledState, ScheduledTaskInput} from "../../src/tasks/scheduledTypes";

const start = Date.parse("2026-09-16T07:59:00+08:00");
const input: ScheduledTaskInput = {title: "今日课表", prompt: "查询今天的课程", schedule: {frequency: "daily", time: "08:00"}};

function fixture(initial?: ScheduledState) {
    let now = start;
    let saved = initial;
    let available = true;
    const execute = vi.fn(async () => ({status: "completed" as const, summary: "课表已整理"}));
    const scheduler = new ScheduledTasks({load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); },
        now: () => now, canRun: () => available, execute});
    return {scheduler, execute, time: (value: number) => { now = value; }, available: (value: boolean) => { available = value; }, saved: () => saved!};
}

describe("scheduled Agent tasks", () => {
    it("calculates daily and weekly schedules in Shanghai regardless of process timezone", () => {
        expect(nextScheduledAt(input.schedule, start)).toBe(start + 60_000);
        expect(nextScheduledAt(input.schedule, start + 60_000)).toBe(start + 60_000 + 86_400_000);
        expect(nextScheduledAt({frequency: "weekly", time: "08:00", weekdays: [1, 5]}, start)).toBe(Date.parse("2026-09-18T08:00:00+08:00"));
        expect(nextScheduledAt({frequency: "weekly", time: "00:00", weekdays: [7]}, Date.parse("2026-09-19T23:59:00+08:00"))).toBe(Date.parse("2026-09-20T00:00:00+08:00"));
    });

    it.each([
        {...input, title: " "}, {...input, prompt: ""}, {...input, schedule: {frequency: "daily", time: "24:00"}},
        {...input, schedule: {frequency: "daily", time: ["08:00"]}},
        {...input, schedule: {frequency: "weekly", time: "08:00", weekdays: []}},
        {...input, schedule: {frequency: "weekly", time: "08:00", weekdays: [0]}},
        {...input, schedule: {frequency: "once", time: "08:00", date: "2027-02-30"}},
        {...input, schedule: {frequency: "once", time: "08:00", date: "2026-01-01"}},
    ])("rejects invalid scheduling input: %j", value => {
        expect(() => validateScheduledInput(value, start)).toThrow();
    });

    it("claims once, persists before execution, and guards overlapping ticks and manual runs", async () => {
        const f = fixture();
        const task = f.scheduler.create(input);
        let finish!: () => void;
        f.execute.mockImplementationOnce(async () => {
            expect(f.saved().runs[0].status).toBe("running");
            expect(f.saved().tasks[0].nextRunAt).toBe(start + 60_000 + 86_400_000);
            await new Promise<void>(resolve => { finish = resolve; });
            return {status: "completed", summary: "done"};
        });
        f.time(start + 60_000);
        const first = f.scheduler.tick();
        await Promise.resolve();
        await f.scheduler.tick();
        expect(() => f.scheduler.runNow(task.id)).toThrow();
        expect(f.execute).toHaveBeenCalledTimes(1);
        finish(); await first;
        expect(f.saved().runs[0].status).toBe("completed");
    });

    it("waits while chat is busy, skips old occurrences, and never catches up a backlog", async () => {
        const f = fixture();
        f.scheduler.create(input);
        f.available(false); f.time(start + 60_000);
        await f.scheduler.tick();
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.saved().runs).toHaveLength(0);
        f.time(start + 4 * 86_400_000); f.available(true);
        await f.scheduler.tick();
        expect(f.saved().runs[0].status).toBe("missed");
        expect(f.execute).not.toHaveBeenCalled();
        expect(f.saved().tasks[0].nextRunAt).toBe(start + 4 * 86_400_000 + 60_000);
    });

    it("manual execution preserves the schedule; paused tasks can run manually; deleting keeps history", async () => {
        const f = fixture();
        const task = f.scheduler.create(input);
        f.scheduler.toggle(task.id, false);
        const run = f.scheduler.runNow(task.id);
        await f.scheduler.whenIdle();
        expect(f.saved().tasks[0]).toMatchObject({enabled: false, nextRunAt: start + 60_000});
        f.scheduler.remove(task.id);
        expect(f.saved().tasks).toHaveLength(0);
        expect(f.saved().runs[0]).toMatchObject({id: run.id, title: input.title, trigger: "manual"});
        expect(f.scheduler.deleteRun(run.id)).toBe(run.sessionId);
        expect(f.saved().runs).toHaveLength(0);
    });

    it("finishes a one-time task and requires a future date to enable it again", async () => {
        const f = fixture();
        const task = f.scheduler.create({...input, schedule: {frequency: "once", time: "08:00", date: "2026-09-16"}});
        f.time(start + 60_000); await f.scheduler.tick();
        expect(f.saved().tasks[0]).toMatchObject({enabled: false, nextRunAt: undefined});
        expect(() => f.scheduler.toggle(task.id, true)).toThrow();
        f.scheduler.update(task.id, {...input, schedule: {frequency: "once", time: "08:00", date: "2026-09-17"}});
        f.scheduler.toggle(task.id, true);
        expect(f.saved().tasks[0].enabled).toBe(true);
    });

    it("recovers interrupted runs without replay and continues future repetitions", async () => {
        const f = fixture();
        f.scheduler.create(input);
        const state = f.saved();
        state.runs.push({id: "run", taskId: state.tasks[0].id, title: "title", prompt: "prompt", scheduledAt: start, startedAt: start, status: "running", trigger: "manual"});
        const restored = fixture(state);
        expect(restored.saved().runs[0].status).toBe("interrupted");
        expect(restored.execute).not.toHaveBeenCalled();
        restored.time(start + 60_000); await restored.scheduler.tick();
        expect(restored.execute).toHaveBeenCalledTimes(1);
    });

    it("stops the active run, blocks deletion while running, and records errors without leaking details", async () => {
        const f = fixture();
        const task = f.scheduler.create(input);
        f.execute.mockRejectedValueOnce(new Error("private service detail"));
        f.scheduler.runNow(task.id); await f.scheduler.whenIdle();
        expect(f.saved().runs[0].status).toBe("failed");
        expect(f.saved().runs[0].summary).not.toContain("private");
        const run = f.scheduler.runNow(task.id);
        expect(() => f.scheduler.remove(task.id)).toThrow();
        expect(() => f.scheduler.deleteRun(run.id)).toThrow();
        f.scheduler.cancelRun(run.id); await f.scheduler.whenIdle();
        expect(f.saved().runs[0].status).toBe("cancelled");
    });
});
