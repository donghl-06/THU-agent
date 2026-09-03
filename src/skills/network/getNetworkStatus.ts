/**
 * Skill: get_network_status —— 校园网（usereg 自助服务）余额与在线设备。
 *
 * Step 15 时因 usereg 图形验证码搁置；Step 22b 复活——超级鹰字符识别通道
 * 已由体育预约打通。登录链路在 UseregClient（独立 cookie jar）。
 * solver 未配置（无超级鹰）时给出明确指引而不是崩溃。
 */
import type {NetworkDevice, NetworkBalance, UseregClient} from "../../client/usereg";
import {UseregAuthError} from "../../client/usereg";
import {ThuError} from "../../client/errors";
import {fail, ok, type Skill, type SkillResult} from "../base/types";

export interface NetworkStatusData {
    balance: NetworkBalance;
    devices: NetworkDevice[];
    note: string;
}

type NetworkSource = Pick<UseregClient, "getStatus">;

export function createGetNetworkStatusSkill(client: NetworkSource): Skill {
    return {
        name: "get_network_status",
        description:
            "查询校园网账号状态：计费套餐、本月已用流量、已用时长、账户余额、结算日期，" +
            "以及当前在线设备列表（IP/MAC/登录时间/接入方式）。无参数。",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },

        async execute(): Promise<SkillResult<NetworkStatusData>> {
            try {
                const {balance, devices} = await client.getStatus();
                return ok({
                    balance,
                    devices,
                    note: devices.length === 0
                        ? "当前没有在线设备。"
                        : `共 ${devices.length} 台在线设备。`,
                });
            } catch (e) {
                if (e instanceof UseregAuthError) {
                    return fail("NETWORK_AUTH_REQUIRED", e.message);
                }
                if (e instanceof ThuError) {
                    return fail(e.code, e.message);
                }
                throw e;
            }
        },
    };
}
