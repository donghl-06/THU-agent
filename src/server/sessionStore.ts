/**
 * 会话持久化（Step 21c）：sessionId → messages 落 JSON 文件，进程重启后恢复。
 *
 * 单用户本地应用：同步整写足够（会话小、写入频率=人发消息的频率）；
 * 临时文件 + rename 保证写一半崩溃不会损坏旧文件。
 * 持久化内容经过净化：图片 parts 只留文字（base64 不落盘，恢复后旧图
 * 本来也该被发送视图裁掉），system 消息不存（恢复时换用新 systemPrompt，
 * 旧的可能带着过期日期）。
 */
import {mkdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import type {ChatMessage} from "../harness/types";

/** 单会话持久化消息条数上限（保护文件体积；上下文另有发送视图裁剪） */
const MAX_PERSISTED_MESSAGES = 200;

export class SessionStore {
    private readonly file: string;
    private readonly data: Map<string, ChatMessage[]>;

    constructor(filePath: string) {
        this.file = filePath;
        this.data = SessionStore.readFile(filePath);
    }

    private static readFile(filePath: string): Map<string, ChatMessage[]> {
        try {
            const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
            const map = new Map<string, ChatMessage[]>();
            for (const [id, msgs] of Object.entries(raw)) {
                if (Array.isArray(msgs) && msgs.every((m) => m && typeof (m as ChatMessage).role === "string")) {
                    map.set(id, msgs as ChatMessage[]);
                }
            }
            return map;
        } catch {
            return new Map(); // 无文件/损坏：空开始，不因持久化层失败影响服务
        }
    }

    get(sessionId: string): ChatMessage[] | undefined {
        return this.data.get(sessionId);
    }

    set(sessionId: string, messages: ChatMessage[]): void {
        const cleaned = SessionStore.sanitize(messages);
        if (cleaned.length === 0) {
            this.data.delete(sessionId);
        } else {
            this.data.set(sessionId, cleaned);
        }
        this.flush();
    }

    delete(sessionId: string): void {
        if (!this.data.delete(sessionId)) return;
        this.flush();
    }

    clear(): void {
        if (this.data.size === 0) return;
        this.data.clear();
        this.flush();
    }

    /** 持久化前净化：去 system、图片 parts 归并为纯文本、截断条数 */
    static sanitize(messages: ChatMessage[]): ChatMessage[] {
        return messages
            .filter((m) => m.role !== "system")
            .slice(-MAX_PERSISTED_MESSAGES)
            .map((m) => {
                if (!Array.isArray(m.content)) return m;
                const text = m.content
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("\n");
                return {...m, content: text || "[图片消息]"};
            });
    }

    private flush(): void {
        try {
            mkdirSync(dirname(this.file), {recursive: true});
            const tmp = `${this.file}.tmp`;
            writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data)));
            renameSync(tmp, this.file);
        } catch {
            // 持久化失败不影响服务（内存态仍可用），不向外抛
        }
    }
}
