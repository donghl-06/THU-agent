/**
 * llmClient usage 统计单测：本地起一个假的 OpenAI 兼容端点，
 * 验证非流式/流式两种模式的 usage 解析与 stream_options 行为。
 * 不碰外网、不碰真实模型。
 */
import {afterEach, describe, expect, it} from "vitest";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import {createLlmClient} from "../../src/harness/llmClient";
import type {ChatMessage} from "../../src/harness/types";

let server: Server | undefined;
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** 起假端点并把 LLM_BASE_URL 指过去；handler 收到请求 body（JSON）自行应答 */
async function startEndpoint(handler: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<string> {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            try {
                handler(JSON.parse(body) as Record<string, unknown>, res);
            } catch (e) {
                res.writeHead(500).end(String(e));
            }
        });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    savedEnv.LLM_BASE_URL = process.env.LLM_BASE_URL;
    savedEnv.LLM_API_KEY = process.env.LLM_API_KEY;
    process.env.LLM_BASE_URL = base;
    process.env.LLM_API_KEY = "test-key";
    return base;
}

const messages: ChatMessage[] = [{role: "user", content: "你好"}];

describe("llmClient usage 统计", () => {
    it("非流式：解析响应里的 usage 并回调", async () => {
        await startEndpoint((_body, res) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({
                choices: [{message: {role: "assistant", content: "好"}}],
                usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15},
            }));
        });
        const client = createLlmClient();
        let usage: {promptTokens: number; completionTokens: number; totalTokens: number} | undefined;
        await client.chat(messages, [], undefined, (u) => { usage = u; });
        expect(usage).toEqual({promptTokens: 10, completionTokens: 5, totalTokens: 15});
    });

    it("非流式：端点没返回 usage 时不回调", async () => {
        await startEndpoint((_body, res) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({choices: [{message: {role: "assistant", content: "好"}}]}));
        });
        const client = createLlmClient();
        let called = false;
        await client.chat(messages, [], undefined, () => { called = true; });
        expect(called).toBe(false);
    });

    it("流式：请求带 stream_options.include_usage，并解析流末尾的 usage 块", async () => {
        let seenBody: Record<string, unknown> | undefined;
        await startEndpoint((body, res) => {
            seenBody = body;
            res.setHeader("content-type", "text/event-stream");
            res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
            // usage 块通常在流末尾（choices 为空数组或缺省）
            res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        });
        const client = createLlmClient();
        const tokens: string[] = [];
        let usage: {promptTokens: number; completionTokens: number; totalTokens: number} | undefined;
        const message = await client.chatStream!(messages, [], (t) => tokens.push(t), undefined, (u) => { usage = u; });
        expect(tokens.join("")).toBe("你");
        expect(message.content).toBe("你");
        expect(seenBody?.stream_options).toEqual({include_usage: true});
        expect(usage).toEqual({promptTokens: 7, completionTokens: 3, totalTokens: 10});
    });

    it("流式：端点不认识 stream_options（400 报该字段）时自动去掉重发", async () => {
        let requests = 0;
        await startEndpoint((body, res) => {
            requests += 1;
            if (requests === 1) {
                res.writeHead(400).end('{"error":{"message":"Unknown field: stream_options"}}');
                return;
            }
            // 第二次请求应已去掉 stream_options
            expect(body.stream_options).toBeUndefined();
            res.setHeader("content-type", "text/event-stream");
            res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
        });
        const client = createLlmClient();
        const message = await client.chatStream!(messages, [], () => {});
        expect(requests).toBe(2);
        expect(message.content).toBe("好");
    });
});
