using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ThuAssistantLauncher
{

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        EnableHighDpiRendering();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var baseDirectory = AppContext.BaseDirectory;
        var nodePath = Path.Combine(baseDirectory, "runtime", "node.exe");
        var scriptPath = Path.Combine(baseDirectory, "app", "dist", "scripts", "step18-web.cjs");
        var opensslPath = Path.Combine(baseDirectory, "openssl.cnf");

        if (!File.Exists(nodePath) || !File.Exists(scriptPath) || !File.Exists(opensslPath))
        {
            MessageBox.Show(
                "程序文件不完整，请重新解压完整的清灵发布包。",
                "清灵",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var port = FindAvailablePort(3457, 20);
        if (!port.HasValue)
        {
            MessageBox.Show(
                "找不到可用的本地端口，请关闭其他程序后重试。",
                "清灵",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using (var child = StartServer(nodePath, scriptPath, baseDirectory, opensslPath, port.Value))
        using (var tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "清灵",
            Visible = true,
            ContextMenuStrip = CreateMenu(child, port.Value)
        })
        {
            tray.DoubleClick += (sender, e) => OpenBrowser(port.Value);

            if (!WaitForServer(child, port.Value))
            {
                tray.Visible = false;
                MessageBox.Show(
                    "本地服务启动失败，请检查 .env 配置和程序目录中的日志。",
                    "清灵",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            OpenBrowser(port.Value);
            Application.Run();
            tray.Visible = false;
            StopServer(child);
        }
    }

    private static Process StartServer(string nodePath, string scriptPath, string baseDirectory, string opensslPath, int port)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = baseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = "\"" + scriptPath + "\""
        };
        startInfo.EnvironmentVariables["PORT"] = port.ToString();
        startInfo.EnvironmentVariables["OPENSSL_CONF"] = opensslPath;
        var process = Process.Start(startInfo);
        if (process == null) throw new InvalidOperationException("无法启动内置 Node.js。");
        return process;
    }

    private static ContextMenuStrip CreateMenu(Process child, int port)
    {
        var menu = new RoundedContextMenuStrip();
        var scale = GetUiScale(menu);
        menu.Font = new Font(
            "Microsoft YaHei UI",
            14F * scale,
            FontStyle.Regular,
            GraphicsUnit.Pixel);
        menu.BackColor = Color.FromArgb(0x1E, 0x1E, 0x22);
        menu.Padding = new Padding(Scale(8, scale));
        menu.ShowImageMargin = false;
        menu.Renderer = new QingLingMenuRenderer(scale);
        menu.Items.Add("打开清灵", null, (sender, e) => OpenBrowser(port));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (sender, e) =>
        {
            StopServer(child);
            Application.Exit();
        });
        foreach (ToolStripItem item in menu.Items)
        {
            item.Font = menu.Font;
            item.ForeColor = Color.FromArgb(0xEC, 0xEC, 0xF1);
            item.Margin = new Padding(0);
            item.Padding = new Padding(0);

            var separator = item as ToolStripSeparator;
            if (separator != null)
            {
                separator.AutoSize = false;
                separator.Size = new Size(Scale(144, scale), Scale(13, scale));
                separator.Margin = new Padding(0);
                separator.Padding = new Padding(0);
            }
            else
            {
                item.AutoSize = false;
                item.Size = new Size(Scale(144, scale), Scale(38, scale));
                item.TextAlign = ContentAlignment.MiddleCenter;
            }
        }
        return menu;
    }

    private static void EnableHighDpiRendering()
    {
        // 没有 DPI 声明时，Windows 会把 WinForms 菜单先按 96 DPI 绘制再整体位图放大，
        // 高缩放屏幕上中文会明显发虚。优先启用 Per-Monitor V2，失败则退回系统级 DPI。
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == 0)
            {
                return;
            }
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }

        try
        {
            SetProcessDPIAware();
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }
    }

    private static float GetUiScale(Control menu)
    {
        using (var graphics = menu.CreateGraphics())
        {
            return graphics.DpiX / 96F;
        }
    }

    private static int Scale(int value, float scale)
    {
        return (int)Math.Round(value * scale);
    }

    [DllImport("Shcore.dll")]
    private static extern int SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        IntPtr hwnd,
        int attribute,
        ref int value,
        int size);

    private static bool WaitForServer(Process child, int port)
    {
        using (var client = new HttpClient {Timeout = TimeSpan.FromMilliseconds(500)})
        {
            var url = "http://127.0.0.1:" + port + "/api/capabilities";
            for (var i = 0; i < 60; i++)
            {
                if (child.HasExited) return false;
                try
                {
                    using (var response = client.GetAsync(url).GetAwaiter().GetResult())
                    {
                        if (response.IsSuccessStatusCode) return true;
                    }
                }
                catch (HttpRequestException) { }
                catch (TaskCanceledException) { }
                Thread.Sleep(250);
            }
            return false;
        }
    }

    private static int? FindAvailablePort(int start, int count)
    {
        for (var port = start; port < start + count; port++)
        {
            try
            {
                var listener = new TcpListener(IPAddress.Loopback, port);
                listener.Start();
                listener.Stop();
                return port;
            }
            catch (SocketException) { }
        }
        return null;
    }

    private static void OpenBrowser(int port)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "http://127.0.0.1:" + port + "/",
            UseShellExecute = true
        });
    }

    private static void StopServer(Process child)
    {
        if (child.HasExited) return;
        // 兼容 .NET Framework 打包兜底：旧运行时没有 Kill(entireProcessTree)。
        // taskkill 同时覆盖 Node 自身和它可能派生的子进程。
        try
        {
            using (var killer = Process.Start(new ProcessStartInfo
            {
                FileName = "taskkill.exe",
                Arguments = "/PID " + child.Id + " /T /F",
                CreateNoWindow = true,
                UseShellExecute = false,
            }))
            {
                if (killer != null) killer.WaitForExit(5000);
            }
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        }

    private sealed class RoundedContextMenuStrip : ContextMenuStrip
    {
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            // Windows 11 的 DWM 圆角。Windows 10 会返回错误，此时保持系统默认外形。
            var preference = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(Handle, 33, ref preference, sizeof(int));
        }
    }

    private sealed class QingLingMenuRenderer : ToolStripProfessionalRenderer
    {
        private readonly float scale;

        public QingLingMenuRenderer(float scale)
            : base(new QingLingColorTable())
        {
            this.scale = scale;
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var bounds = new Rectangle(Point.Empty, e.Item.Size);
            var background = e.Item.Selected || e.Item.Pressed
                ? Color.FromArgb(38, 0x8F, 0x3F, 0xA3)
                : Color.FromArgb(0x1E, 0x1E, 0x22);
            using (var path = CreateRoundedRectangle(bounds, Scale(8)))
            using (var brush = new SolidBrush(background))
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.FillPath(brush, path);
            }
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            var menuItem = e.Item as ToolStripMenuItem;
            if (menuItem == null)
            {
                base.OnRenderItemText(e);
                return;
            }

            var flags = TextFormatFlags.Left |
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.NoPrefix |
                TextFormatFlags.SingleLine |
                TextFormatFlags.EndEllipsis;
            var color = e.Item.Selected || e.Item.Pressed
                ? Color.White
                : Color.FromArgb(0xEC, 0xEC, 0xF1);

            // TextRenderer 走 GDI 绘制，中文边缘比 GDI+ 在深色背景上更稳。
            // 绘制矩形必须使用整个 item bounds，而不是 WinForms 默认的 TextRectangle；
            // 后者会受隐藏图片栏/默认内边距影响，导致文字看起来偏上或偏左。
            // ToolStrip 在进入文字渲染阶段前可能带着较窄的旧 clip；不重置时，
            // 文字实际会被裁掉左侧/右侧，看起来整体偏移或截断。
            e.Graphics.ResetClip();
            var textBounds = new Rectangle(
                Scale(14),
                0,
                Math.Max(0, e.Item.Width - Scale(28)),
                e.Item.Height);
            TextRenderer.DrawText(
                e.Graphics,
                e.Text,
                e.Item.Font,
                textBounds,
                color,
                flags);
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            using (var brush = new SolidBrush(Color.FromArgb(0x1E, 0x1E, 0x22)))
            {
                e.Graphics.FillRectangle(brush, e.AffectedBounds);
            }
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var bounds = new Rectangle(
                Point.Empty,
                new Size(e.ToolStrip.Width - 1, e.ToolStrip.Height - 1));
            using (var path = CreateRoundedRectangle(bounds, Scale(10)))
            using (var pen = new Pen(Color.FromArgb(0x2C, 0x2C, 0x33)))
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            var bounds = e.Vertical
                ? new Rectangle(e.Item.Width / 2, 3, 1, e.Item.Height - 6)
                : new Rectangle(Scale(10), e.Item.Height / 2, e.Item.Width - Scale(20), 1);
            using (var brush = new SolidBrush(Color.FromArgb(0x2C, 0x2C, 0x33)))
            {
                e.Graphics.FillRectangle(brush, bounds);
            }
        }

        private static GraphicsPath CreateRoundedRectangle(Rectangle bounds, int radius)
        {
            var path = new GraphicsPath();
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }

            var corner = Math.Min(radius, Math.Min(bounds.Width, bounds.Height) / 2);
            path.AddArc(bounds.Left, bounds.Top, corner * 2, corner * 2, 180, 90);
            path.AddArc(bounds.Right - corner * 2, bounds.Top, corner * 2, corner * 2, 270, 90);
            path.AddArc(bounds.Right - corner * 2, bounds.Bottom - corner * 2, corner * 2, corner * 2, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - corner * 2, corner * 2, corner * 2, 90, 90);
            path.CloseFigure();
            return path;
        }

        private int Scale(int value)
        {
            return (int)Math.Round(value * scale);
        }
    }

    private sealed class QingLingColorTable : ProfessionalColorTable
    {
        public override Color MenuBorder
        {
            get { return Color.FromArgb(0x2C, 0x2C, 0x33); }
        }

        public override Color MenuItemBorder
        {
            get { return Color.Transparent; }
        }

        public override Color MenuItemSelected
        {
            get { return Color.FromArgb(38, 0x8F, 0x3F, 0xA3); }
        }

        public override Color MenuItemSelectedGradientBegin
        {
            get { return Color.FromArgb(38, 0x8F, 0x3F, 0xA3); }
        }

        public override Color MenuItemSelectedGradientEnd
        {
            get { return Color.FromArgb(38, 0x8F, 0x3F, 0xA3); }
        }

        public override Color MenuItemPressedGradientBegin
        {
            get { return Color.FromArgb(64, 0x82, 0x31, 0x8E); }
        }

        public override Color MenuItemPressedGradientEnd
        {
            get { return Color.FromArgb(64, 0x82, 0x31, 0x8E); }
        }

        public override Color ToolStripDropDownBackground
        {
            get { return Color.FromArgb(0x1E, 0x1E, 0x22); }
        }

        public override Color ImageMarginGradientBegin
        {
            get { return Color.FromArgb(0x1E, 0x1E, 0x22); }
        }

        public override Color ImageMarginGradientMiddle
        {
            get { return Color.FromArgb(0x1E, 0x1E, 0x22); }
        }

        public override Color ImageMarginGradientEnd
        {
            get { return Color.FromArgb(0x1E, 0x1E, 0x22); }
        }
    }
}
}
