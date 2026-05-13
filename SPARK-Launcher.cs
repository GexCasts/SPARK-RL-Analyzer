using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace SparkLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "SPARK-Launcher.ps1");

            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "SPARK-Launcher.ps1 was not found next to SPARK Launcher.exe.",
                    "SPARK Launcher",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = root,
                UseShellExecute = true
            };

            Process.Start(info);
        }
    }
}
