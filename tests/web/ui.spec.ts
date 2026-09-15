import {expect, test, type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";

async function login(page: Page, username = "2000000001") {
    await page.getByRole("button", {name: "登录", exact: true}).click();
    const dialog = page.getByRole("dialog", {name: "连接清华 Info"});
    await dialog.getByLabel("学号").fill(username);
    await dialog.getByLabel("密码").fill("fixture-password");
    await dialog.getByRole("button", {name: "登录", exact: true}).click();
    if (username !== "2000000000") await expect(dialog).not.toBeVisible();
}

test.beforeEach(async ({page, request}) => {
    await request.post("/api/auth/logout", {data: {}});
    await page.addInitScript(() => { localStorage.setItem("snd", "0"); });
});

test("桌面浅色/深色界面、Lucide 图标与偏好持久化", async ({page}) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await expect(page.getByRole("heading", {name: "今天，有什么可以帮你？"})).toBeVisible();
    await expect(page.getByRole("button", {name: "发送消息"})).toBeDisabled();
    await expect(page.locator("svg:not(.lucide)")).toHaveCount(0);
    await mkdir("docs/screenshots", {recursive: true});
    await expect(page.locator(".suggestions")).toHaveCSS("opacity", "1");
    await expect(page.locator(".composer")).toHaveCSS("opacity", "1");
    await page.screenshot({path: "docs/screenshots/web-desktop-light.png", animations: "disabled"});
    await page.getByRole("button", {name: "切换到深色模式"}).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({path: "docs/screenshots/web-desktop-dark.png", animations: "disabled"});
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", {name: "收起侧栏"}).click();
    await expect(page.getByRole("button", {name: "展开侧栏"})).toBeVisible();
    await page.getByRole("button", {name: "展开侧栏"}).click();
    await expect(page.getByRole("button", {name: "新建对话"})).toBeVisible();
    expect(errors).toEqual([]);
});

test("未登录隐藏历史，登录恢复，退出不删除历史", async ({page}) => {
    await page.addInitScript(() => localStorage.setItem("thu-assistant-sessions-v1", JSON.stringify({activeId: "s_old", sessions: [{id: "s_old", title: "之前的课表", createdAt: 1, messages: [{role: "user", text: "查询课表"}, {role: "bot", text: "历史回答仅登录后可见"}]}]})));
    await page.goto("/");
    await expect(page.getByText("历史回答仅登录后可见")).not.toBeVisible();
    await login(page);
    await expect(page.getByText("历史回答仅登录后可见")).toBeVisible();
    await page.getByRole("button", {name: /清华 Info 已连接校园服务/}).click();
    await page.getByRole("button", {name: "确认退出"}).click();
    await expect(page.getByText("历史回答仅登录后可见")).not.toBeVisible();
    await login(page);
    await expect(page.getByText("历史回答仅登录后可见")).toBeVisible();
});

test("流式输出保留处理状态，完成后显示 Markdown 和用量", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("今天有什么课？");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByRole("button", {name: "停止生成", exact: true})).toBeVisible();
    await expect(page.getByText("正在整理回答", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "收起处理过程"}).click();
    await expect(page.locator("#thinking-steps")).not.toBeVisible();
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".usage")).toHaveText("384 tokens");
    await expect(page.getByRole("button", {name: "停止生成", exact: true})).not.toBeVisible();
    await page.screenshot({path: "docs/screenshots/web-conversation.png", animations: "disabled"});
    await page.reload();
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".usage")).toHaveText("384 tokens");
});

test("停止生成会等待后端取消，可立即发送下一问", async ({page}) => {
    await page.goto("/");
    await login(page);
    const input = page.getByRole("textbox", {name: "发送给清灵的消息"});
    await input.fill("测试停止生成");
    await input.press("Enter");
    await expect(page.getByText("正在整理回答", {exact: true})).toBeVisible();
    const cancelled = page.waitForResponse("**/api/chat/cancel");
    await page.getByRole("button", {name: "停止生成", exact: true}).click();
    await cancelled;
    await expect(page.getByRole("button", {name: "发送消息"})).toBeVisible();
    await input.fill("今天课表");
    await input.press("Enter");
    await expect(page.locator(".markdown table")).toBeVisible();
});

test("真实确认桥：取消不执行，确认才提交 approved=true", async ({page}) => {
    await page.goto("/");
    await login(page);
    const decisions: boolean[] = [];
    page.on("request", req => { if (req.url().endsWith("/api/confirm")) decisions.push(req.postDataJSON().approved); });
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("预约一个图书馆座位");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByRole("dialog", {name: "确认这次操作"})).toBeVisible();
    await expect(page.getByText("A101", {exact: true})).toBeVisible();
    expect(decisions).toEqual([]);
    await page.getByRole("dialog").getByRole("button", {name: "取消", exact: true}).click();
    await expect(page.getByText("已取消，未执行预约。")).toBeVisible();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(decisions).toEqual([false]);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("重新预约一个座位");
    await page.getByRole("button", {name: "发送消息"}).click();
    await page.getByRole("button", {name: "确认执行"}).click();
    await expect(page.getByText("测试预约已确认。")).toBeVisible();
    expect(decisions).toEqual([false, true]);
});

test("侧栏搜索、调宽、删除与跨标签页历史同步", async ({page, context}) => {
    await page.goto("/");
    await login(page);
    const input = page.getByRole("textbox", {name: "发送给清灵的消息"});
    await input.fill("查课程安排");
    await input.press("Enter");
    await expect(page.locator(".markdown table")).toBeVisible();
    const separator = page.getByRole("separator", {name: "调节侧栏宽度"});
    await separator.focus();
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "280");
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.locator(".markdown table")).toBeVisible();
    await page.getByRole("button", {name: "新建对话"}).click();
    await input.fill("校园第二问");
    await input.press("Enter");
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(other.getByRole("button", {name: "校园第二问", exact: true})).toBeVisible();
    await page.getByRole("button", {name: "搜索对话"}).click();
    await page.getByRole("textbox", {name: "搜索历史对话"}).fill("第二问");
    await expect(page.getByRole("button", {name: "查课程安排", exact: true})).not.toBeVisible();
    await page.getByRole("button", {name: "删除对话：校园第二问", exact: true}).click();
    await page.getByRole("dialog").getByRole("button", {name: "删除对话", exact: true}).click();
    await expect(other.getByRole("button", {name: "校园第二问", exact: true})).not.toBeVisible();
    await other.close();
});

test("离线缓存包含 React 依赖，断网重载后显示后台未运行", async ({browser}) => {
    const context = await browser.newContext({serviceWorkers: "allow"});
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3461/");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect(page.getByRole("heading", {name: "今天，有什么可以帮你？"})).toBeVisible();
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("dialog", {name: "清灵后台未运行"})).toBeVisible({timeout: 12000});
    await context.close();
});

test("模型原始 HTML 不执行，日历附件可以下载", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.route("**/api/chat", route => route.fulfill({contentType: "text/event-stream", body: [
        ["calendar", {title: "测试预约", filename: "test.ics", icsContent: "BEGIN:VCALENDAR\nEND:VCALENDAR"}],
        ["answer", {text: '安全回答 <img src="invalid" onerror="window.__unsafe = true"> [链接](javascript:alert(1))'}],
        ["done", {}],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}));
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("导出日历");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.locator(".markdown")).toContainText("安全回答");
    await expect(page.locator(".markdown img")).toHaveCount(0);
    await expect(page.locator('.markdown a[href^="javascript:"]')).toHaveCount(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", {name: "下载日历"}).click();
    expect((await download).suggestedFilename()).toBe("test.ics");
});

test("二次认证方式、验证码和密码清理", async ({page}) => {
    await page.goto("/");
    await login(page, "2000000000");
    await expect(page.getByRole("dialog", {name: "验证你的身份"})).toBeVisible();
    await page.getByRole("button", {name: /验证器动态码/}).click();
    await page.getByLabel("验证码", {exact: true}).fill("123456");
    await page.getByRole("button", {name: "提交验证码"}).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fixture-password");
});

test("手机布局、抽屉、弹窗焦点和减少动态效果", async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.emulateMedia({reducedMotion: "reduce"});
    await page.goto("/");
    await expect(page.getByRole("heading", {name: "今天，有什么可以帮你？"})).toBeVisible();
    await expect(page.locator(".suggestions")).toHaveCSS("opacity", "1");
    await expect(page.locator(".composer")).toHaveCSS("opacity", "1");
    await page.screenshot({path: "docs/screenshots/web-mobile.png", animations: "disabled"});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", {name: "展开侧栏"}).click();
    await expect(page.getByRole("button", {name: "新建对话"})).toBeVisible();
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await page.getByRole("button", {name: "登录", exact: true}).click();
    await expect(page.getByLabel("学号")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("button", {name: "登录", exact: true})).toBeFocused();
});

test("图片附件与输入法 Enter 不会误发", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.getByLabel("选择图片").setInputFiles({name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==", "base64")});
    await expect(page.getByAltText("待发送图片 1")).toBeVisible();
    await page.getByRole("button", {name: "移除图片 1"}).click();
    await expect(page.getByAltText("待发送图片 1")).not.toBeVisible();
    const input = page.getByRole("textbox", {name: "发送给清灵的消息"});
    await input.fill("中文输入中");
    await input.dispatchEvent("keydown", {key: "Enter", isComposing: true, keyCode: 229});
    await expect(page.getByRole("button", {name: "停止生成", exact: true})).not.toBeVisible();
    await expect(input).toHaveValue("中文输入中");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("中文输入中\n");
});
