/**
 * 超级鹰（chaojiying）滑块拼图识别。
 *
 * 移植自用户旧项目 auto--badminton-booking-system 的 ChaojiyingSolver
 * （实战验证过的主力方案）：codetype 9900 上传背景图 → 返回若干候选缺口矩形
 * → 按"矩形高度 ≈ 拼图块高度"排序 → 调用方逐个 tryX 验证。
 *
 * 单次识别约 0.01 元。凭证从 .env 读（CJY_USER/CJY_PASSWORD/CJY_SOFT_ID）。
 */
import {config} from "../../config/env";
import type {CaptchaSolver} from "../../skills/sports/bookSportsField";

const API_URL = "https://upload.chaojiying.net/Upload/Processing.php";
const TIMEOUT_MS = 15_000;

/** 免依赖读 PNG 宽高（IHDR 固定在文件头 16-24 字节） */
function pngSize(base64: string): {width: number; height: number} {
    const raw = Buffer.from(base64, "base64");
    if (raw.length < 24 || raw.readUInt32BE(0) !== 0x89504e47) return {width: 0, height: 0};
    return {width: raw.readUInt32BE(16), height: raw.readUInt32BE(20)};
}

/** 上传背景图，返回按高度匹配度排序的候选缺口 X 坐标 */
async function queryCandidates(backgroundBase64: string, jigsawBase64: string): Promise<number[]> {
    const form = new FormData();
    form.append("user", config.chaojiying.user);
    form.append("pass", config.chaojiying.password);
    form.append("softid", config.chaojiying.softId);
    form.append("codetype", "9900");
    form.append(
        "userfile",
        new Blob([Buffer.from(backgroundBase64, "base64")], {type: "image/png"}),
        "bg.png",
    );
    const resp = await fetch(API_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await resp.json()) as {err_no?: number; err_str?: string; pic_str?: string};
    if (data.err_no !== 0 || !data.pic_str) {
        throw new Error(`超级鹰识别失败：[${data.err_no}] ${data.err_str ?? "空结果"}`);
    }
    // 缺口高度必然等于拼图块高度——按此排序候选
    const {height: jigsawH} = pngSize(jigsawBase64);
    return data.pic_str
        .split("|")
        .map((block) => block.split(",").map((v) => Number.parseInt(v.trim(), 10)))
        .filter((c) => c.length >= 2 && Number.isFinite(c[0]))
        .sort((a, b) => {
            const ha = a.length >= 4 ? Math.abs(Math.abs(a[3] - a[1]) - jigsawH) : 999;
            const hb = b.length >= 4 ? Math.abs(Math.abs(b[3] - b[1]) - jigsawH) : 999;
            return ha - hb;
        })
        .map((c) => c[0]);
}

/** 构造 CaptchaSolver：逐候选验证（旧项目的 retry 逻辑） */
export function createChaojiyingSolver(): CaptchaSolver {
    return async ({backgroundBase64, jigsawBase64, tryX}) => {
        const candidates = await queryCandidates(backgroundBase64, jigsawBase64);
        for (const x of candidates) {
            if (await tryX(x)) return x;
        }
        throw new Error(`超级鹰返回的 ${candidates.length} 个候选均未通过验证`);
    };
}

/**
 * 字符验证码识别（Step 22b 校园网登录用）：图 base64 → 识别文本。
 * codetype 1902 = 常见 4~6 位英文数字（usereg 登录验证码样式）。
 */
export function createChaojiyingCodeSolver(
    codetype = "1902",
): (imageBase64: string) => Promise<string> {
    return async (imageBase64) => {
        const form = new FormData();
        form.append("user", config.chaojiying.user);
        form.append("pass", config.chaojiying.password);
        form.append("softid", config.chaojiying.softId);
        form.append("codetype", codetype);
        form.append(
            "userfile",
            new Blob([Buffer.from(imageBase64, "base64")], {type: "image/png"}),
            "captcha.png",
        );
        const resp = await fetch(API_URL, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const data = (await resp.json()) as {err_no?: number; err_str?: string; pic_str?: string};
        if (data.err_no !== 0 || !data.pic_str) {
            throw new Error(`超级鹰识别失败：[${data.err_no}] ${data.err_str ?? "空结果"}`);
        }
        return data.pic_str.trim();
    };
}
