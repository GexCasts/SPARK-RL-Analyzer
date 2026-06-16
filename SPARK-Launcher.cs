using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SparkLauncher
{
    public sealed class ManifestFile
    {
        public string path { get; set; }
        public string version { get; set; }
        public string sha256 { get; set; }
        public long size { get; set; }
        public string modifiedUtc { get; set; }
    }

    public sealed class Manifest
    {
        public int schemaVersion { get; set; }
        public string appName { get; set; }
        public string appVersion { get; set; }
        public string generatedUtc { get; set; }
        public List<ManifestFile> files { get; set; }
    }

    internal sealed class LauncherForm : Form
    {
        private const int GWL_STYLE = -16;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOOWNERZORDER = 0x0200;
        private const uint SWP_FRAMECHANGED = 0x0020;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private const long WS_CAPTION = 0x00C00000L;
        private const long WS_THICKFRAME = 0x00040000L;
        private const long WS_SYSMENU = 0x00080000L;
        private const long WS_MINIMIZEBOX = 0x00020000L;
        private const long WS_MAXIMIZEBOX = 0x00010000L;
        private const int DWMWA_BORDER_COLOR = 34;
        private const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

        private readonly string root;
        private readonly string toolsDir;
        private readonly string tmpDir;
        private readonly string nodeVersion = "v22.11.0";
        private readonly string nodeFolder = "node-v22.11.0-win-x64";
        private readonly string rrrocketVersion = "0.11.1";
        private readonly string rrrocketFolder = "rrrocket-0.11.1-x86_64-pc-windows-msvc";
        private readonly string ffmpegVersion = "8.1.1";
        private readonly string ffmpegFolder = "ffmpeg-8.1.1-essentials_build";
        private readonly string githubRawBase = "https://raw.githubusercontent.com/GexCasts/SPARK-RL-Analyzer/main";
        private readonly string appUrl = "http://127.0.0.1:8765/SPARK.html";

        private Button launchButton;
        private Button updateButton;
        private ProgressBar progressBar;
        private TextBox statusBox;

        public LauncherForm()
        {
            root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            toolsDir = Path.Combine(root, "tools");
            tmpDir = Path.Combine(root, ".tmp");

            BuildUi();
            LoadLocalManifestStatus();
        }

        private string DependencyDownloadDir { get { return Path.Combine(tmpDir, "downloads"); } }
        private string NodeZipPath { get { return Path.Combine(DependencyDownloadDir, nodeFolder + ".zip"); } }
        private string BundledNodePath { get { return Path.Combine(toolsDir, "node", nodeFolder, "node.exe"); } }
        private string RrrocketZipPath { get { return Path.Combine(DependencyDownloadDir, rrrocketFolder + ".zip"); } }
        private string RrrocketExePath { get { return Path.Combine(toolsDir, "rrrocket", rrrocketFolder, "rrrocket.exe"); } }
        private string FfmpegZipPath { get { return Path.Combine(DependencyDownloadDir, ffmpegFolder + ".zip"); } }
        private string FfmpegExePath { get { return Path.Combine(toolsDir, "ffmpeg", ffmpegFolder, "bin", "ffmpeg.exe"); } }
        private string ServerScriptPath { get { return Path.Combine(root, "static-download-server.mjs"); } }
        private string ManifestPath { get { return Path.Combine(root, "spark-manifest.json"); } }

        private void BuildUi()
        {
            Color bg = Color.FromArgb(243, 244, 246);
            Color ink = Color.FromArgb(24, 24, 27);
            Color muted = Color.FromArgb(82, 82, 91);
            Color yellow = Color.FromArgb(245, 178, 20);
            Color silver = Color.FromArgb(150, 153, 158);

            Text = "SPARK Launcher";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(620, 500);
            MinimumSize = new Size(620, 500);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            BackColor = bg;

            string iconPath = Path.Combine(root, "assets", "SPARK Launcher.ico");
            if (File.Exists(iconPath)) Icon = new Icon(iconPath);

            Panel hero = new Panel();
            hero.Location = new Point(18, 18);
            hero.Size = new Size(584, 170);
            hero.BackColor = Color.White;
            hero.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(hero);

            string sparkLogoPath = Path.Combine(root, "assets", "SPARK app logo transparent.png");
            if (File.Exists(sparkLogoPath))
            {
                PictureBox sparkLogo = new PictureBox();
                sparkLogo.Image = LoadImageCopy(sparkLogoPath);
                sparkLogo.SizeMode = PictureBoxSizeMode.Zoom;
                sparkLogo.Location = new Point(22, 20);
                sparkLogo.Size = new Size(145, 105);
                sparkLogo.BackColor = Color.Transparent;
                hero.Controls.Add(sparkLogo);
            }

            hero.Controls.Add(NewLabel("SPARK", 188, 32, 340, 38, 22, ink, true));
            hero.Controls.Add(NewLabel("Statistical Performance Analysis Replay Kit", 190, 76, 360, 42, 10.5f, muted, false));

            Panel madeBy = new Panel();
            madeBy.Location = new Point(380, 115);
            madeBy.Size = new Size(180, 42);
            madeBy.BackColor = Color.White;
            madeBy.BorderStyle = BorderStyle.None;
            hero.Controls.Add(madeBy);
            madeBy.Controls.Add(NewLabel("made by", 10, 12, 58, 18, 8.5f, muted, false));

            string oneNeLogoPath = Path.Combine(root, "assets", "1NE_Vector_edited.png");
            if (File.Exists(oneNeLogoPath))
            {
                PictureBox oneNe = new PictureBox();
                oneNe.Image = LoadImageCopy(oneNeLogoPath);
                oneNe.SizeMode = PictureBoxSizeMode.Zoom;
                oneNe.Location = new Point(76, 2);
                oneNe.Size = new Size(78, 38);
                oneNe.BackColor = Color.Transparent;
                madeBy.Controls.Add(oneNe);
            }

            launchButton = NewButton("Launch SPARK", 18, 210, 282, 46, yellow);
            updateButton = NewButton("Check for Updates", 320, 210, 282, 46, silver);
            launchButton.Click += delegate { RunWithUiLock(StartSpark); };
            updateButton.Click += delegate { RunWithUiLock(UpdateSparkFromManifest); };
            Controls.Add(launchButton);
            Controls.Add(updateButton);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(18, 268);
            progressBar.Size = new Size(584, 10);
            progressBar.Style = ProgressBarStyle.Continuous;
            progressBar.Minimum = 0;
            progressBar.Maximum = 100;
            Controls.Add(progressBar);

            statusBox = new TextBox();
            statusBox.Location = new Point(18, 292);
            statusBox.Size = new Size(584, 160);
            statusBox.Multiline = true;
            statusBox.ReadOnly = true;
            statusBox.ScrollBars = ScrollBars.Vertical;
            statusBox.BorderStyle = BorderStyle.FixedSingle;
            statusBox.Font = new Font("Consolas", 9);
            statusBox.BackColor = Color.FromArgb(31, 31, 35);
            statusBox.ForeColor = Color.FromArgb(245, 245, 245);
            Controls.Add(statusBox);

            Controls.Add(NewLabel("Manifest updates compare local SHA-256 versions with GitHub main.", 20, 462, 410, 20, 8.5f, muted, false));
        }

        private void RunWithUiLock(Action action)
        {
            try
            {
                SetButtonsEnabled(false);
                SetProgress(0);
                action();
            }
            catch (Exception ex)
            {
                SetProgress(0);
                WriteStatus(ex.Message);
                MessageBox.Show(ex.Message, "SPARK Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                SetButtonsEnabled(true);
            }
        }

        private static Label NewLabel(string text, int x, int y, int width, int height, float size, Color color, bool bold)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.Size = new Size(width, height);
            label.Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            return label;
        }

        private static Button NewButton(string text, int x, int y, int width, int height, Color backColor)
        {
            Button button = new Button();
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, height);
            button.Font = new Font("Segoe UI Semibold", 10);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 0;
            button.BackColor = backColor;
            button.ForeColor = Color.White;
            button.Cursor = Cursors.Hand;
            return button;
        }

        private static Image LoadImageCopy(string path)
        {
            using (Image source = Image.FromFile(path)) return new Bitmap(source);
        }

        private void SetButtonsEnabled(bool enabled)
        {
            launchButton.Enabled = enabled;
            updateButton.Enabled = enabled;
            Application.DoEvents();
        }

        private void SetProgress(int value)
        {
            progressBar.Value = Math.Max(progressBar.Minimum, Math.Min(progressBar.Maximum, value));
            Application.DoEvents();
        }

        private void WriteStatus(string message)
        {
            statusBox.AppendText("[SPARK] " + message + Environment.NewLine);
            statusBox.SelectionStart = statusBox.Text.Length;
            statusBox.ScrollToCaret();
            Application.DoEvents();
        }

        private void LoadLocalManifestStatus()
        {
            try
            {
                if (!File.Exists(ManifestPath))
                {
                    WriteStatus("No local manifest found yet.");
                    return;
                }

                Manifest manifest = GetLocalManifest();
                int count = manifest.files == null ? 0 : manifest.files.Count;
                WriteStatus("Local manifest: " + manifest.appVersion + ", " + count + " tracked files.");
            }
            catch
            {
                WriteStatus("Local manifest is present but could not be read.");
            }
        }

        private void StartSpark()
        {
            SetProgress(4);
            WriteStatus("Preparing local parser server...");
            Directory.CreateDirectory(toolsDir);

            SetProgress(14);
            EnsureRrrocket();

            SetProgress(24);
            EnsureFfmpeg();

            SetProgress(34);
            string nodeExe = ResolveNode();

            SetProgress(44);
            if (!File.Exists(ServerScriptPath)) throw new FileNotFoundException("Missing static-download-server.mjs next to this launcher.");

            SetProgress(54);
            if (!TestServer())
            {
                WriteStatus("Starting local server on 127.0.0.1:8765...");
                SetProgress(64);
                Directory.CreateDirectory(tmpDir);

                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = nodeExe;
                info.Arguments = Quote(ServerScriptPath);
                info.WorkingDirectory = root;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                info.EnvironmentVariables["SPARK_RRROCKET_PATH"] = RrrocketExePath;
                info.EnvironmentVariables["SPARK_FFMPEG_PATH"] = FfmpegExePath;

                Process serverProcess = Process.Start(info);
                bool ready = false;
                for (int i = 0; i < 40; i++)
                {
                    System.Threading.Thread.Sleep(250);
                    SetProgress(64 + Math.Min(26, (int)((i + 1) * 0.65)));
                    if (serverProcess != null && serverProcess.HasExited) break;
                    if (TestServer())
                    {
                        ready = true;
                        break;
                    }
                }

                if (!ready) throw new Exception("The local server did not respond on 127.0.0.1:8765.");
            }
            else
            {
                WriteStatus("Local server is already running.");
                SetProgress(90);
            }

            WriteStatus("Opening SPARK...");
            SetProgress(96);
            OpenSparkAppWindow();
            WriteStatus("Ready. Closing the main SPARK window shuts down the local server.");
            SetProgress(100);
        }

        private void OpenSparkAppWindow()
        {
            if (File.Exists(Program.WebView2WinFormsPath) && File.Exists(Program.WebView2CorePath) && File.Exists(Program.WebView2LoaderPath))
            {
                ProcessStartInfo appInfo = new ProcessStartInfo();
                appInfo.FileName = Application.ExecutablePath;
                appInfo.Arguments = "--spark-app-shell";
                appInfo.UseShellExecute = false;
                Process.Start(appInfo);
                WriteStatus("Opening SPARK in the native borderless app shell...");
                return;
            }

            string browserPath = ResolveAppModeBrowser();
            if (!String.IsNullOrEmpty(browserPath))
            {
                ProcessStartInfo appInfo = new ProcessStartInfo();
                appInfo.FileName = browserPath;
                appInfo.Arguments = "--app=" + appUrl + " --new-window";
                appInfo.UseShellExecute = false;
                Process.Start(appInfo);
                WriteStatus("Opening SPARK in browser app mode because WebView2 shell files are missing.");
                ApplyFramelessChromeShell();
                return;
            }

            ProcessStartInfo fallback = new ProcessStartInfo();
            fallback.FileName = appUrl;
            fallback.UseShellExecute = true;
            Process.Start(fallback);
            WriteStatus("Opening SPARK in your default browser...");
        }

        private string ResolveAppModeBrowser()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string[] candidates = new string[] {
                Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(local, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe")
            };
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private void ApplyFramelessChromeShell()
        {
            for (int attempt = 0; attempt < 60; attempt++)
            {
                IntPtr hWnd = FindSparkBrowserWindow();
                if (hWnd != IntPtr.Zero)
                {
                    MakeWindowFrameless(hWnd);
                    WriteStatus("Native browser frame hidden. SPARK frame controls are active.");
                    return;
                }
                Thread.Sleep(100);
                Application.DoEvents();
            }
            WriteStatus("SPARK opened, but the native browser frame could not be hidden.");
        }

        private static IntPtr FindSparkBrowserWindow()
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (found != IntPtr.Zero || !IsWindowVisible(hWnd)) return true;
                string title = GetWindowTextSafe(hWnd);
                string className = GetClassNameSafe(hWnd);
                bool titleMatches = title.IndexOf("SPARK", StringComparison.OrdinalIgnoreCase) >= 0;
                bool classMatches =
                    className.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    className.IndexOf("ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    className.IndexOf("WindowsForms10.Window", StringComparison.OrdinalIgnoreCase) >= 0;
                if (titleMatches && classMatches)
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        private static void MakeWindowFrameless(IntPtr hWnd)
        {
            long style = GetWindowLongPtrSafe(hWnd, GWL_STYLE).ToInt64();
            style &= ~WS_CAPTION;
            style |= WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
            SetWindowLongPtrSafe(hWnd, GWL_STYLE, new IntPtr(style));
            SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            HideNativeBorder(hWnd);
        }

        private static void HideNativeBorder(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return;
            try
            {
                int borderColor = DWMWA_COLOR_NONE;
                DwmSetWindowAttribute(hWnd, DWMWA_BORDER_COLOR, ref borderColor, sizeof(int));
            }
            catch
            {
            }
        }

        private static string GetWindowTextSafe(IntPtr hWnd)
        {
            StringBuilder buffer = new StringBuilder(256);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        private static string GetClassNameSafe(IntPtr hWnd)
        {
            StringBuilder buffer = new StringBuilder(128);
            GetClassName(hWnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        private static IntPtr GetWindowLongPtrSafe(IntPtr hWnd, int index)
        {
            return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index) : new IntPtr(GetWindowLong32(hWnd, index));
        }

        private static IntPtr SetWindowLongPtrSafe(IntPtr hWnd, int index, IntPtr value)
        {
            return IntPtr.Size == 8 ? SetWindowLongPtr64(hWnd, index, value) : new IntPtr(SetWindowLong32(hWnd, index, value.ToInt32()));
        }

        private string ResolveNode()
        {
            if (File.Exists(BundledNodePath)) return BundledNodePath;

            string systemNode = FindOnPath("node.exe");
            if (!String.IsNullOrEmpty(systemNode)) return systemNode;

            WriteStatus("Node.js was not found. Installing a portable runtime into tools\\node...");
            DownloadFile("https://nodejs.org/dist/" + nodeVersion + "/" + nodeFolder + ".zip", NodeZipPath);
            ExpandZip(NodeZipPath, Path.Combine(toolsDir, "node"));
            SafeDeleteFile(NodeZipPath);

            if (!File.Exists(BundledNodePath)) throw new FileNotFoundException("Portable Node install failed. Expected " + BundledNodePath);
            return BundledNodePath;
        }

        private void EnsureRrrocket()
        {
            if (File.Exists(RrrocketExePath)) return;

            WriteStatus("rrrocket parser was not found. Installing parser into tools\\rrrocket...");
            DownloadFile("https://github.com/nickbabcock/rrrocket/releases/download/v" + rrrocketVersion + "/" + rrrocketFolder + ".zip", RrrocketZipPath);
            ExpandZip(RrrocketZipPath, Path.Combine(toolsDir, "rrrocket"));
            SafeDeleteFile(RrrocketZipPath);

            if (!File.Exists(RrrocketExePath)) throw new FileNotFoundException("rrrocket install failed. Expected " + RrrocketExePath);
        }

        private void EnsureFfmpeg()
        {
            if (File.Exists(FfmpegExePath)) return;

            WriteStatus("FFmpeg was not found. Installing video conversion support into tools\\ffmpeg...");
            DownloadFile("https://github.com/GyanD/codexffmpeg/releases/download/" + ffmpegVersion + "/" + ffmpegFolder + ".zip", FfmpegZipPath);
            ExpandZip(FfmpegZipPath, Path.Combine(toolsDir, "ffmpeg"));
            SafeDeleteFile(FfmpegZipPath);

            if (!File.Exists(FfmpegExePath)) throw new FileNotFoundException("FFmpeg install failed. Expected " + FfmpegExePath);
        }

        private bool TestServer()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(appUrl);
                request.Timeout = 2000;
                request.ReadWriteTimeout = 2000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
            }
            catch
            {
                return false;
            }
        }

        private void UpdateSparkFromManifest()
        {
            SetProgress(4);
            Manifest remoteManifest = GetRemoteManifest();
            SetProgress(18);
            Manifest localManifest = GetLocalManifest();

            if (remoteManifest.files == null || remoteManifest.files.Count < 1) throw new Exception("The remote manifest did not list any files.");

            List<ManifestFile> changed = new List<ManifestFile>();
            for (int i = 0; i < remoteManifest.files.Count; i++)
            {
                ManifestFile file = remoteManifest.files[i];
                SetProgress(18 + Math.Min(22, (int)(((i + 1) / (double)Math.Max(1, remoteManifest.files.Count)) * 22)));
                string target = JoinSafeManifestPath(file.path);
                string localHash = GetLocalFileSha256(target);
                string remoteHash = (file.sha256 ?? "").ToLowerInvariant();
                if (localHash != remoteHash) changed.Add(file);
            }

            if (changed.Count == 0)
            {
                WriteStatus("SPARK is already up to date.");
                SetProgress(100);
                return;
            }

            WriteStatus("Found " + changed.Count + " file(s) to update.");
            string thisExe = Path.GetFullPath(Application.ExecutablePath);
            for (int i = 0; i < changed.Count; i++)
            {
                ManifestFile file = changed[i];
                string relative = file.path ?? "";
                string target = JoinSafeManifestPath(relative);
                string targetFull = Path.GetFullPath(target);
                SetProgress(40 + Math.Min(50, (int)(((i + 1) / (double)Math.Max(1, changed.Count)) * 50)));

                if (String.Equals(targetFull, thisExe, StringComparison.OrdinalIgnoreCase))
                {
                    WriteStatus("Launcher executable update is available. Skipping the running executable; it will update when using an older launcher or a fresh download.");
                    continue;
                }

                string downloadPath = Path.Combine(tmpDir, "update-" + Guid.NewGuid().ToString("N"));
                string url = githubRawBase + "/" + EncodePath(relative);
                DownloadFile(url, downloadPath);

                string downloadedHash = GetLocalFileSha256(downloadPath);
                string expectedHash = (file.sha256 ?? "").ToLowerInvariant();
                if (downloadedHash != expectedHash)
                {
                    SafeDeleteFile(downloadPath);
                    throw new Exception("Downloaded file failed hash check: " + relative + " (expected " + ShortHash(expectedHash) + ", got " + ShortHash(downloadedHash) + ")");
                }

                Directory.CreateDirectory(Path.GetDirectoryName(target));
                if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                File.Copy(downloadPath, target, true);
                SafeDeleteFile(downloadPath);
                WriteStatus("Updated " + relative);
            }

            SetProgress(94);
            string manifestDownload = Path.Combine(tmpDir, "update-manifest-" + Guid.NewGuid().ToString("N") + ".json");
            DownloadFile(githubRawBase + "/spark-manifest.json", manifestDownload);
            File.Copy(manifestDownload, ManifestPath, true);
            SafeDeleteFile(manifestDownload);

            if (localManifest != null && localManifest.appVersion != remoteManifest.appVersion) WriteStatus("Updated SPARK from " + localManifest.appVersion + " to " + remoteManifest.appVersion + ".");
            else WriteStatus("Update complete.");

            SetProgress(100);
        }

        private Manifest GetRemoteManifest()
        {
            long cache = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            string url = githubRawBase + "/spark-manifest.json?cache=" + cache;
            SetProgress(8);
            WriteStatus("Checking GitHub manifest...");
            return ParseManifestJson(DownloadString(url));
        }

        private Manifest GetLocalManifest()
        {
            if (!File.Exists(ManifestPath)) return null;
            return ParseManifestJson(File.ReadAllText(ManifestPath, Encoding.UTF8));
        }

        private static Manifest ParseManifestJson(string json)
        {
            string cleanJson = (json ?? "").TrimStart('\uFEFF');
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            return serializer.Deserialize<Manifest>(cleanJson);
        }

        private void DownloadFile(string url, string destination)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            WriteStatus("Downloading " + url);
            using (WebClient client = NewWebClient()) client.DownloadFile(url, destination);
        }

        private string DownloadString(string url)
        {
            using (WebClient client = NewWebClient()) return client.DownloadString(url);
        }

        private static WebClient NewWebClient()
        {
            WebClient client = new WebClient();
            client.Headers.Add("User-Agent", "SPARK Launcher");
            client.Encoding = Encoding.UTF8;
            return client;
        }

        private static void ExpandZip(string zipPath, string destination)
        {
            if (Directory.Exists(destination)) Directory.Delete(destination, true);
            Directory.CreateDirectory(destination);
            ZipFile.ExtractToDirectory(zipPath, destination);
        }

        private string JoinSafeManifestPath(string relativePath)
        {
            if (String.IsNullOrWhiteSpace(relativePath)) throw new Exception("Manifest contains an empty file path.");
            string normalized = relativePath.Replace('/', Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(normalized) || normalized.Split(Path.DirectorySeparatorChar).Contains(".."))
            {
                throw new Exception("Manifest contains an unsafe file path: " + relativePath);
            }

            string fullRoot = Path.GetFullPath(root + Path.DirectorySeparatorChar);
            string fullTarget = Path.GetFullPath(Path.Combine(root, normalized));
            if (!fullTarget.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) throw new Exception("Manifest path escapes the SPARK folder: " + relativePath);
            return fullTarget;
        }

        private static string ShortHash(string hash)
        {
            if (String.IsNullOrWhiteSpace(hash)) return "missing";
            string clean = hash.Trim();
            return clean.Length <= 12 ? clean : clean.Substring(0, 12);
        }

        private static string GetLocalFileSha256(string path)
        {
            if (!File.Exists(path)) return null;
            using (FileStream stream = File.OpenRead(path))
            using (SHA256 sha = SHA256.Create())
            {
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
        }

        private static string EncodePath(string relativePath)
        {
            return String.Join("/", (relativePath ?? "").Replace('\\', '/').Split('/').Select(Uri.EscapeDataString).ToArray());
        }

        private static string FindOnPath(string executable)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(Path.PathSeparator))
            {
                if (String.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), executable);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        private static void SafeDeleteFile(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch { }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
    }

    internal sealed class SparkAppShellForm : Form
    {
        private const int WS_CAPTION = unchecked((int)0x00C00000);
        private const int WS_THICKFRAME = 0x00040000;
        private const int WS_SYSMENU = 0x00080000;
        private const int WS_MINIMIZEBOX = 0x00020000;
        private const int WS_MAXIMIZEBOX = 0x00010000;
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int WM_NCCALCSIZE = 0x0083;
        private const int WM_NCHITTEST = 0x0084;
        private const int WM_NCPAINT = 0x0085;
        private const int WM_NCACTIVATE = 0x0086;
        private const int HTCAPTION = 2;
        private const int HTLEFT = 10;
        private const int HTRIGHT = 11;
        private const int HTTOP = 12;
        private const int HTTOPLEFT = 13;
        private const int HTTOPRIGHT = 14;
        private const int HTBOTTOM = 15;
        private const int HTBOTTOMLEFT = 16;
        private const int HTBOTTOMRIGHT = 17;
        private const int DWMWA_BORDER_COLOR = 34;
        private const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

        private readonly string appUrl;
        private readonly string root;
        private readonly WebView2 webView;
        private SparkPersonalOverlayForm personalOverlay;
        private Rectangle restoreBounds;
        private bool isCustomMaximized;

        public SparkAppShellForm(string appUrl, string root)
        {
            this.appUrl = appUrl;
            this.root = root;
            Text = "SPARK";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1040, 680);
            Size = new Size(1440, 920);
            BackColor = Color.Black;
            FormBorderStyle = FormBorderStyle.None;

            string iconPath = Path.Combine(root, "assets", "SPARK Launcher.ico");
            if (File.Exists(iconPath))
            {
                try { Icon = new Icon(iconPath); } catch { }
            }

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = Color.Black;
            Controls.Add(webView);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style &= ~WS_CAPTION;
                cp.Style |= WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            HideNativeBorder();
        }

        protected override async void OnShown(EventArgs e)
        {
            base.OnShown(e);
            await InitializeWebViewAsync();
        }

        private void HideNativeBorder()
        {
            if (Handle == IntPtr.Zero) return;
            try
            {
                int borderColor = DWMWA_COLOR_NONE;
                DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref borderColor, sizeof(int));
            }
            catch
            {
            }
        }

        private async Task InitializeWebViewAsync()
        {
            try
            {
                string userDataFolder = Path.Combine(root, ".tmp", "webview2-profile");
                Directory.CreateDirectory(userDataFolder);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
                {
                    args.Handled = true;
                    try
                    {
                        ProcessStartInfo info = new ProcessStartInfo();
                        info.FileName = args.Uri;
                        info.UseShellExecute = true;
                        Process.Start(info);
                    }
                    catch { }
                };
                webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                webView.CoreWebView2.Navigate(appUrl);
            }
            catch (Exception ex)
            {
                OpenBrowserFallback(ex);
            }
        }

        private void OpenBrowserFallback(Exception ex)
        {
            try
            {
                ProcessStartInfo fallback = new ProcessStartInfo();
                fallback.FileName = appUrl;
                fallback.UseShellExecute = true;
                Process.Start(fallback);
            }
            catch
            {
            }

            string detail = ex == null ? "" : "\n\n" + ex.Message;
            MessageBox.Show(
                "SPARK could not open the native app shell, so it opened in your browser instead." + detail,
                "SPARK",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            Close();
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json = e.WebMessageAsJson;
            Dictionary<string, object> message;
            try
            {
                message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                return;
            }
            if (message == null || !message.ContainsKey("type")) return;
            string type = Convert.ToString(message["type"]);
            string action = message.ContainsKey("action") ? Convert.ToString(message["action"]) : "";
            if (String.Equals(type, "spark-window-control", StringComparison.OrdinalIgnoreCase))
            {
                ApplyWindowAction(action);
                return;
            }
            if (String.Equals(type, "spark-overlay-control", StringComparison.OrdinalIgnoreCase))
            {
                ApplyOverlayAction(action);
                return;
            }
            if (String.Equals(type, "spark-replay-folder", StringComparison.OrdinalIgnoreCase))
            {
                ApplyReplayFolderAction(action);
                return;
            }
        }

        private void ApplyReplayFolderAction(string action)
        {
            action = (action ?? "").Trim().ToLowerInvariant();
            if (action != "choose") return;
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Select the folder where Rocket League saves replay files";
                dialog.ShowNewFolderButton = false;
                string defaultPath = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "My Games",
                    "Rocket League",
                    "TAGame",
                    "Demos");
                if (Directory.Exists(defaultPath)) dialog.SelectedPath = defaultPath;
                DialogResult result = dialog.ShowDialog(this);
                if (result == DialogResult.OK && !String.IsNullOrWhiteSpace(dialog.SelectedPath))
                {
                    PostReplayFolderResult(true, dialog.SelectedPath, "");
                }
                else
                {
                    PostReplayFolderResult(false, "", "Replay folder not changed");
                }
            }
        }

        private void PostReplayFolderResult(bool ok, string path, string message)
        {
            if (webView == null || webView.CoreWebView2 == null) return;
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            string payload = serializer.Serialize(new Dictionary<string, object>
            {
                {"type", "spark-replay-folder"},
                {"action", ok ? "chosen" : "cancelled"},
                {"ok", ok},
                {"path", path ?? ""},
                {"message", message ?? ""}
            });
            string script = "window.dispatchEvent(new MessageEvent('message',{data:" + serializer.Serialize(payload) + "}));";
            try { webView.CoreWebView2.ExecuteScriptAsync(script); } catch { }
        }

        private void ApplyOverlayAction(string action)
        {
            action = (action ?? "").Trim().ToLowerInvariant();
            if (action == "open-personal-overlay" || action == "toggle-personal-overlay")
            {
                if (personalOverlay != null && !personalOverlay.IsDisposed)
                {
                    if (action == "toggle-personal-overlay")
                    {
                        ClosePersonalOverlay();
                        return;
                    }
                    personalOverlay.Show();
                    personalOverlay.TopMost = true;
                    return;
                }
                string overlayUrl = "http://127.0.0.1:8765/1NE_Overlay?personal=1";
                personalOverlay = new SparkPersonalOverlayForm(overlayUrl, root, Screen.FromControl(this));
                personalOverlay.FormClosed += delegate { personalOverlay = null; };
                personalOverlay.Show(this);
                return;
            }
            if (action == "close-personal-overlay")
            {
                ClosePersonalOverlay();
            }
        }

        private void ClosePersonalOverlay()
        {
            if (personalOverlay == null || personalOverlay.IsDisposed)
            {
                personalOverlay = null;
                return;
            }
            personalOverlay.Close();
            personalOverlay = null;
        }

        private void ApplyWindowAction(string action)
        {
            action = (action ?? "").Trim().ToLowerInvariant();
            if (action == "close")
            {
                Close();
                return;
            }
            if (action == "minimize")
            {
                WindowState = FormWindowState.Minimized;
                return;
            }
            if (action == "maximize")
            {
                ToggleCustomMaximize();
                return;
            }
            int resizeHitTest = ResizeHitTestForAction(action);
            if (resizeHitTest != 0)
            {
                BeginNativeResize(resizeHitTest);
                return;
            }
            if (action == "drag")
            {
                if (isCustomMaximized) RestoreFromCustomMaximize();
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(HTCAPTION), IntPtr.Zero);
            }
        }

        private void BeginNativeResize(int hitTest)
        {
            if (isCustomMaximized || WindowState == FormWindowState.Maximized || WindowState == FormWindowState.Minimized) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(hitTest), IntPtr.Zero);
        }

        private static int ResizeHitTestForAction(string action)
        {
            switch ((action ?? "").Trim().ToLowerInvariant())
            {
                case "resize-left": return HTLEFT;
                case "resize-right": return HTRIGHT;
                case "resize-top": return HTTOP;
                case "resize-bottom": return HTBOTTOM;
                case "resize-top-left": return HTTOPLEFT;
                case "resize-top-right": return HTTOPRIGHT;
                case "resize-bottom-left": return HTBOTTOMLEFT;
                case "resize-bottom-right": return HTBOTTOMRIGHT;
                default: return 0;
            }
        }

        private void ToggleCustomMaximize()
        {
            if (isCustomMaximized)
            {
                RestoreFromCustomMaximize();
                return;
            }

            restoreBounds = Bounds;
            Rectangle workingArea = Screen.FromControl(this).WorkingArea;
            SuspendLayout();
            Bounds = workingArea;
            isCustomMaximized = true;
            HideNativeBorder();
            ResumeLayout(true);
        }

        private void RestoreFromCustomMaximize()
        {
            Rectangle targetBounds = restoreBounds;
            if (targetBounds.Width < MinimumSize.Width || targetBounds.Height < MinimumSize.Height)
            {
                targetBounds = new Rectangle(Location, SizeFromClientSize(MinimumSize));
            }

            SuspendLayout();
            Bounds = targetBounds;
            isCustomMaximized = false;
            HideNativeBorder();
            ResumeLayout(true);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_NCPAINT)
            {
                m.Result = IntPtr.Zero;
                return;
            }
            if (m.Msg == WM_NCACTIVATE)
            {
                m.Result = new IntPtr(1);
                return;
            }
            if (m.Msg == WM_NCHITTEST && !isCustomMaximized)
            {
                int border = 10;
                Point screenPoint = new Point((short)((long)m.LParam & 0xFFFF), (short)(((long)m.LParam >> 16) & 0xFFFF));
                Point point = PointToClient(screenPoint);
                bool left = point.X <= border;
                bool right = point.X >= ClientSize.Width - border;
                bool top = point.Y <= border;
                bool bottom = point.Y >= ClientSize.Height - border;
                if (left && top) { m.Result = new IntPtr(HTTOPLEFT); return; }
                if (right && top) { m.Result = new IntPtr(HTTOPRIGHT); return; }
                if (left && bottom) { m.Result = new IntPtr(HTBOTTOMLEFT); return; }
                if (right && bottom) { m.Result = new IntPtr(HTBOTTOMRIGHT); return; }
                if (left) { m.Result = new IntPtr(HTLEFT); return; }
                if (right) { m.Result = new IntPtr(HTRIGHT); return; }
                if (top) { m.Result = new IntPtr(HTTOP); return; }
                if (bottom) { m.Result = new IntPtr(HTBOTTOM); return; }
            }
            base.WndProc(ref m);
        }

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);
    }

    internal sealed class SparkPersonalOverlayForm : Form
    {
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int LWA_COLORKEY = 0x00000001;

        private static readonly Color TransparentSurfaceColor = Color.FromArgb(1, 2, 3);
        private readonly string overlayUrl;
        private readonly string root;
        private readonly Screen fallbackScreen;
        private readonly WebView2 webView;
        private readonly System.Windows.Forms.Timer placementTimer;

        public SparkPersonalOverlayForm(string overlayUrl, string root, Screen screen)
        {
            this.overlayUrl = overlayUrl;
            this.root = root;
            fallbackScreen = screen ?? Screen.PrimaryScreen;
            Text = "SPARK Personal Overlay";
            StartPosition = FormStartPosition.Manual;
            Bounds = FindRocketLeagueScreen(fallbackScreen).Bounds;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = TransparentSurfaceColor;
            TransparencyKey = TransparentSurfaceColor;

            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.BackColor = Color.Transparent;
            webView.DefaultBackgroundColor = Color.Transparent;
            Controls.Add(webView);

            placementTimer = new System.Windows.Forms.Timer();
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
            await InitializeWebViewAsync();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                placementTimer.Dispose();
            }
            base.Dispose(disposing);
        }

        private async Task InitializeWebViewAsync()
        {
            try
            {
                string userDataFolder = Path.Combine(root, ".tmp", "webview2-personal-overlay");
                Directory.CreateDirectory(userDataFolder);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
                await webView.EnsureCoreWebView2Async(environment);
                webView.DefaultBackgroundColor = Color.Transparent;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
                {
                    args.Handled = true;
                };
                webView.CoreWebView2.Navigate(overlayUrl);
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
            Rectangle targetBounds = FindRocketLeagueScreen(fallbackScreen).Bounds;
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

        private static Screen FindRocketLeagueScreen(Screen fallback)
        {
            IntPtr handle = FindRocketLeagueWindow();
            if (handle != IntPtr.Zero)
            {
                return Screen.FromHandle(handle);
            }
            return fallback ?? Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen;
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
        public static readonly string WebView2CorePath = Path.Combine(WebView2RuntimeDir, "Microsoft.Web.WebView2.Core.dll");
        public static readonly string WebView2WinFormsPath = Path.Combine(WebView2RuntimeDir, "Microsoft.Web.WebView2.WinForms.dll");
        public static readonly string WebView2LoaderPath = Path.Combine(WebView2RuntimeDir, "WebView2Loader.dll");
        private const string AppUrl = "http://127.0.0.1:8765/SPARK.html";

        [STAThread]
        private static void Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += ResolveSparkAssembly;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Any(arg => String.Equals(arg, "--spark-app-shell", StringComparison.OrdinalIgnoreCase)))
            {
                Application.Run(new SparkAppShellForm(AppUrl, Root));
                return;
            }
            Application.Run(new LauncherForm());
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
