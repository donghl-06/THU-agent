/**
 * get_network_status / UseregClient 测试。
 *
 * UseregClient 用本地 HTTP 服务器模拟 usereg 站点全流程（登录页 → 验证码 →
 * validate-user → 登录表单 → home 页），含 RSA 密文解密校验——
 * 不碰外网、不用真实账号。
 */
import {describe, expect, it} from "vitest";
import {createServer, type Server, type IncomingMessage, type ServerResponse} from "node:http";
import {generateKeyPairSync, privateDecrypt, constants} from "node:crypto";
import type {AddressInfo} from "node:net";
import {UseregClient, UseregAuthError, type NetworkCodeSolver} from "../../src/client/usereg";
import {createGetNetworkStatusSkill} from "../../src/skills/network/getNetworkStatus";

/** 本地假 usereg：记录请求、按脚本应答 */
function fakeUsereg(options: {
    publicKeyPem: string;
    privateKeyPem: string;
    captchaAnswer: string;
    validateResults?: boolean[]; // 依次每次 validate-user 的 success 值
}) {
    const requests: {path: string; body: string; decryptedPassword?: string}[] = [];
    let validateIndex = 0;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            void (async () => {
                const path = req.url ?? "/";
                requests.push({path, body, decryptedPassword: undefined});
                if (path === "/login" && req.method === "GET") {
                    res.setHeader("content-type", "text/html; charset=utf-8");
                    res.end(`<!DOCTYPE html><html><head><meta name="csrf-token" content="csrftoken123"></head>
<body><form id="login-form"><input type="hidden" name="_csrf-8800" value="formcsrf456">
<input type="text" id="loginform-username"><input type="password" id="loginform-password">
<input type="hidden" id="public" value="${options.publicKeyPem.replace(/\n/g, "\\n")}">
<input type="text" name="LoginForm[verifyCode]" id="loginform-verifycode"></form></body></html>`);
                } else if (path.startsWith("/site/captcha")) {
                    res.setHeader("content-type", "image/png");
                    res.end(Buffer.from("89504e47", "hex"));
                } else if (path === "/site/validate-user" && req.method === "POST") {
                    const params = new URLSearchParams(body);
                    const encrypted = params.get("LoginForm[password]") ?? "";
                    let decrypted = "";
                    try {
                        // Node 22 禁用 PKCS1 私钥解密：用 NO_PADDING 解出原始块再手动去 PKCS1 v1.5 填充
                        const block = privateDecrypt(
                            {key: options.privateKeyPem, padding: constants.RSA_NO_PADDING},
                            Buffer.from(encrypted, "base64"),
                        );
                        const sep = block.indexOf(0x00, 2);
                        decrypted = block.subarray(sep + 1).toString();
                    } catch { /* 解密失败保持空串 */ }
                    requests[requests.length - 1].decryptedPassword = decrypted;
                    const okResult = options.validateResults?.[validateIndex] ?? true;
                    validateIndex += 1;
                    res.setHeader("content-type", "application/json");
                    const code = new URLSearchParams(body).get("LoginForm[verifyCode]");
                    if (code !== options.captchaAnswer) {
                        res.end(JSON.stringify({success: false, message: "验证码错误"}));
                    } else {
                        res.end(JSON.stringify({success: okResult, message: okResult ? undefined : "账号或密码错误"}));
                    }
                } else if (path === "/login" && req.method === "POST") {
                    res.setHeader("location", "/home");
                    res.writeHead(302);
                    res.end();
                } else if (path === "/home") {
                    res.setHeader("content-type", "text/html; charset=utf-8");
                    res.end(`<!DOCTYPE html><html><body>
<div id="w3-container"><table><tbody><tr data-key="b1">
<td>学生包月</td><td>12.3G</td><td>101h</td><td>8.10 元</td><td>2026-09-01</td>
</tr></tbody></table></div>
<div id="w1-container"><table><tbody>
<tr data-key="101"><td>166.111.1.2</td><td></td><td>2026-09-03 08:00:00</td><td>h3c无线网(校内访问@tsinghua)</td><td>AA-BB-CC-DD-EE-FF</td></tr>
<tr data-key="102"><td>101.5.9.9</td><td>2402::1</td><td>2026-09-03 09:30:00</td><td>h3c有线网(校外访问策略)</td><td>11-22-33-44-55-66</td></tr>
</tbody></table></div>
</body></html>`);
                } else {
                    res.writeHead(404).end("not found");
                }
            })().catch((e) => {
                res.writeHead(500).end(String(e));
            });
        });
    });
    return {server, requests};
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const keys = generateKeyPairSync("rsa", {modulusLength: 2048});
const publicKeyForPage = keys.publicKey.export({type: "spki", format: "pem"}).toString();
const privateKeyPem = keys.privateKey.export({type: "pkcs1", format: "pem"}).toString();

const solverEcho: NetworkCodeSolver = async (img) => (img.length > 0 ? "abcd" : "");

describe("UseregClient 全链路（假站点）", () => {
    it("验证码正确：完整登录并解析余额与在线设备，密码 RSA 密文可被服务端解出", async () => {
        const fake = fakeUsereg({publicKeyPem: publicKeyForPage, privateKeyPem, captchaAnswer: "abcd"});
        const base = await listen(fake.server);
        const client = new UseregClient(solverEcho, "2024000000", "secret-pass", base);
        const status = await client.getStatus();

        expect(status.balance).toEqual({
            productName: "学生包月",
            usedBytes: "12.3G",
            usedSeconds: "101h",
            accountBalance: "8.10 元",
            settlementDate: "2026-09-01",
        });
        expect(status.devices).toHaveLength(2);
        expect(status.devices[0]).toEqual({
            ip4: "166.111.1.2", ip6: "", loggedAt: "2026-09-03 08:00:00",
            authPermission: "h3c无线网(校内访问@tsinghua)", mac: "AA-BB-CC-DD-EE-FF",
        });
        // validate-user 收到的密码密文可用测试私钥解出原文
        const validateReq = fake.requests.find((r) => r.path === "/site/validate-user");
        expect(validateReq?.decryptedPassword).toBe("secret-pass");
        // 登录表单提交带 _csrf-8800
        const loginPost = fake.requests.find((r) => r.path === "/login" && r.body.includes("_csrf-8800"));
        expect(loginPost).toBeDefined();
        await new Promise((r) => fake.server.close(r));
    });

    it("验证码识别错误：换图重试后成功", async () => {
        const fake = fakeUsereg({publicKeyPem: publicKeyForPage, privateKeyPem, captchaAnswer: "abcd"});
        const base = await listen(fake.server);
        let call = 0;
        const wrongThenRight: NetworkCodeSolver = async () => (call++ === 0 ? "wrong" : "abcd");
        const client = new UseregClient(wrongThenRight, "2024000000", "pw", base);
        const status = await client.getStatus();
        expect(status.devices).toHaveLength(2);
        const validateCalls = fake.requests.filter((r) => r.path === "/site/validate-user");
        expect(validateCalls).toHaveLength(2);
        await new Promise((r) => fake.server.close(r));
    });

    it("三次识别均失败：报登录失败并提示", async () => {
        const fake = fakeUsereg({publicKeyPem: publicKeyForPage, privateKeyPem, captchaAnswer: "abcd"});
        const base = await listen(fake.server);
        const client = new UseregClient(async () => "bad", "2024000000", "pw", base);
        await expect(client.getStatus()).rejects.toThrow(/已重试 3 次/);
        await new Promise((r) => fake.server.close(r));
    });
});

describe("get_network_status 技能层", () => {
    it("正常结果透传；UseregAuthError 转NETWORK_AUTH_REQUIRED", async () => {
        const skill = createGetNetworkStatusSkill({
            getStatus: async () => ({
                balance: {
                    productName: "学生", usedBytes: "1G", usedSeconds: "1h",
                    accountBalance: "9", settlementDate: "2026-09-01",
                },
                devices: [],
                note: "",
            }),
        });
        const result = await skill.execute({});
        expect(result.success).toBe(true);
        const data = (result as {data?: {devices: unknown[]; note: string}}).data!;
        expect(data.devices).toHaveLength(0);
        expect(data.note).toContain("没有在线设备");

        const failing = createGetNetworkStatusSkill({
            getStatus: async () => { throw new UseregAuthError("需要验证码"); },
        });
        const r2 = await failing.execute({});
        expect(r2.success).toBe(false);
        expect((r2 as {error?: {code: string}}).error?.code).toBe("NETWORK_AUTH_REQUIRED");
    });
});
