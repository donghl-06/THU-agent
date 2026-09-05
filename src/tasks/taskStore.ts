/**
 * 任务持久化（Step 23）：tasks → data/tasks.json。
 * 与 SessionStore 同款策略：同步整写 + 临时文件 rename，写坏不损旧文件。
 */
import {mkdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import type {AgentTask} from "./types";

/** 落盘任务上限（超出先淘汰已完成的） */
const MAX_TASKS = 100;

export class TaskStore {
    private readonly file: string;

    constructor(filePath: string) {
        this.file = filePath;
    }

    load(): Map<string, AgentTask> {
        try {
            const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, AgentTask>;
            const map = new Map<string, AgentTask>();
            for (const [id, task] of Object.entries(raw)) {
                if (task && typeof task.id === "string" && typeof task.kind === "string") {
                    map.set(id, task);
                }
            }
            return map;
        } catch {
            return new Map();
        }
    }

    save(tasks: Map<string, AgentTask>): void {
        try {
            mkdirSync(dirname(this.file), {recursive: true});
            // 超限时先淘汰已完成/已取消的，再按最旧的淘汰
            const entries = [...tasks.entries()];
            if (entries.length > MAX_TASKS) {
                entries
                    .filter(([, t]) => t.done || t.cancelled)
                    .slice(0, entries.length - MAX_TASKS)
                    .forEach(([id]) => tasks.delete(id));
            }
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(tasks)));
            renameSync(tmp, this.file);
        } catch {
            // 持久化失败不影响内存态调度
        }
    }
}
