import {readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const root = process.cwd();
const packageScript = readFileSync(join(root, "scripts", "package-win.mjs"), "utf8");
const launcherSource = readFileSync(join(root, "packaging", "WindowsLauncher", "Program.cs"), "utf8");

describe("Windows launcher packaging", () => {
    it("uses the .NET Framework compiler before falling back to SEA", () => {
        const frameworkBranch = packageScript.indexOf("} else if (existsSync(frameworkCompiler)) {");
        const seaBranch = packageScript.indexOf("} else {", frameworkBranch);

        expect(frameworkBranch).toBeGreaterThan(-1);
        expect(seaBranch).toBeGreaterThan(frameworkBranch);
        expect(packageScript).toContain("/codepage:65001");
        expect(packageScript.slice(frameworkBranch, seaBranch)).toContain("hasTrayLauncher = true");
    });

    it("launcher keeps a tray menu as the manual exit entry", () => {
        expect(launcherSource).toContain("new NotifyIcon");
        expect(launcherSource).toContain("ContextMenuStrip");
        expect(launcherSource).toContain("StopServer(child)");
    });

    it("prevents a second launcher from creating another tray instance", () => {
        expect(launcherSource).toContain("Local\\QingLing.SingleInstance");
        expect(launcherSource).toContain("ActivateExistingInstance()");
        expect(launcherSource).toContain("WaitForExistingInstance");
        expect(launcherSource).toContain("instance.json");
        expect(launcherSource).toContain("ClearInstanceState()");
    });

    it("keeps the desktop alive for notifications and broadcasts tray exit", () => {
        expect(launcherSource).toContain("StartLauncherEventLoop");
        expect(launcherSource).toContain("/api/launcher/events");
        expect(launcherSource).toContain("OpenBrowser(port)");
        expect(launcherSource).toContain("NotifyShutdown(port.Value)");
        expect(launcherSource).toContain("/api/launcher/shutdown");
    });

    it("opens QingLing with a single left click and keeps right-click menu minimal", () => {
        expect(launcherSource).toContain("tray.MouseClick");
        expect(launcherSource).toContain("MouseButtons.Left");
        expect(launcherSource).not.toContain("menu.Items.Add(\"打开清灵\"");
        expect(launcherSource).not.toContain("tray.DoubleClick");
    });

    it("focuses an existing QingLing browser window before opening another tab", () => {
        expect(launcherSource).toContain("ActivateExistingQingLingWindow()");
        expect(launcherSource).toContain("const string pageTitle = \"清灵 QingLing - 清华校园智能助手\"");
        expect(launcherSource).toContain("title.StartsWith(pageTitle, StringComparison.Ordinal)");
        expect(launcherSource).toContain("EnumWindows");
        expect(launcherSource).toContain("SetForegroundWindow");
        expect(launcherSource).toContain("SW_RESTORE");
        expect(launcherSource).toContain("OpenBrowser(port.Value, false)");
    });

    it("styles the tray menu with QingLing dark theme colors", () => {
        expect(launcherSource).toContain("QingLingMenuRenderer");
        expect(launcherSource).toContain("QingLingColorTable");
        expect(launcherSource).toContain("Color.FromArgb(0x1E, 0x1E, 0x22)");
        expect(launcherSource).toContain("Color.FromArgb(38, 0x8F, 0x3F, 0xA3)");
        expect(launcherSource).toContain("Microsoft YaHei UI");
        expect(launcherSource).toContain("ShowImageMargin = false");
    });

    it("renders crisp and left-aligned tray menu text on high-DPI displays", () => {
        expect(launcherSource).toContain("EnableHighDpiRendering()");
        expect(launcherSource).toContain("SetProcessDpiAwarenessContext");
        expect(launcherSource).toContain("graphics.DpiX / 96F");
        expect(launcherSource).toContain("Scale(14)");
        expect(launcherSource).toContain("TextFormatFlags.Left");
        expect(launcherSource).toContain("TextFormatFlags.VerticalCenter");
    });

    it("keeps tray menu geometry aligned and rounds the popup", () => {
        expect(launcherSource).toContain("RoundedContextMenuStrip");
        expect(launcherSource).toContain("DwmSetWindowAttribute");
        expect(launcherSource).toContain("e.Graphics.ResetClip()");
        expect(launcherSource).toContain("separator.Size = new Size(Scale(144, scale), Scale(13, scale))");
        expect(launcherSource).toContain("OnRenderToolStripBorder");
    });
});
