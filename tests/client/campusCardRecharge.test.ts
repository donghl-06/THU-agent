import {beforeEach, describe, expect, it, vi} from "vitest";
import {CardRechargeType} from "@thu-info/lib/dist/models/card/recharge";
import {LibError, LoginError} from "@thu-info/lib/dist/utils/error";
import {ThuClient} from "../../src/client/ThuClient";

const library = vi.hoisted(() => ({login: vi.fn(), recharge: vi.fn()}));
vi.mock("@thu-info/lib", () => ({
    InfoHelper: class {
        login = library.login;
        rechargeCampusCard = library.recharge;
    },
}));

function client(): ThuClient {
    return new ThuClient({}, {username: "synthetic-user", password: "synthetic-password", fingerprint: "0".repeat(32)});
}

describe("ThuClient 银行卡充值适配（无网络）", () => {
    beforeEach(() => {
        library.login.mockReset().mockResolvedValue(undefined);
        library.recharge.mockReset().mockResolvedValue(undefined);
    });

    it("完成登录后调用 Bank 通道，接受空返回值", async () => {
        await expect(client().rechargeCampusCardBank(100)).resolves.toBeUndefined();
        expect(library.login).toHaveBeenCalledTimes(1);
        expect(library.recharge).toHaveBeenCalledTimes(1);
        expect(library.recharge).toHaveBeenCalledWith(100, "", CardRechargeType.Bank);
        expect(library.login.mock.invocationCallOrder[0]).toBeLessThan(library.recharge.mock.invocationCallOrder[0]);
    });

    it("登录失败不发起扣款", async () => {
        library.login.mockRejectedValue(new LoginError("synthetic-login-failure"));
        await expect(client().rechargeCampusCardBank(100)).rejects.toMatchObject({code: "AUTH_FAILED"});
        expect(library.recharge).not.toHaveBeenCalled();
    });

    it("付款超时只执行一次，不套用登录重试", async () => {
        library.recharge.mockRejectedValue(Object.assign(new Error("synthetic-timeout"), {name: "FetchError", code: "ETIMEDOUT"}));
        await expect(client().rechargeCampusCardBank(100)).rejects.toMatchObject({code: "TIMEOUT"});
        expect(library.recharge).toHaveBeenCalledTimes(1);
    });

    it("依赖抛出的业务错误正常传回上层", async () => {
        library.recharge.mockRejectedValue(new LibError("synthetic-bank-error"));
        await expect(client().rechargeCampusCardBank(100)).rejects.toMatchObject({code: "LIB_ERROR"});
        expect(library.recharge).toHaveBeenCalledTimes(1);
    });
});
