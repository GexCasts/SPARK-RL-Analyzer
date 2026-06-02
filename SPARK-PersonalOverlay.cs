using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
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
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int LWA_COLORKEY = 0x00000001;

        private static readonly Color TransparentSurfaceColor = Color.FromArgb(1, 2, 3);
        private readonly string url;
        private readonly string root;
        private readonly WebView2 webView;
        private readonly Timer placementTimer;

        public OverlayForm(string url, string root)
        {
            this.url = url;
            this.root = root;
            Text = "SPARK Personal Overlay";
            StartPosition = FormStartPosition.Manual;
            Bounds = FindRocketLeagueScreen().Bounds;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = TransparentSurfaceColor;
            TransparencyKey = TransparentSurfaceColor;

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.BackColor = TransparentSurfaceColor;
            webView.DefaultBackgroundColor = TransparentSurfaceColor;
            Controls.Add(webView);

            placementTimer = new Timer();
            placementTimer.Interval = 1500;
            placementTimer.Tick += delegate { SyncToRocketLeagueScreen(); };
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
                cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyTransparentSurface();
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            ApplyTransparentSurface();
            SyncToRocketLeagueScreen();
            placementTimer.Start();
            await InitializeAsync();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                placementTimer.Dispose();
            }
            base.Dispose(disposing);
        }

        private async Task InitializeAsync()
        {
            try
            {
                string profile = Path.Combine(root, ".tmp", "webview2-personal-overlay");
                Directory.CreateDirectory(profile);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile);
                await webView.EnsureCoreWebView2Async(environment);
                webView.DefaultBackgroundColor = TransparentSurfaceColor;
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

        private void SyncToRocketLeagueScreen()
        {
            Rectangle targetBounds = FindRocketLeagueScreen().Bounds;
            if (Bounds != targetBounds)
            {
                WindowState = FormWindowState.Normal;
                Bounds = targetBounds;
            }
            TopMost = false;
            TopMost = true;
            ApplyTransparentSurface();
        }

        private void ApplyTransparentSurface()
        {
            if (Handle == IntPtr.Zero) return;
            try
            {
                SetLayeredWindowAttributes(Handle, ColorTranslator.ToWin32(TransparentSurfaceColor), 0, LWA_COLORKEY);
            }
            catch
            {
            }
        }

        private static Screen FindRocketLeagueScreen()
        {
            IntPtr handle = FindRocketLeagueWindow();
            if (handle != IntPtr.Zero)
            {
                return Screen.FromHandle(handle);
            }
            return Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen;
        }

        private static IntPtr FindRocketLeagueWindow()
        {
            try
            {
                foreach (Process process in Process.GetProcessesByName("RocketLeague"))
                {
                    if (process.MainWindowHandle != IntPtr.Zero)
                    {
                        return process.MainWindowHandle;
                    }
                }
            }
            catch
            {
            }

            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                uint processId;
                GetWindowThreadProcessId(hWnd, out processId);
                if (processId == 0) return true;
                try
                {
                    Process process = Process.GetProcessById((int)processId);
                    string title = process.MainWindowTitle ?? "";
                    if (String.Equals(process.ProcessName, "RocketLeague", StringComparison.OrdinalIgnoreCase) ||
                        title.IndexOf("Rocket League", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        found = hWnd;
                        return false;
                    }
                }
                catch
                {
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll")]
        private static extern bool SetLayeredWindowAttributes(IntPtr hWnd, int colorKey, byte alpha, int flags);
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
