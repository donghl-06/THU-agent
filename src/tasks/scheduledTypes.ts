export interface TaskSchedule {
    frequency: "once" | "daily" | "weekly";
    /** All schedules use Asia/Shanghai (UTC+8), independent of the browser/server timezone. */
    time: string;
    date?: string;
    /** ISO weekday: Monday = 1, Sunday = 7. */
    weekdays?: number[];
}

export interface ScheduledTaskInput {
    title: string;
    prompt: string;
    schedule: TaskSchedule;
}

export interface ScheduledTask extends ScheduledTaskInput {
    id: string;
    createdAt: number;
    updatedAt: number;
    enabled: boolean;
    nextRunAt?: number;
}

export type TaskRunStatus = "running" | "completed" | "failed" | "needs_attention" | "cancelled" | "interrupted" | "missed";

export interface ScheduledRun {
    id: string;
    taskId: string;
    title: string;
    prompt: string;
    sessionId?: string;
    trigger: "scheduled" | "manual";
    scheduledAt: number;
    startedAt: number;
    finishedAt?: number;
    status: TaskRunStatus;
    summary?: string;
}

export interface ScheduledState {
    tasks: ScheduledTask[];
    runs: ScheduledRun[];
}

export interface ScheduledSnapshot extends ScheduledState {
    busy: boolean;
}
