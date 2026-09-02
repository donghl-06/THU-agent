/**
 * sceneMatch 单测：场景关键词的精确 + 模糊匹配。
 * 背景：平台场景名有错别字"北体兵乓球"，"乒乓球"必须能模糊命中（2026-09-02 实测）。
 */
import {describe, expect, it} from "vitest";
import {matchScenes, withinEditDistance1} from "../../src/skills/sports/sceneMatch";

const SCENES = [
    {sceneName: "综体操房"},
    {sceneName: "北体兵乓球"}, // 平台原文即错别字
    {sceneName: "西体台球"},
    {sceneName: "气膜馆羽毛球"},
    {sceneName: "北体篮球"},
    {sceneName: "北体壁球"},
    {sceneName: "东网球场"},
    {sceneName: "陈明游泳馆"},
];

describe("withinEditDistance1", () => {
    it("等长一处不同", () => {
        expect(withinEditDistance1("乒乓球", "兵乓球")).toBe(true);
        expect(withinEditDistance1("乒乓球", "冰乓球")).toBe(true);
        expect(withinEditDistance1("乒乓球", "篮球场")).toBe(false);
    });
    it("长度差一的删/插", () => {
        expect(withinEditDistance1("羽毛球", "羽毛球馆")).toBe(true);
        expect(withinEditDistance1("网球", "网球场")).toBe(true);
        expect(withinEditDistance1("台球", "台球场馆")).toBe(false);
    });
    it("完全相同", () => {
        expect(withinEditDistance1("台球", "台球")).toBe(true);
    });
});

describe("matchScenes", () => {
    it("精确子串优先", () => {
        const {exact, fuzzy} = matchScenes(SCENES, "羽毛球");
        expect(exact.map((s) => s.sceneName)).toEqual(["气膜馆羽毛球"]);
        expect(fuzzy).toEqual([]);
    });

    it("乒乓球模糊命中错别字场景'北体兵乓球'（2026-09-02 用户实测 bug）", () => {
        const {exact, fuzzy} = matchScenes(SCENES, "乒乓球");
        expect(exact).toEqual([]);
        expect(fuzzy.map((s) => s.sceneName)).toEqual(["北体兵乓球"]);
    });

    it("有精确命中时不做模糊（'台球'不误伤'北体篮球'/'北体壁球'）", () => {
        const {exact, fuzzy} = matchScenes(SCENES, "台球");
        expect(exact.map((s) => s.sceneName)).toEqual(["西体台球"]);
        expect(fuzzy).toEqual([]);
    });

    it("完全无关的关键词不命中", () => {
        const {exact, fuzzy} = matchScenes(SCENES, "攀岩");
        expect(exact).toEqual([]);
        expect(fuzzy).toEqual([]);
    });
});
