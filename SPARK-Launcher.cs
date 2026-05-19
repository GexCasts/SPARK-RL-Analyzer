using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

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
        private readonly string root;
        private readonly string toolsDir;
        private readonly string tmpDir;
        private readonly string nodeVersion = "v22.11.0";
        private readonly string nodeFolder = "node-v22.11.0-win-x64";
        private readonly string rrrocketVersion = "0.11.1";
        private readonly string rrrocketFolder = "rrrocket-0.11.1-x86_64-pc-windows-msvc";
        private readonly string githubRawBase = "https://raw.githubusercontent.com/GexCasts/SPARK-RL-Analyzer/main";
        private readonly string appUrl = "http://127.0.0.1:8765/";

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

        private string NodeZipPath { get { return Path.Combine(toolsDir, nodeFolder + ".zip"); } }
        private string BundledNodePath { get { return Path.Combine(toolsDir, "node", nodeFolder, "node.exe"); } }
        private string RrrocketZipPath { get { return Path.Combine(toolsDir, "rrrocket", rrrocketFolder + ".zip"); } }
        private string RrrocketExePath { get { return Path.Combine(toolsDir, "rrrocket", rrrocketFolder, "rrrocket.exe"); } }
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

            SetProgress(28);
            string nodeExe = ResolveNode();

            SetProgress(42);
            if (!File.Exists(ServerScriptPath)) throw new FileNotFoundException("Missing static-download-server.mjs next to this launcher.");

            SetProgress(52);
            if (!TestServer())
            {
                WriteStatus("Starting local server on 127.0.0.1:8765...");
                SetProgress(62);
                Directory.CreateDirectory(tmpDir);

                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = nodeExe;
                info.Arguments = Quote(ServerScriptPath);
                info.WorkingDirectory = root;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;

                Process serverProcess = Process.Start(info);
                bool ready = false;
                for (int i = 0; i < 40; i++)
                {
                    System.Threading.Thread.Sleep(250);
                    SetProgress(62 + Math.Min(28, (int)((i + 1) * 0.7)));
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
            Process.Start(appUrl);
            WriteStatus("Ready. The local server shuts itself down after all SPARK tabs and overlay sources are closed.");
            SetProgress(100);
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
                if (downloadedHash != (file.sha256 ?? "").ToLowerInvariant())
                {
                    SafeDeleteFile(downloadPath);
                    throw new Exception("Downloaded file failed hash check: " + relative);
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
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}
