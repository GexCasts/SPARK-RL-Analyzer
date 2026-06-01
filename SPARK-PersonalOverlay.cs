using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SparkPersonalOverlay
{
    internal sealed class OverlayForm : Form
    {
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        private readonly string url;
        private readonly string root;
        private readonly WebView2 webView;

        public OverlayForm(string url, string root)
        {
            this.url = url;
            this.root = root;
            Text = "SPARK Personal Overlay";
            StartPosition = FormStartPosition.Manual;
            Bounds = Screen.PrimaryScreen.Bounds;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.Black;

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.Transparent;
            Controls.Add(webView);
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            await InitializeAsync();
        }

        private async Task InitializeAsync()
        {
            try
            {
                string profile = Path.Combine(root, ".tmp", "webview2-personal-overlay");
                Directory.CreateDirectory(profile);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
                {
                    args.Handled = true;
                };
                webView.CoreWebView2.Navigate(url);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "SPARK could not open the pinned personal overlay.\n\n" + ex.Message,
                    "SPARK",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                Close();
            }
        }
    }

    internal static class Program
    {
        public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        public static readonly string WebView2RuntimeDir = Path.Combine(Root, "tools", "webview2", "runtime");

        [STAThread]
        private static void Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveSparkAssembly;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string url = args.Length > 0 && !String.IsNullOrWhiteSpace(args[0])
                ? args[0]
                : "http://127.0.0.1:8765/1NE_Overlay?personal=1";
            Application.Run(new OverlayForm(url, Root));
        }

        private static Assembly ResolveSparkAssembly(object sender, ResolveEventArgs args)
        {
            string fileName = new AssemblyName(args.Name).Name + ".dll";
            string candidate = Path.Combine(WebView2RuntimeDir, fileName);
            if (File.Exists(candidate)) return Assembly.LoadFrom(candidate);
            return null;
        }
    }
}
