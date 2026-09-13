/**
 * get_dorm_score 独立测试：假 ThuClient，验证正常返回带图、上游失败友好降级。
 */
import {describe, expect, it} from "vitest";
import {ThuError} from "../../src/client/errors";
import {createGetDormScoreSkill} from "../../src/skills/dorm/getDormScore";

const okClient = {getDormScore: async () => "base64jpegdata".repeat(20)};
const skill = createGetDormScoreSkill(okClient);

describe("get_dorm_score", () => {
    it("正常：返回带 imagesBase64 的结果与说明", async () => {
        const result = await skill.execute({});
        expect(result.success).toBe(true);
        const data = (result as {data?: {imagesBase64?: string[]; note?: string}}).data;
        expect(data?.imagesBase64).toHaveLength(1);
        expect(data?.imagesBase64?.[0]).toContain("base64jpegdata");
        expect(data?.note).toContain("公示图");
    });

    it("上游 LIB_ERROR（如 DormAuthError 归一化后无 message）→ DORM_SCORE_UNAVAILABLE 友好提示", async () => {
        // ThuClient.call 会把 lib 的 DormAuthError 归一化成无 message 的 LIB_ERROR
        const skill2 = createGetDormScoreSkill({getDormScore: async () => { throw new ThuError("LIB_ERROR", ""); }});
        const result = await skill2.execute({});
        expect(result.success).toBe(false);
        const err = (result as {error?: {code: string; message: string}}).error!;
        expect(err.code).toBe("DORM_SCORE_UNAVAILABLE");
        expect(err.message).toContain("公示图");
    });

    it("网络错误保留原错误码与消息", async () => {
        const skill2 = createGetDormScoreSkill({
            getDormScore: async () => { throw new ThuError("NETWORK_ERROR", "网络请求失败", undefined); },
        });
        const result = await skill2.execute({});
        expect(result.success).toBe(false);
        expect((result as {error?: {code: string}}).error?.code).toBe("NETWORK_ERROR");
    });

    it("返回内容过短视为空图", async () => {
        const skill2 = createGetDormScoreSkill({getDormScore: async () => "x"});
        const result = await skill2.execute({});
        expect(result.success).toBe(false);
        expect((result as {error?: {code: string}}).error?.code).toBe("DORM_SCORE_UNAVAILABLE");
    });
});
