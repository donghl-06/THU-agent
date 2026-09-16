import {describe, expect, it} from "vitest";
import {parseEvent, readStream} from "../../src/web/lib/api";

describe("Web SSE 流", () => {
    it("跨 UTF-8 与 CRLF 分块仍正确还原，忽略心跳和损坏帧", async () => {
        const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: token\r\ndata: {"text":"清灵"}\r\n\r\nevent: token\ndata: broken\n\nevent: done\ndata: {}');
        const response = new Response(new ReadableStream({start(controller) {
            for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2));
            controller.close();
        }}));
        const events: string[] = [];
        await readStream(response, e => events.push(`${e.event}:${JSON.stringify(e.data)}`));
        expect(events).toEqual(['token:{"text":"清灵"}', 'done:{}']);
    });
    it("多行 data 帧可解析，不会把无 event 的帧当业务事件", () => {
        expect(parseEvent('event: answer\ndata: {\ndata: "text": "回答"}')).toEqual({event: "answer", data: {text: "回答"}});
        expect(parseEvent("data: {}" )).toBeNull();
    });
});
