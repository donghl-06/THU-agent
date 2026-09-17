/**
 * CloudFileStore —— 云盘大文件/普通文件的对话内预览通道。
 *
 * 图片会优先下载到 TempImageStore；视频、音频和普通文件不整包落盘，
 * 只登记云盘签发的访问 URL，由本地服务按 Range 请求代理流式内容。
 * 用户点“删除预览”后注销 token；历史里保留的是随机本地 URL，不泄露云盘直链。
 */
import {randomUUID} from "node:crypto";

export interface CloudFileEntry {
    token: string;
    /** 清华云盘文件服务器签发的临时访问链接。 */
    accessUrl: string;
    filename: string;
    mediaType: "video" | "audio" | "file";
}

interface Registered extends CloudFileEntry {
    createdAt: number;
}

const MAX_ENTRIES = 128;

export class CloudFileStore {
    private readonly entries = new Map<string, Registered>();

    put(accessUrl: string, filename: string, mediaType: CloudFileEntry["mediaType"]): {token: string; url: string} {
        if (!/^https?:\/\//i.test(accessUrl)) throw new Error("invalid cloud access URL");
        const token = randomUUID();
        this.entries.set(token, {token, accessUrl, filename, mediaType, createdAt: Date.now()});
        this.evictOldest();
        return {token, url: `/api/cloud-file/${token}`};
    }

    peek(token: string): CloudFileEntry | undefined {
        const entry = this.entries.get(token);
        if (!entry) return undefined;
        const {createdAt: _createdAt, ...rest} = entry;
        return rest;
    }

    consume(token: string): boolean {
        return this.entries.delete(token);
    }

    get pendingCount(): number {
        return this.entries.size;
    }

    private evictOldest(): void {
        while (this.entries.size > MAX_ENTRIES) {
            const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
            if (!oldest) return;
            this.entries.delete(oldest.token);
        }
    }
}
