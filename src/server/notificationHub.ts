/**
 * 通知中心（Step 23）：scheduler 执行任务后把结果推到这里，
 * 前端 30s 轮询 /api/notifications 取走（drain 即消费）。
 * 单用户本机应用：内存级即可，进程重启丢通知可接受（任务本身已持久化）。
 */
import type {TaskNotification} from "../tasks/types";

const MAX_KEEP = 50;

export class NotificationHub {
    private items: TaskNotification[] = [];
    private seq = 0;
    private readonly waiters = new Set<(version: number) => void>();
    private readonly persistenceHooks = new Set<(notification: TaskNotification) => void>();

    push(taskId: string, title: string, message: string, sessionId?: string): void {
        const notification = {
            id: `n_${++this.seq}`,
            taskId,
            ...(sessionId ? {sessionId} : {}),
            title,
            message,
            at: Date.now(),
        };
        this.items.push(notification);
        if (this.items.length > MAX_KEEP) {
            this.items.splice(0, this.items.length - MAX_KEEP);
        }
        for (const persist of this.persistenceHooks) persist(notification);
        for (const wake of this.waiters) wake(this.seq);
    }

    /** 服务端把提醒回写到目标会话；前端轮询仍然负责即时展示。 */
    onPersist(hook: (notification: TaskNotification) => void): void {
        this.persistenceHooks.add(hook);
    }

    /** 取走全部未读通知（消费即清空） */
    drain(): TaskNotification[] {
        const out = this.items;
        this.items = [];
        return out;
    }

    /** 当前通知版本。桌面启动器用它做 long polling，不消费前端通知队列。 */
    version(): number {
        return this.seq;
    }

    /**
     * 等待 version 变化。桌面启动器只需要“有提醒到了”这个信号，
     * 具体提醒内容仍由浏览器通过 /api/notifications 取走。
     */
    waitForVersion(after: number, timeoutMs: number): Promise<number> {
        if (this.seq > after) return Promise.resolve(this.seq);
        return new Promise((resolve) => {
            let done = false;
            const finish = (version: number) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve(version);
            };
            const wake = finish;
            const timer = setTimeout(() => finish(this.seq), Math.max(0, timeoutMs));
            this.waiters.add(wake);
        });
    }
}
