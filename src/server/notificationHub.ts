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

    push(taskId: string, title: string, message: string): void {
        this.items.push({
            id: `n_${++this.seq}`,
            taskId,
            title,
            message,
            at: Date.now(),
        });
        if (this.items.length > MAX_KEEP) {
            this.items.splice(0, this.items.length - MAX_KEEP);
        }
    }

    /** 取走全部未读通知（消费即清空） */
    drain(): TaskNotification[] {
        const out = this.items;
        this.items = [];
        return out;
    }
}
