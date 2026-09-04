/**
 * THU Assistant MCP Server。
 *
 * 通过 MCP 的 stdio transport 把现有 THU Skill 暴露给 Codex、Claude
 * 等 MCP Host。MCP Server 只负责协议适配，不复制业务逻辑。
 *
 * 安全边界：
 * - 默认只暴露只读 Skill；预约、取消、充值等写 Skill 不会出现在工具列表中。
 * - 即使通过 includeWriteTools 显式列出写 Skill，也不会在没有确认通道时执行。
 * - 凭证只由本地 ThuClient 读取，绝不作为工具结果返回给 MCP Host。
 */
import {ThuClient} from "../client/ThuClient";
import {normalizeError} from "../client/errors";
import {createAllSkills} from "../skills";
import {fail, ok, type Skill, type SkillResult} from "../skills/base/types";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
    jsonrpc?: unknown;
    id?: JsonRpcId;
    method?: unknown;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export interface McpTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

interface ToolEntry {
    definition: McpTool;
    requiresConfirmation: boolean;
    execute: (input: unknown) => Promise<SkillResult>;
}

export interface McpServerOptions {
    /** 测试或宿主注入的 Skill；未提供时装配项目全部 Skill。 */
    skills?: Skill[];
    /** 测试或宿主注入的 ThuClient；未提供时创建本地客户端。 */
    thuClient?: ThuClient;
    /** 是否把写 Skill 列在 tools/list 中；默认 false。写 Skill 仍不会执行。 */
    includeWriteTools?: boolean;
    /** 是否加入 thu_login/get_user_info 等 MCP 专用工具；默认 true。 */
    includeBuiltInTools?: boolean;
    serverName?: string;
    serverVersion?: string;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function jsonText(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

function toolResult(result: SkillResult): {content: {type: "text"; text: string}[]; isError?: boolean} {
    const normalized = result.error?.code === "AUTH_REQUIRED"
        ? fail(
            "AUTH_REQUIRED",
            "当前设备尚未完成二次认证。请运行清华小助手 MCP 包中的“登录清华账号.cmd”，" +
            "按提示完成一次认证，然后回到 Agent 重试。",
        )
        : result;
    return {
        content: [{type: "text", text: jsonText(normalized)}],
        ...(normalized.success ? {} : {isError: true}),
    };
}

function failedCall(code: string, message: string): {content: {type: "text"; text: string}[]; isError: true} {
    return toolResult(fail(code, message)) as {content: {type: "text"; text: string}[]; isError: true};
}

function skillTool(skill: Skill): ToolEntry {
    const readOnly = !skill.requiresConfirmation;
    return {
        definition: {
            name: skill.name,
            description: skill.description,
            inputSchema: skill.inputSchema,
            annotations: {
                readOnlyHint: readOnly,
                destructiveHint: !readOnly,
                openWorldHint: true,
            },
        },
        requiresConfirmation: Boolean(skill.requiresConfirmation),
        execute: (input) => skill.execute(input),
    };
}

function builtInTools(client: ThuClient): ToolEntry[] {
    return [
        {
            definition: {
                name: "thu_login",
                description:
                    "使用本地 .env 中的清华 Info 凭证登录校园服务。" +
                    "凭证不会返回给 Codex。若账号触发二次认证，请先在清华小助手 Web/EXE 界面完成登录；" +
                    "MCP stdio 模式当前不会把验证码交互窗口直接弹到 Codex。",
                inputSchema: {type: "object", properties: {}, required: []},
                annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: true},
            },
            requiresConfirmation: false,
            execute: async () => {
                try {
                    await client.login();
                    return ok({authenticated: true, message: "清华校园服务登录成功。"});
                } catch (error) {
                    const normalized = normalizeError(error);
                    return fail(
                        normalized.code,
                        normalized.code === "AUTH_REQUIRED"
                            ? "当前设备尚未完成二次认证。请运行 MCP 包中的“登录清华账号.cmd”，认证成功后重试。"
                            : normalized.message,
                    );
                }
            },
        },
        {
            definition: {
                name: "get_user_info",
                description: "查询当前已登录清华 Info 账号的基本信息，用于确认本地登录态。",
                inputSchema: {type: "object", properties: {}, required: []},
                annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: true},
            },
            requiresConfirmation: false,
            execute: async () => {
                try {
                    return ok(await client.getUserInfo());
                } catch (error) {
                    const normalized = normalizeError(error);
                    return fail(normalized.code, normalized.message);
                }
            },
        },
    ];
}

function isNotification(request: JsonRpcRequest): boolean {
    return request.id === undefined;
}

export class McpServer {
    private readonly entries: Map<string, ToolEntry>;
    private readonly serverName: string;
    private readonly serverVersion: string;

    constructor(entries: ToolEntry[], opts: Pick<McpServerOptions, "serverName" | "serverVersion"> = {}) {
        this.entries = new Map(entries.map((entry) => [entry.definition.name, entry]));
        this.serverName = opts.serverName ?? "thu-assistant";
        this.serverVersion = opts.serverVersion ?? "0.1.0";
    }

    tools(): McpTool[] {
        return [...this.entries.values()].map((entry) => entry.definition);
    }

    async handleRequest(request: unknown): Promise<JsonRpcResponse | undefined> {
        const parsed = asObject(request) as JsonRpcRequest | undefined;
        if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
            if (!parsed || parsed.id === undefined) return undefined;
            return this.error(parsed.id, -32600, "Invalid Request");
        }

        const method = parsed.method;
        if (method === "notifications/initialized" || method === "notifications/cancelled" || method === "notifications/progress") {
            return undefined;
        }
        if (method === "ping") {
            return isNotification(parsed) ? undefined : this.success(parsed.id!, {});
        }
        if (method === "initialize") {
            const params = asObject(parsed.params);
            const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
            const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
                ? requested
                : DEFAULT_PROTOCOL_VERSION;
            return isNotification(parsed) ? undefined : this.success(parsed.id!, {
                protocolVersion,
                capabilities: {tools: {listChanged: false}},
                serverInfo: {name: this.serverName, version: this.serverVersion},
                instructions:
                    "清华校园查询工具已连接。实时校园数据必须通过工具获取；预约、取消和充值等写操作请使用清华小助手 Web/EXE 完成确认。",
            });
        }
        if (method === "tools/list") {
            return isNotification(parsed) ? undefined : this.success(parsed.id!, {tools: this.tools()});
        }
        if (method === "tools/call") {
            return isNotification(parsed) ? undefined : this.callTool(parsed.id!, parsed.params);
        }
        if (method === "resources/list") {
            return isNotification(parsed) ? undefined : this.success(parsed.id!, {resources: []});
        }
        if (method === "prompts/list") {
            return isNotification(parsed) ? undefined : this.success(parsed.id!, {prompts: []});
        }
        if (isNotification(parsed)) return undefined;
        return this.error(parsed.id!, -32601, `Method not found: ${method}`);
    }

    private async callTool(id: JsonRpcId, params: unknown): Promise<JsonRpcResponse> {
        const object = asObject(params);
        const name = object?.name;
        if (typeof name !== "string") return this.error(id, -32602, "tools/call requires a string parameter: name");
        const entry = this.entries.get(name);
        if (!entry) {
            return this.success(id, failedCall("UNKNOWN_TOOL", `没有名为 ${name} 的 MCP 工具。`));
        }
        if (entry.requiresConfirmation) {
            return this.success(id, failedCall(
                "CONFIRMATION_REQUIRED",
                "这是预约、取消或充值等写操作。MCP stdio 当前没有安全的用户确认通道，已拒绝执行；请在清华小助手 Web/EXE 界面完成该操作。",
            ));
        }
        try {
            const result = await entry.execute(object?.arguments ?? {});
            return this.success(id, toolResult(result));
        } catch (error) {
            return this.success(id, failedCall("TOOL_CRASH", `工具执行异常：${(error as Error).message}`));
        }
    }

    private success(id: JsonRpcId, result: unknown): JsonRpcResponse {
        return {jsonrpc: "2.0", id, result};
    }

    private error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
        return {jsonrpc: "2.0", id, error: {code, message}};
    }
}

export function createMcpServer(opts: McpServerOptions = {}): McpServer {
    const client = opts.thuClient ?? new ThuClient();
    const skills = opts.skills ?? createAllSkills({thuClient: client});
    const includeWriteTools = opts.includeWriteTools ?? process.env.THU_MCP_INCLUDE_WRITE_TOOLS === "1";
    const selected = skills.filter((skill) => includeWriteTools || !skill.requiresConfirmation).map(skillTool);
    const entries = opts.includeBuiltInTools === false ? selected : [...builtInTools(client), ...selected];
    return new McpServer(entries, opts);
}

/**
 * 启动 MCP stdio 主循环。
 * stdout 只能输出 JSON-RPC 消息；诊断信息必须写 stderr。
 */
export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
    const server = createMcpServer(opts);
    process.stdin.setEncoding("utf8");
    let buffer = "";
    for await (const chunk of process.stdin) {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            await handleLine(server, line);
        }
    }
    const finalLine = buffer.trim();
    if (finalLine) await handleLine(server, finalLine);
}

async function handleLine(server: McpServer, line: string): Promise<void> {
    if (!line) return;
    let request: unknown;
    try {
        request = JSON.parse(line);
    } catch {
        writeResponse({jsonrpc: "2.0", id: null, error: {code: -32700, message: "Parse error"}});
        return;
    }
    try {
        const response = await server.handleRequest(request);
        if (response) writeResponse(response);
    } catch (error) {
        const parsed = asObject(request);
        if (parsed && parsed.id !== undefined) {
            writeResponse({
                jsonrpc: "2.0",
                id: parsed.id as JsonRpcId,
                error: {code: -32603, message: (error as Error).message},
            });
        } else {
            console.error("MCP request failed:", error);
        }
    }
}

function writeResponse(response: JsonRpcResponse): void {
    process.stdout.write(`${JSON.stringify(response)}\n`);
}
