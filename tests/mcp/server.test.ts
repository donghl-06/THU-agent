import {describe, expect, it} from "vitest";
import {createMcpServer} from "../../src/mcp/server";
import {ok, type Skill} from "../../src/skills/base/types";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        name: "demo_read",
        description: "离线测试工具",
        inputSchema: {type: "object", properties: {}, required: []},
        execute: async (input) => ok({input}),
        ...overrides,
    };
}

describe("MCP server", () => {
    it("negotiates initialization and lists read-only skills", async () => {
        const server = createMcpServer({
            skills: [fakeSkill()],
            includeBuiltInTools: false,
        });
        const initialized = await server.handleRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {protocolVersion: "2024-11-05"},
        });
        expect(initialized?.result).toMatchObject({
            protocolVersion: "2024-11-05",
            capabilities: {tools: {listChanged: false}},
        });

        const listed = await server.handleRequest({jsonrpc: "2.0", id: 2, method: "tools/list"});
        expect(listed?.result).toMatchObject({tools: [{name: "demo_read", annotations: {readOnlyHint: true}}]});
    });

    it("executes a read-only tool and returns MCP content", async () => {
        const server = createMcpServer({skills: [fakeSkill()], includeBuiltInTools: false});
        const response = await server.handleRequest({
            jsonrpc: "2.0",
            id: "call-1",
            method: "tools/call",
            params: {name: "demo_read", arguments: {hello: "world"}},
        });
        expect(response?.result).toMatchObject({
            content: [{type: "text"}],
        });
        expect(JSON.stringify(response)).toContain("world");
    });

    it("hides write skills by default and rejects them when explicitly listed", async () => {
        let callCount = 0;
        const write = fakeSkill({
            name: "demo_write",
            requiresConfirmation: true,
            execute: async () => {
                callCount += 1;
                return ok({});
            },
        });
        const hidden = createMcpServer({skills: [write], includeBuiltInTools: false});
        const hiddenList = await hidden.handleRequest({jsonrpc: "2.0", id: 1, method: "tools/list"});
        expect(JSON.stringify(hiddenList)).not.toContain("demo_write");

        const listed = createMcpServer({
            skills: [write],
            includeBuiltInTools: false,
            includeWriteTools: true,
        });
        const response = await listed.handleRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {name: "demo_write", arguments: {}},
        });
        expect(JSON.stringify(response)).toContain("CONFIRMATION_REQUIRED");
        expect(callCount).toBe(0);
    });

    it("does not answer notifications", async () => {
        const server = createMcpServer({skills: [], includeBuiltInTools: false});
        await expect(server.handleRequest({jsonrpc: "2.0", method: "notifications/initialized"})).resolves.toBeUndefined();
    });
});
