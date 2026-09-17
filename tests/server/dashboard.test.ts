import {afterEach, describe, expect, it, vi} from "vitest";
import type {Server} from "node:http";
import type {AddressInfo} from "node:net";
import {DashboardService} from "../../src/server/dashboard";
import {createWebServer} from "../../src/server/webServer";
import {fail, ok, type Skill} from "../../src/skills/base/types";
import type {Agent} from "../../src/harness/agentLoop";
import {dashboardFixtureSkills} from "../../scripts/dashboard-fixture";
import type {DashboardSnapshot} from "../../src/shared/dashboard";
import {dashboardLink} from "../../src/shared/dashboard";

const services: DashboardService[] = [];
const servers: Server[] = [];
const make = (skills: Skill[], options: ConstructorParameters<typeof DashboardService>[1] = {}) => {
    const service = new DashboardService(skills, options);
    services.push(service);
    return service;
};
const settled = async (service: DashboardService) => {
    await vi.waitFor(() => expect(service.snapshot().panels.some(panel => panel.refreshing)).toBe(false));
    return service.snapshot().panels;
};
const card = () => dashboardFixtureSkills().find(skill => skill.name === "get_campus_card_info")!;

afterEach(async () => {
    services.splice(0).forEach(service => service.dispose());
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    vi.unstubAllEnvs();
});

describe("dashboard aggregation", () => {
    it("normalizes all 16 sources, exposes independent errors and never executes unlisted writes", async () => {
        const write = vi.fn(async () => ok({}));
        const service = make([...dashboardFixtureSkills(), {name: "recharge_campus_card", description: "write", inputSchema: {}, requiresConfirmation: true, execute: write}]);
        expect(service.snapshot(true).panels).toHaveLength(16);
        const panels = await settled(service);
        expect(panels.find(p => p.id === "card")?.data?.metrics?.[0].value).toBe("128.60");
        expect(panels.find(p => p.id === "homework")?.data?.items?.[0].attention).toBe(false);
        expect(panels.find(p => p.id === "network")).toMatchObject({status: "error", error: expect.stringContaining("验证码")});
        expect(panels.filter(p => p.status === "ready")).toHaveLength(14);
        expect(write).not.toHaveBeenCalled();
    });

    it("caches successes, coalesces requests, rate limits manual refresh, and retains stale data after failure", async () => {
        let now = Date.parse("2026-09-16T01:00:00Z");
        const skill = card();
        const execute = vi.fn(skill.execute);
        const service = make([{...skill, execute}], {now: () => now});
        service.snapshot(true); service.snapshot(true, "all");
        await settled(service);
        expect(execute).toHaveBeenCalledTimes(1);
        now += 5000;
        service.snapshot(true, "card"); await settled(service);
        expect(execute).toHaveBeenCalledTimes(1);
        now += 16000;
        execute.mockRejectedValueOnce(new Error("private upstream cookie=SECRET"));
        service.snapshot(true, "card");
        const panels = await settled(service);
        const stale = panels.find(panel => panel.id === "card")!;
        expect(stale.status).toBe("error");
        expect(stale.data?.metrics?.[0].value).toBe("128.60");
        expect(stale.updatedAt).toBe(now - 21000);
        expect(JSON.stringify(panels)).not.toContain("SECRET");
        now += 120001;
        service.snapshot(true); await settled(service);
        expect(execute).toHaveBeenCalledTimes(3);
        expect(service.snapshot().panels.find(p => p.id === "card")?.error).toBeUndefined();
    });

    it("fails closed if a displayed tool requires confirmation and treats no homework as empty", async () => {
        const execute = vi.fn(async () => ok({}));
        const service = make([{...card(), requiresConfirmation: true, execute}, {
            name: "get_learn_homework", description: "empty", inputSchema: {}, execute: async () => fail("NOT_FOUND", "no homework"),
        }]);
        service.snapshot(true);
        const panels = await settled(service);
        expect(panels.find(p => p.id === "card")?.status).toBe("unavailable");
        expect(panels.find(p => p.id === "homework")?.status).toBe("empty");
        expect(execute).not.toHaveBeenCalled();
    });

    it("bounds concurrency and continues other sources when one query times out, without duplicating it", async () => {
        let finish!: (value: ReturnType<typeof ok>) => void;
        const execute = vi.fn(() => new Promise<ReturnType<typeof ok>>(resolve => { finish = resolve; }));
        const service = make(dashboardFixtureSkills().map(skill => skill.name === "get_campus_card_info" ? {...skill, execute} : skill), {timeoutMs: 20});
        service.snapshot(true);
        const panels = await settled(service);
        expect(panels.find(p => p.id === "card")).toMatchObject({status: "error", error: expect.stringContaining("超时")});
        expect(panels.find(p => p.id === "schedule")?.status).toBe("ready");
        service.snapshot(true, "all");
        expect(execute).toHaveBeenCalledTimes(1);
        finish(ok({balance: 900}));
        await Promise.resolve();
        expect(service.snapshot().panels.find(p => p.id === "card")?.data).toBeUndefined();
    });

    it("does not query while paused, clears pending data on dispose and refreshes at Beijing midnight", async () => {
        let paused = true;
        let now = Date.parse("2026-09-16T15:59:00Z");
        const execute = vi.fn(card().execute);
        const service = make([{...card(), execute}], {now: () => now, canRun: () => !paused});
        expect(service.snapshot(true).paused).toBe(true);
        expect(execute).not.toHaveBeenCalled();
        paused = false;
        service.snapshot(true); await settled(service);
        now += 61000;
        service.snapshot(true); await settled(service);
        expect(execute).toHaveBeenCalledTimes(2);
        service.dispose();
        expect(service.snapshot(true).panels).toEqual([]);
    });

    it("only resolves cached news identifiers and excludes unsafe links", async () => {
        const skills = dashboardFixtureSkills();
        const news = skills.find(skill => skill.name === "get_campus_news_detail")!;
        const execute = vi.fn(news.execute);
        const service = make(skills.map(skill => skill === news ? {...skill, execute} : skill));
        service.snapshot(true); await settled(service);
        expect(await service.newsDetail("https://attacker.invalid/")).toBeUndefined();
        expect(execute).not.toHaveBeenCalled();
        expect(await service.newsDetail("fixture-news-1")).toMatchObject({content: expect.stringContaining("离线测试")});
        expect(dashboardLink("javascript:alert(1)")).toBeUndefined();
        expect(dashboardLink("https://user:pass@example.com/")).toBeUndefined();
        expect(dashboardLink("https://learn.tsinghua.edu.cn/")).toBe("https://learn.tsinghua.edu.cn/");
    });

    it("keeps at most four queries active and resumes a paused queue on passive polling", async () => {
        let busy = false;
        let active = 0;
        let peak = 0;
        const release: (() => void)[] = [];
        const service = make(dashboardFixtureSkills().map(skill => ({...skill, execute: async input => {
            active++;
            peak = Math.max(peak, active);
            await new Promise<void>(resolve => release.push(resolve));
            active--;
            return skill.execute(input);
        }})), {canRun: () => !busy});
        service.snapshot(true);
        expect(active).toBe(4);
        busy = true;
        release.splice(0).forEach(resolve => resolve());
        await vi.waitFor(() => expect(active).toBe(0));
        expect(service.snapshot().panels.some(panel => panel.refreshing)).toBe(true);
        busy = false;
        service.snapshot(false);
        expect(active).toBe(4);
        for (let i = 0; i < 16; i++) {
            release.splice(0).forEach(resolve => resolve());
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        await settled(service);
        expect(peak).toBe(4);
    });
});

describe("dashboard HTTP isolation", () => {
    async function start() {
        const factory = vi.fn(dashboardFixtureSkills);
        const server = createWebServer(() => ({login: async () => {}}) as Agent, {createDashboardSkills: factory});
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const login = async (username: string) => (await fetch(`${base}/api/auth/login`, {method: "POST", body: JSON.stringify({username, password: "synthetic"})})).text();
        return {base, factory, login};
    }

    it("requires authentication, returns no-store, and creates a fresh cache after logout/account change", async () => {
        vi.stubEnv("UI_TOKEN", "");
        const {base, factory, login} = await start();
        expect((await fetch(`${base}/api/dashboard`)).status).toBe(401);
        expect(factory).not.toHaveBeenCalled();
        await login("test-account-one");
        const response = await fetch(`${base}/api/dashboard`);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await response.json();
        expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({username: "test-account-one"}));
        await fetch(`${base}/api/auth/logout`, {method: "POST"});
        expect((await fetch(`${base}/api/dashboard?poll=1`)).status).toBe(401);
        await login("test-account-two");
        const state = await (await fetch(`${base}/api/dashboard?poll=1`)).json() as DashboardSnapshot;
        expect(state.panels.every(panel => !panel.data)).toBe(true);
        expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({username: "test-account-two"}));
    });

    it("honors the existing UI token guard", async () => {
        vi.stubEnv("UI_TOKEN", "synthetic-ui-token");
        const {base, factory} = await start();
        expect((await fetch(`${base}/api/dashboard`)).status).toBe(403);
        expect(factory).not.toHaveBeenCalled();
    });
});
