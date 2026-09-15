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

test("输入框工具精简、权限菜单支持键盘和持久化，手机菜单不溢出", async ({page}) => {
    await page.goto("/");
    const composer = page.locator(".composer");
    await expect(composer.getByText("校园助手", {exact: true})).toHaveCount(0);
    await expect(composer.getByText(/Shift \+ Enter/)).toHaveCount(0);
    await expect(composer.locator("input[type=file]")).toHaveCount(1);
    await expect(page.getByRole("button", {name: "添加附件"}).locator(".lucide-cross")).toBeVisible();
    expect(await page.locator(".composer-send-actions > button").evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")))).toEqual(["语音输入", "发送消息"]);
    const picker = page.getByRole("button", {name: "访问模式：请求批准"});
    await expect(picker.locator(".lucide-hand")).toBeVisible();
    await picker.focus();
    await picker.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", {name: /^请求批准/})).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitemradio", {name: /完全访问/})).toBeFocused();
    await page.keyboard.press("Enter");
    const full = page.getByRole("button", {name: "访问模式：完全访问"});
    await expect(full).toBeFocused();
    await expect(full.locator(".lucide-shield-alert")).toBeVisible();
    await expect(full).toHaveClass(/full-access/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(full).toBeVisible();
    await full.click();
    await expect(page.getByRole("menuitemradio", {name: /完全访问/})).toHaveAttribute("aria-checked", "true");
    await page.screenshot({path: "docs/screenshots/web-access-modes.png", animations: "disabled"});
    await page.keyboard.press("Escape");
    await expect(full).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", {name: "切换到深色模式"}).click();
    await page.setViewportSize({width: 390, height: 844});
    await full.click();
    await page.screenshot({path: "docs/screenshots/web-access-modes-mobile.png", animations: "disabled"});
    const bounds = await page.getByRole("menu").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".toolbar").click();
    await expect(page.getByRole("menu")).toHaveCount(0);
});

test("完全访问不弹批准框、不提交确认请求，切回请求批准立即恢复", async ({page}) => {
    const decisions: boolean[] = [];
    const modes: string[] = [];
    page.on("request", request => {
        if (request.url().endsWith("/api/confirm")) decisions.push(request.postDataJSON().approved);
        if (request.url().endsWith("/api/chat")) modes.push(request.postDataJSON().accessMode);
    });
    await page.goto("/");
    await login(page);
    const input = page.getByRole("textbox", {name: "发送给清灵的消息"});
    await input.fill("预约一个测试座位");
    await input.press("Enter");
    await expect(page.getByRole("dialog", {name: "确认这次操作"})).toBeVisible();
    await expect(page.getByRole("button", {name: "访问模式：请求批准"})).toBeDisabled();
    await page.getByRole("dialog").getByRole("button", {name: "取消", exact: true}).click();
    await expect(page.getByText("已取消，未执行预约。")).toBeVisible();
    await page.getByRole("button", {name: "访问模式：请求批准"}).click();
    await page.getByRole("menuitemradio", {name: /完全访问/}).click();
    await input.fill("完全访问下预约测试座位");
    await input.press("Enter");
    await expect(page.getByText("测试预约已确认。")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(decisions).toEqual([false]);
    await page.reload();
    await expect(page.getByRole("button", {name: "访问模式：完全访问"})).toBeVisible();
    await page.getByRole("button", {name: "访问模式：完全访问"}).click();
    await page.getByRole("menuitemradio", {name: /^请求批准/}).click();
    await input.fill("重新请求批准后预约测试座位");
    await input.press("Enter");
    await expect(page.getByRole("dialog", {name: "确认这次操作"})).toBeVisible();
    await page.getByRole("button", {name: "确认执行"}).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(decisions).toEqual([false, true]);
    expect(modes).toEqual(["request-approval", "full-access", "request-approval"]);
});

test("Token 用量与复制操作同时在消息悬停和键盘焦点时显示", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("今天的课表");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.locator(".usage")).toHaveText("384 tokens");
    await page.locator(".toolbar").hover();
    await expect(page.locator(".usage")).toHaveCSS("opacity", "0");
    await expect(page.locator(".message-actions")).toHaveCSS("opacity", "0");
    await page.locator(".assistant-message").hover();
    await expect(page.locator(".usage")).toHaveCSS("opacity", "1");
    await expect(page.locator(".message-actions")).toHaveCSS("opacity", "1");
    await page.locator(".toolbar").hover();
    await page.getByRole("button", {name: "复制回答"}).focus();
    await expect(page.locator(".usage")).toHaveCSS("opacity", "1");
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).focus();
    await expect(page.locator(".usage")).toHaveCSS("opacity", "0");
});

test("完全访问统一应用于界面操作，删除和退出不再弹出确认框", async ({page}) => {
    await page.addInitScript(() => localStorage.setItem("thu-assistant-sessions-v1", JSON.stringify({activeId: "s_fixture", sessions: [{id: "s_fixture", title: "测试对话", createdAt: 1, messages: [{role: "user", text: "测试"}, {role: "bot", text: "测试回复"}]}]})));
    await page.goto("/");
    await login(page);
    await page.getByRole("button", {name: "访问模式：请求批准"}).click();
    await page.getByRole("menuitemradio", {name: /完全访问/}).click();
    const deleted = page.waitForResponse("**/api/session/destroy");
    await page.getByRole("button", {name: "删除对话：测试对话", exact: true}).click();
    await deleted;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("测试回复", {exact: true})).not.toBeVisible();
    await page.getByRole("button", {name: /清华 Info 已连接校园服务/}).click();
    await expect(page.getByRole("button", {name: "登录", exact: true})).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("同一个附件入口可同时选择图片与文件", async ({page}) => {
    await page.route("**/api/upload?*", route => route.fulfill({json: {name: "作业.pdf", path: "/fixture/homework.pdf", sizeBytes: 12}}));
    await page.goto("/");
    await login(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", {name: "添加附件"}).click();
    await (await chooser).setFiles([
        {name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==", "base64")},
        {name: "作业.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture file")},
    ]);
    await expect(page.getByAltText("待发送图片 1")).toBeVisible();
    await expect(page.locator(".file-attachment")).toHaveText("作业.pdf");
    const request = page.waitForRequest("**/api/chat");
    await page.getByRole("button", {name: "发送消息"}).click();
    const body = (await request).postDataJSON();
    expect(body.images).toHaveLength(1);
    expect(body.question).toContain("/fixture/homework.pdf");
    await expect(page.locator(".markdown table")).toBeVisible();
});

test("流式输出保留处理状态，完成后显示 Markdown 和用量", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("今天有什么课？");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByRole("button", {name: "停止生成", exact: true})).toBeVisible();
    await expect(page.getByText("正在整理回答", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "收起处理过程"}).click();
    await expect(page.locator(".turn-timeline")).not.toBeVisible();
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".usage")).toHaveText("384 tokens");
    await expect(page.getByRole("button", {name: "停止生成", exact: true})).not.toBeVisible();
    await page.screenshot({path: "docs/screenshots/web-conversation.png", animations: "disabled"});
    await page.reload();
    await expect(page.locator(".markdown table")).toBeVisible();
    await expect(page.locator(".usage")).toHaveText("384 tokens");
});

test("Agent turn 按时序展示、完成自动折叠、可展开回看并保留到历史", async ({page, context}) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("时序：查课表和教室");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByText("先确认今天的课程，再核对空闲时段。", {exact: true})).toBeVisible();
    await expect(page.getByText("已经获取课程，继续核对教室安排。", {exact: true})).toBeVisible();
    await expect(page.getByText("先确认今天的课程，再核对空闲时段。", {exact: true})).not.toBeVisible();
    await expect(page.locator(".tool-step").nth(0)).toHaveClass(/done/);
    await expect(page.locator(".tool-step").nth(1)).toHaveClass(/error/);
    await expect(page.getByText("信息已核对，整理最终安排。", {exact: true})).toBeVisible();
    await expect(page.locator(".timeline-text").last()).toContainText("下午 15:05 后可以安排自习。");
    const kinds = ["reasoning", "text", "tool", "tool", "reasoning", "text", "tool", "reasoning", "text"];
    expect(await page.locator(".timeline-item").evaluateAll(items => items.map(item => item.getAttribute("data-kind")))).toEqual(kinds);
    await expect(page.locator(".agent-turn")).toHaveAttribute("data-status", "running");
    await expect(page.getByRole("button", {name: "收起处理过程"})).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({path: "docs/screenshots/web-turn-streaming.png", animations: "disabled"});
    await expect(page.locator(".agent-turn")).toHaveAttribute("data-status", "completed");
    await expect(page.getByRole("button", {name: "展开处理过程"})).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".turn-timeline")).not.toBeVisible();
    await expect(page.locator(".turn-answer")).toHaveText("今天有 2 节课。下午 15:05 后可以安排自习。");
    await expect(page.getByText("我先查一下今天的课表。", {exact: true})).not.toBeVisible();
    await page.screenshot({path: "docs/screenshots/web-turn-completed.png", animations: "disabled"});
    await page.getByRole("button", {name: "展开处理过程"}).click();
    await expect(page.getByText("我先查一下今天的课表。", {exact: true})).toBeVisible();
    expect(await page.locator(".timeline-item").evaluateAll(items => items.map(item => item.getAttribute("data-kind")))).toEqual(kinds.slice(0, -1));
    await page.locator(".reasoning-heading").first().click();
    await expect(page.getByText("先确认今天的课程，再核对空闲时段。", {exact: true})).toBeVisible();
    await expect(page.locator(".turn-answer")).toHaveCount(1);
    await page.screenshot({path: "docs/screenshots/web-turn-expanded.png", animations: "disabled"});
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.locator(".turn-answer")).toBeVisible();
    await expect(other.locator(".turn-timeline")).not.toBeVisible();
    await other.close();
    await page.reload();
    await expect(page.locator(".turn-timeline")).not.toBeVisible();
    await page.getByRole("button", {name: "展开处理过程"}).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("课程已查到，我再确认一下教室。", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "切换到深色模式"}).click();
    await page.setViewportSize({width: 390, height: 844});
    await expect(page.locator(".turn-answer .markdown")).toBeVisible();
    await page.screenshot({path: "docs/screenshots/web-turn-mobile-dark.png", animations: "disabled"});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test("纯思考期间停止，历史保留思考且不会标为已完成", async ({page}) => {
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("时序停止");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByText("先确认今天的课程，再核对空闲时段。", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "停止生成", exact: true}).click();
    await expect(page.locator(".agent-turn")).toHaveAttribute("data-status", "cancelled");
    await expect(page.getByText("已停止", {exact: true})).toBeVisible();
    await expect(page.locator(".turn-answer")).toHaveCount(0);
    await page.reload();
    await page.locator(".reasoning-heading").click();
    await expect(page.getByText("先确认今天的课程，再核对空闲时段。", {exact: true})).toBeVisible();
    await expect(page.getByText("已停止", {exact: true})).toBeVisible();
});

test("流中断保留部分正文和工具错误，不自动折叠为完成", async ({page}) => {
    await page.route("**/api/chat", route => route.fulfill({contentType: "text/event-stream", body: [
        ["reasoning", {text: "准备查询"}], ["tool", {phase: "start", name: "get_schedule", toolCallId: "broken"}],
        ["tool", {phase: "end", name: "get_schedule", toolCallId: "broken", success: false}], ["token", {text: "已收到的部分回复。"}],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("")}));
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("查课表");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.locator(".agent-turn")).toHaveAttribute("data-status", "error");
    await expect(page.getByText("已收到的部分回复。", {exact: true})).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("连接已中断");
    await expect(page.locator(".tool-step")).toHaveClass(/error/);
    await page.reload();
    await expect(page.getByText("未完成", {exact: true})).toBeVisible();
    await expect(page.getByText("已收到的部分回复。", {exact: true})).toBeVisible();
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
    await page.getByLabel("选择附件").setInputFiles({name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==", "base64")});
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

test("文件上传不依赖视觉模型，发送保留文件上下文且历史只显示文件名", async ({page}) => {
    await page.route("**/api/capabilities", route => route.fulfill({json: {vision: false}}));
    await page.route("**/api/upload?*", route => route.fulfill({json: {name: "作业.pdf", path: "/fixture/uploads/homework.pdf", sizeBytes: 12}}));
    await page.route("**/api/chat", route => route.fulfill({contentType: "text/event-stream", body: 'event: answer\ndata: {"text":"已收到文件，请说明用途。"}\n\nevent: done\ndata: {}\n\n'}));
    await page.goto("/");
    await login(page);
    await expect(page.getByRole("button", {name: "添加附件"})).toBeVisible();
    await page.getByLabel("选择附件", {exact: true}).setInputFiles({name: "作业.pdf", mimeType: "application/pdf", buffer: Buffer.from("fixture file")});
    await expect(page.locator(".file-attachment")).toHaveText("作业.pdf");
    await expect(page.getByRole("button", {name: "发送消息"})).toBeEnabled();
    await expect(page.locator(".attachments")).toHaveCSS("opacity", "1");
    await page.screenshot({path: "docs/screenshots/web-file-upload.png", animations: "disabled"});
    const sent = page.waitForRequest("**/api/chat");
    await page.getByRole("button", {name: "发送消息"}).click();
    expect((await sent).postDataJSON().question).toContain("/fixture/uploads/homework.pdf");
    await expect(page.locator(".user-message")).toHaveText("📎 作业.pdf");
    await expect(page.locator(".markdown")).toHaveText("已收到文件，请说明用途。");
    await expect(page.locator(".file-attachment")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("thu-assistant-sessions-v1"))).not.toContain("/fixture/uploads/");
    await page.reload();
    await expect(page.locator(".user-message")).toHaveText("📎 作业.pdf");
});

test("切换对话丢弃未完成上传，空文件与上传失败不进入附件", async ({page}) => {
    let finishUpload: (() => Promise<void>) | undefined;
    await page.route("**/api/upload?*", async route => {
        await new Promise<void>(resolve => { finishUpload = async () => { await route.fulfill({json: {name: "旧文件.pdf", path: "/fixture/old.pdf", sizeBytes: 1}}); resolve(); }; });
    });
    await page.goto("/");
    await login(page);
    const picker = page.getByLabel("选择附件", {exact: true});
    await picker.setInputFiles({name: "空文件.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0)});
    await expect(page.getByText("「空文件.pdf」是空文件", {exact: true})).toBeVisible();
    const started = page.waitForRequest("**/api/upload?*");
    await picker.setInputFiles({name: "旧文件.pdf", mimeType: "application/pdf", buffer: Buffer.from("x")});
    await started;
    await expect(page.getByRole("button", {name: "发送消息"})).toBeDisabled();
    await page.getByRole("button", {name: "新建对话"}).click();
    await expect.poll(() => Boolean(finishUpload)).toBe(true);
    await finishUpload!();
    await expect(page.locator(".file-attachment")).toHaveCount(0);
    await page.route("**/api/upload?*", route => route.fulfill({status: 500}));
    await picker.setInputFiles({name: "失败.pdf", mimeType: "application/pdf", buffer: Buffer.from("x")});
    await expect(page.getByText("上传「失败.pdf」失败，请重试", {exact: true})).toBeVisible();
    await expect(page.locator(".file-attachment")).toHaveCount(0);
});

test("临时图片可查看原图，删除失败可重试，过期图片显示说明", async ({page}) => {
    let deletes = 0;
    await page.route("**/api/temp-image/fixture", route => {
        if (route.request().method() === "DELETE") return route.fulfill({status: ++deletes === 1 ? 500 : 200});
        return route.fulfill({contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==", "base64")});
    });
    await page.route("**/api/temp-image/expired", route => route.fulfill({status: 404}));
    await page.route("**/api/chat", route => route.fulfill({contentType: "text/event-stream", body: `event: answer\ndata: ${JSON.stringify({text: "![邮件图片](/api/temp-image/fixture)\n\n![过期图片](/api/temp-image/expired)"})}\n\nevent: done\ndata: {}\n\n`}));
    await page.goto("/");
    await login(page);
    await page.getByRole("textbox", {name: "发送给清灵的消息"}).fill("查看邮件图片");
    await page.getByRole("button", {name: "发送消息"}).click();
    await expect(page.getByAltText("邮件图片", {exact: true})).toBeVisible();
    await expect(page.locator('.inline-image a[href="/api/temp-image/fixture"]')).toHaveAttribute("target", "_blank");
    expect(deletes).toBe(0);
    await expect(page.locator(".image-note")).toHaveCount(1);
    await page.getByRole("button", {name: "已用完，删除图片"}).click();
    await expect(page.getByRole("alert")).toHaveText("删除失败，请重试");
    await expect(page.getByAltText("邮件图片", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "已用完，删除图片"}).click();
    await expect(page.getByAltText("邮件图片", {exact: true})).not.toBeVisible();
    await expect(page.locator(".image-note")).toHaveCount(2);
    await page.getByRole("button", {name: "切换到深色模式"}).click();
    await expect(page.getByAltText("邮件图片", {exact: true})).not.toBeVisible();
    expect(deletes).toBe(2);
});

test("语音输入替换选区并保留光标之后的内容", async ({page}) => {
    await page.addInitScript(() => {
        class Recognition {
            onresult?: (event: unknown) => void;
            start() { (window as unknown as {emitSpeech: (text: string) => void}).emitSpeech = text => this.onresult?.({results: [{isFinal: true, 0: {transcript: text}}]}); }
            stop() {}
            abort() {}
        }
        Object.assign(window, {SpeechRecognition: Recognition});
    });
    await page.goto("/");
    const input = page.getByRole("textbox", {name: "发送给清灵的消息"});
    await input.fill("明天旧内容上课");
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 5));
    await page.getByRole("button", {name: "语音输入", exact: true}).click();
    await page.evaluate(() => (window as unknown as {emitSpeech: (text: string) => void}).emitSpeech("下午"));
    await expect(input).toHaveValue("明天 下午 上课");
    expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(5);
    await page.getByRole("button", {name: "停止语音输入", exact: true}).click();
});
