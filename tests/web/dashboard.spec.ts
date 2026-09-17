import {expect, test} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import type {DashboardSnapshot} from "../../src/shared/dashboard";

test.beforeEach(async ({request}) => {
    await request.post("/api/auth/logout");
    await request.post("/__fixture/reset");
});
test.afterEach(async ({request}) => { await request.post("/api/auth/logout"); });

test("状态看板导航、16 类查询、内容详情、筛选及深色外观", async ({page, request}) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await request.post("/api/auth/login", {data: {username: "2000000001", password: "synthetic"}});
    await page.goto("/");
    await page.getByRole("button", {name: "状态看板", exact: true}).click();
    await expect(page).toHaveURL(/#dashboard$/);
    await expect(page.getByRole("button", {name: "状态看板", exact: true})).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".toolbar")).toHaveCount(0);
    await expect(page.locator(".dashboard-panel")).toHaveCount(16);
    await expect(page.locator(".dashboard-stat").first()).toContainText("128.60");
    await expect(page.locator("#dashboard-network")).toContainText("验证码识别配置");
    await expect(page.locator(".dashboard-status")).toContainText("已获取 14 / 16 项");
    await mkdir("docs/screenshots", {recursive: true});
    await page.screenshot({path: "docs/screenshots/web-dashboard-light.png", animations: "disabled"});

    await page.locator("#dashboard-notices").getByRole("button", {name: /本周实验课安排与分组说明/}).click();
    await expect(page.getByRole("dialog")).toContainText("<script>alert('untrusted')</script>");
    await page.getByRole("button", {name: "关闭弹窗"}).click();
    await page.locator("#dashboard-news").getByRole("button", {name: /本科生选课调整/}).click();
    await expect(page.getByRole("dialog")).toContainText("离线测试资讯正文");
    await page.getByRole("button", {name: "关闭弹窗"}).click();
    await page.getByRole("tab", {name: "学习与教学"}).click();
    await expect(page.locator(".dashboard-panel")).toHaveCount(7);
    await page.getByRole("textbox", {name: "搜索看板"}).fill("第二章");
    await expect(page.locator(".dashboard-panel")).toHaveCount(1);
    await expect(page.locator(".dashboard-panel")).toContainText("最新课件");
    await page.getByRole("textbox", {name: "搜索看板"}).fill("");
    await page.getByRole("button", {name: /新建对话/}).click();
    await page.getByRole("button", {name: "切换到深色模式"}).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-transition");
    await page.getByRole("button", {name: "状态看板", exact: true}).click();
    await expect(page.locator(".dashboard-stat").first()).toContainText("128.60");
    await expect(page.locator(".dashboard-heading")).toHaveCSS("opacity", "1");
    const selectedNavigation = page.getByRole("button", {name: "状态看板", exact: true});
    await expect.poll(async () => {
        const button = await selectedNavigation.boundingBox();
        const selection = await selectedNavigation.locator(".session-selection").boundingBox();
        return button && selection ? Math.abs(button.y - selection.y) : Infinity;
    }).toBeLessThan(1);
    await page.screenshot({path: "docs/screenshots/web-dashboard-dark.png", animations: "disabled"});
    await page.reload();
    await expect(page.getByRole("heading", {name: "状态看板", exact: true})).toBeVisible();
    expect(errors).toEqual([]);
});

test("看板暂停刷新、后台隐藏、失败保留数据与手动重试", async ({page, request}) => {
    await page.clock.install();
    await request.post("/api/auth/login", {data: {username: "2000000001", password: "synthetic"}});
    await page.goto("/#dashboard");
    await expect(page.locator(".dashboard-status")).toContainText("已获取 14 / 16 项");
    let requests = 0;
    let fail = false;
    await page.route("**/api/dashboard*", route => {
        requests++;
        return fail ? route.fulfill({status: 503, body: "offline"}) : route.continue();
    });
    await page.clock.fastForward(16000);
    await expect.poll(() => requests).toBeGreaterThan(0);
    await expect(page.getByRole("button", {name: "刷新全部"})).toBeEnabled();
    await page.getByRole("checkbox", {name: "自动刷新"}).uncheck();
    await expect(page.locator(".dashboard-status")).toContainText("自动刷新已暂停");
    await expect(page.getByRole("button", {name: "刷新全部"})).toBeEnabled();
    const pausedRequests = requests;
    await page.clock.fastForward(60000);
    expect(requests).toBe(pausedRequests);

    fail = true;
    await page.getByRole("button", {name: "刷新全部"}).click();
    await expect(page.getByRole("alert")).toContainText("已有数据仍保留");
    await expect(page.locator(".dashboard-stat").first()).toContainText("128.60");
    fail = false;
    await page.getByRole("alert").getByRole("button", {name: "重试"}).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("checkbox", {name: "自动刷新"}).check();
    await expect(page.getByRole("button", {name: "刷新全部"})).toBeEnabled();
    await page.evaluate(() => { Object.defineProperty(document, "hidden", {value: true, configurable: true}); document.dispatchEvent(new Event("visibilitychange")); });
    const hiddenRequests = requests;
    await page.clock.fastForward(60000);
    expect(requests).toBe(hiddenRequests);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", {value: false, configurable: true}); document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(() => requests).toBeGreaterThan(hiddenRequests);
    await page.getByRole("button", {name: /新建对话/}).click();
    const leftRequests = requests;
    await page.clock.fastForward(60000);
    expect(requests).toBe(leftRequests);
});

test("未登录与移动端看板、空作业和过期数据标识", async ({page, request}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto("/#dashboard");
    await expect(page.getByText("连接清华账号后，查看课程、作业、校园资讯和生活服务状态。")).toBeVisible();
    await request.post("/api/auth/login", {data: {username: "2000000001", password: "synthetic"}});
    await page.reload();
    await expect(page.locator(".dashboard-status")).toContainText("已获取 14 / 16 项");
    const snapshot = await (await request.get("/api/dashboard?poll=1")).json() as DashboardSnapshot;
    const card = snapshot.panels.find(panel => panel.id === "card")!;
    card.status = "error"; card.error = "查询超时，可稍后刷新";
    const homework = snapshot.panels.find(panel => panel.id === "homework")!;
    homework.status = "empty"; homework.data = {items: []};
    await page.route("**/api/dashboard*", route => route.fulfill({json: snapshot}));
    await page.getByRole("button", {name: "刷新全部"}).click();
    await expect(page.locator(".dashboard-stat").first()).toContainText("上次成功");
    await expect(page.locator(".dashboard-stat").nth(2)).toContainText("0");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({path: "docs/screenshots/web-dashboard-mobile.png", animations: "disabled"});
    await page.getByRole("button", {name: "展开侧栏"}).click();
    await page.getByRole("button", {name: "定时任务", exact: true}).click();
    await expect(page).toHaveURL(/#tasks$/);
    await expect(page.getByRole("button", {name: "定时任务", exact: true})).toHaveAttribute("aria-current", "page");
});
