/**
 * 体育场景关键词匹配：精确子串优先，无精确命中时启用模糊匹配。
 *
 * 背景（2026-09-02 用户实测）：平台场景名本身有错别字——"北体兵乓球"（兵≠乒），
 * 严格 `sceneName.includes("乒乓球")` 永远匹配失败，导致查询/预约都找不到乒乓球场馆，
 * 上层模型还会对失败编造"不在提前预约范围内"之类的错误解释。
 *
 * 模糊策略：场景名的任意 len-1/len/len+1 宽度滑动窗口与关键词编辑距离 ≤1。
 * 只在精确匹配为空时启用（用户输入"台球"精确命中时不会误伤"北体篮球"）。
 */

/** 编辑距离 ≤ 1 判定：等长时恰一处不同，或长度差一且删/插一字符后相等 */
export function withinEditDistance1(a: string, b: string): boolean {
    if (a === b) return true;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    let j = 0;
    let diff = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++diff > 1) return false;
        if (la !== lb) {
            if (la > lb) i++;
            else j++;
        } else {
            i++;
            j++;
        }
    }
    return true;
}

/** 场景名的滑动窗口与关键词是否编辑距离 ≤1（容忍前后缀与一处错别字） */
function fuzzyHit(keyword: string, name: string): boolean {
    for (let w = Math.max(1, keyword.length - 1); w <= keyword.length + 1; w++) {
        for (let s = 0; s + w <= name.length; s++) {
            if (withinEditDistance1(keyword, name.slice(s, s + w))) return true;
        }
    }
    return false;
}

export interface SceneName {
    sceneName: string;
}

/**
 * 关键词匹配场景。精确子串命中直接用；否则返回模糊命中（可能为空）。
 * exact.length > 0 时调用方应忽略 fuzzy（避免"台球"误伤"篮球"这类近似噪声）。
 */
export function matchScenes<T extends SceneName>(scenes: T[], keyword: string): {exact: T[]; fuzzy: T[]} {
    const exact = scenes.filter((s) => s.sceneName.includes(keyword));
    if (exact.length > 0) return {exact, fuzzy: []};
    return {exact, fuzzy: scenes.filter((s) => fuzzyHit(keyword, s.sceneName))};
}
