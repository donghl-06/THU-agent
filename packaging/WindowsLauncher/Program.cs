using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Windows.Forms;

namespace ThuAssistantLauncher;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        var baseDirectory = AppContext.BaseDirectory;
        var nodePath = Path.Combine(baseDirectory, "runtime", "node.exe");
        var scriptPath = Path.Combine(baseDirectory, "app", "dist", "scripts", "step18-web.cjs");
        var opensslPath = Path.Combine(baseDirectory, "openssl.cnf");

        if (!File.Exists(nodePath) || !File.Exists(scriptPath) || !File.Exists(opensslPath))
        {
            MessageBox.Show(
                "程序文件不完整，请重新解压完整的清华小助手发布包。",
                "清华小助手",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var port = FindAvailablePort(3457, 20);
        if (port is null)
        {
            MessageBox.Show(
                "找不到可用的本地端口，请关闭其他程序后重试。",
                "清华小助手",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using var child = StartServer(nodePath, scriptPath, baseDirectory, opensslPath, port.Value);
        using var tray = new NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "清华小助手",
            Visible = true,
            ContextMenuStrip = CreateMenu(child, port.Value)
        };
        tray.DoubleClick += (_, _) => OpenBrowser(port.Value);

        if (!WaitForServer(child, port.Value))
        {
            tray.Visible = false;
            MessageBox.Show(
                "本地服务启动失败，请检查 .env 配置和程序目录中的日志。",
                "清华小助手",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        OpenBrowser(port.Value);
        Application.Run();
        tray.Visible = false;
        StopServer(child);
    }

    private static Process StartServer(string nodePath, string scriptPath, string baseDirectory, string opensslPath, int port)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = baseDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            Arguments = $"\"{scriptPath}\""
        };
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["OPENSSL_CONF"] = opensslPath;
        var process = Process.Start(startInfo);
        if (process is null) throw new InvalidOperationException("无法启动内置 Node.js。");
        return process;
    }

    private static ContextMenuStrip CreateMenu(Process child, int port)
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开清华小助手", null, (_, _) => OpenBrowser(port));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) =>
        {
            StopServer(child);
            Application.Exit();
        });
        return menu;
    }

    private static bool WaitForServer(Process child, int port)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
        var url = $"http://127.0.0.1:{port}/api/capabilities";
        for (var i = 0; i < 60; i++)
        {
            if (child.HasExited) return false;
            try
            {
                using var response = client.GetAsync(url).GetAwaiter().GetResult();
                if (response.IsSuccessStatusCode) return true;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) { }
            Thread.Sleep(250);
        }
        return false;
    }

    private static int? FindAvailablePort(int start, int count)
    {
        for (var port = start; port < start + count; port++)
        {
            try
            {
                using var listener = new TcpListener(IPAddress.Loopback, port);
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
            FileName = $"http://127.0.0.1:{port}/",
            UseShellExecute = true
        });
    }

    private static void StopServer(Process child)
    {
        if (child.HasExited) return;
        try { child.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
