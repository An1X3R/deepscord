using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DeepscordLite
{
    internal static class Program
    {
        private const string MutexName = "DeepscordLite.SingleInstance";

        [STAThread]
        private static void Main(string[] args)
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
                GC.KeepAlive(mutex);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private static readonly string[] BuiltinTrustedHosts = new string[] { "localhost", "127.0.0.1" };

        private readonly string configDir;
        private readonly HashSet<string> trustedHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private WebView2 webView;
        private string serverUrl;

        public MainForm()
        {
            Text = "Deepscord";
            Width = 1320;
            Height = 860;
            MinimumSize = new Size(980, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(11, 13, 18);
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception)
            {
            }

            configDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DeepscordLite");
            Directory.CreateDirectory(configDir);
            LoadTrustedHosts();
            serverUrl = LoadServerUrl();

            BuildMenu();

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            Controls.Add(webView);

            Load += OnFormLoad;
        }

        private string ServerFile
        {
            get { return Path.Combine(configDir, "server.txt"); }
        }

        private string TrustedFile
        {
            get { return Path.Combine(configDir, "trusted.txt"); }
        }

        private void LoadTrustedHosts()
        {
            for (int i = 0; i < BuiltinTrustedHosts.Length; i++)
            {
                trustedHosts.Add(BuiltinTrustedHosts[i]);
            }
            try
            {
                if (File.Exists(TrustedFile))
                {
                    string[] lines = File.ReadAllLines(TrustedFile);
                    for (int i = 0; i < lines.Length; i++)
                    {
                        string host = lines[i].Trim();
                        if (host.Length > 0)
                        {
                            trustedHosts.Add(host);
                        }
                    }
                }
            }
            catch (Exception)
            {
            }
        }

        private string LoadServerUrl()
        {
            string fromEnv = Environment.GetEnvironmentVariable("DEEPSCORD_URL");
            if (!string.IsNullOrEmpty(fromEnv))
            {
                return NormalizeUrl(fromEnv);
            }
            try
            {
                if (File.Exists(ServerFile))
                {
                    string saved = File.ReadAllText(ServerFile).Trim();
                    if (saved.Length > 0)
                    {
                        return NormalizeUrl(saved);
                    }
                }
            }
            catch (Exception)
            {
            }
            return string.Empty;
        }

        private static string NormalizeUrl(string raw)
        {
            string s = (raw == null ? string.Empty : raw.Trim());
            if (s.Length == 0)
            {
                throw new ArgumentException("请输入服务器地址。", "raw");
            }
            if (s.IndexOf("://", StringComparison.Ordinal) < 0)
            {
                s = "https://" + s;
            }
            Uri uri;
            if (!Uri.TryCreate(s, UriKind.Absolute, out uri))
            {
                throw new ArgumentException("服务器地址格式无效。", "raw");
            }
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            {
                throw new ArgumentException("服务器地址必须使用 HTTP 或 HTTPS。", "raw");
            }
            return uri.ToString();
        }

        private void SaveServerUrl(string url)
        {
            try
            {
                File.WriteAllText(ServerFile, url);
            }
            catch (Exception)
            {
            }
        }

        private void BuildMenu()
        {
            MenuStrip menu = new MenuStrip();

            ToolStripMenuItem file = new ToolStripMenuItem("文件(&F)");
            ToolStripMenuItem switchServer = new ToolStripMenuItem("切换服务器…", null, OnSwitchServer);
            switchServer.ShortcutKeys = Keys.Control | Keys.Shift | Keys.S;
            ToolStripMenuItem reload = new ToolStripMenuItem("重新加载", null, OnReload);
            reload.ShortcutKeys = Keys.F5;
            ToolStripMenuItem exit = new ToolStripMenuItem("退出", null, OnExit);
            file.DropDownItems.Add(switchServer);
            file.DropDownItems.Add(reload);
            file.DropDownItems.Add(new ToolStripSeparator());
            file.DropDownItems.Add(exit);

            ToolStripMenuItem help = new ToolStripMenuItem("帮助(&H)");
            help.DropDownItems.Add(new ToolStripMenuItem("关于 Deepscord", null, OnAbout));

            menu.Items.Add(file);
            menu.Items.Add(help);
            menu.Dock = DockStyle.Top;
            MainMenuStrip = menu;
            Controls.Add(menu);
        }

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                string userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "DeepscordLite",
                    "WebView2");
                Directory.CreateDirectory(userData);

                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userData, null);
                await webView.EnsureCoreWebView2Async(environment);

                CoreWebView2 core = webView.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;
                core.PermissionRequested += OnPermissionRequested;
                core.ServerCertificateErrorDetected += OnServerCertificateError;
                core.NewWindowRequested += OnNewWindowRequested;

                if (string.IsNullOrEmpty(serverUrl))
                {
                    OnSwitchServer(this, EventArgs.Empty);
                }
                else
                {
                    NavigateTo(serverUrl);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    this,
                    "WebView2 初始化失败：" + ex.Message + Environment.NewLine + Environment.NewLine +
                    "请先安装 Microsoft Edge WebView2 Runtime（Windows 10/11 通常已自带）。",
                    "Deepscord",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                Close();
            }
        }

        private void NavigateTo(string url)
        {
            string normalized = NormalizeUrl(url);
            serverUrl = normalized;
            SaveServerUrl(normalized);

            if (webView.CoreWebView2 != null)
            {
                webView.CoreWebView2.Navigate(normalized);
            }
            else
            {
                webView.Source = new Uri(normalized);
            }

            Uri uri;
            if (Uri.TryCreate(normalized, UriKind.Absolute, out uri))
            {
                Text = "Deepscord · " + uri.Host;
            }
        }

        private void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.Microphone ||
                e.PermissionKind == CoreWebView2PermissionKind.Camera ||
                e.PermissionKind == CoreWebView2PermissionKind.Notifications)
            {
                e.State = CoreWebView2PermissionState.Allow;
            }
        }

        private void OnServerCertificateError(object sender, CoreWebView2ServerCertificateErrorDetectedEventArgs e)
        {
            try
            {
                string host = e.RequestUri == null ? string.Empty : e.RequestUri.Host;
                if (trustedHosts.Contains(host))
                {
                    e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
                    return;
                }

                DialogResult result = MessageBox.Show(
                    this,
                    "服务器 " + host + " 使用了不受信任的证书。" + Environment.NewLine + Environment.NewLine +
                    "如果这是你自己的服务器（例如使用自签证书），选择“是”继续访问。",
                    "Deepscord · 证书不受信任",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);

                if (result == DialogResult.Yes)
                {
                    trustedHosts.Add(host);
                    try
                    {
                        File.AppendAllText(TrustedFile, host + Environment.NewLine);
                    }
                    catch (Exception)
                    {
                    }
                    e.Action = CoreWebView2ServerCertificateErrorAction.AlwaysAllow;
                }
                else
                {
                    e.Action = CoreWebView2ServerCertificateErrorAction.Cancel;
                }
            }
            catch (Exception)
            {
                e.Action = CoreWebView2ServerCertificateErrorAction.Default;
            }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            try
            {
                Process.Start(e.Uri);
            }
            catch (Exception)
            {
            }
        }

        private void OnReload(object sender, EventArgs e)
        {
            if (webView.CoreWebView2 != null)
            {
                webView.CoreWebView2.Reload();
            }
        }

        private void OnSwitchServer(object sender, EventArgs e)
        {
            using (ServerDialog dialog = new ServerDialog(serverUrl))
            {
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    try
                    {
                        NavigateTo(dialog.ServerUrl);
                    }
                    catch (ArgumentException error)
                    {
                        MessageBox.Show(this, error.Message, "服务器地址无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
            }
        }

        private void OnExit(object sender, EventArgs e)
        {
            Close();
        }

        private void OnAbout(object sender, EventArgs e)
        {
            Version version = Assembly.GetExecutingAssembly().GetName().Version;
            CoreWebView2Environment environment = null;
            string runtime = "WebView2";
            try
            {
                environment = webView != null ? null : null;
            }
            catch (Exception)
            {
            }
            MessageBox.Show(
                this,
                "Deepscord 轻量版 " + version + Environment.NewLine + Environment.NewLine +
                "使用系统 WebView2（Edge 内核），不内置浏览器，安装包约 2MB。" + Environment.NewLine +
                "完整版请使用 Electron 版本（支持离线本机服务器、托盘）。" + Environment.NewLine + Environment.NewLine +
                "服务器：" + serverUrl,
                "关于 Deepscord",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
    }

    internal sealed class ServerDialog : Form
    {
        private readonly TextBox input;

        public ServerDialog(string current)
        {
            Text = "切换服务器";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(520, 160);
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(17, 20, 27);
            ForeColor = Color.FromArgb(233, 236, 245);

            Label label = new Label();
            label.Text = "服务器地址（由服主提供）";
            label.AutoSize = true;
            label.Location = new Point(20, 20);
            Controls.Add(label);

            input = new TextBox();
            input.Text = current;
            input.Width = 480;
            input.Location = new Point(20, 50);
            Controls.Add(input);

            Button ok = new Button();
            ok.Text = "连接";
            ok.DialogResult = DialogResult.OK;
            ok.Width = 100;
            ok.Location = new Point(300, 100);
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Width = 100;
            cancel.Location = new Point(410, 100);
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
            ActiveControl = input;
            input.SelectAll();
        }

        public string ServerUrl
        {
            get { return input.Text.Trim(); }
        }
    }
}
