using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SparkPersonalOverlay
{
    internal sealed class OverlayForm : Form
    {
        private const int WS_EX_TRANSPARENT = 0x00000020;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_LAYERED = 0x00080000;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        private static readonly Color TransparentSurfaceColor = Color.FromArgb(1, 2, 3);
        private readonly string root;
        private readonly System.Windows.Forms.Timer placementTimer;
        private readonly System.Windows.Forms.Timer renderTimer;
        private readonly object stateLock = new object();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly OverlayState state = new OverlayState();
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private OverlayConfig config = new OverlayConfig();
        private long lastConfigTicks;

        public OverlayForm(string url, string root)
        {
            this.root = root;
            serializer.MaxJsonLength = Int32.MaxValue;
            Text = "SPARK Personal Overlay";
            StartPosition = FormStartPosition.Manual;
            Bounds = FindRocketLeagueScreen().Bounds;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = TransparentSurfaceColor;
            TransparencyKey = TransparentSurfaceColor;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

            placementTimer = new System.Windows.Forms.Timer();
            placementTimer.Interval = 1500;
            placementTimer.Tick += delegate { SyncToRocketLeagueScreen(); };

            renderTimer = new System.Windows.Forms.Timer();
            renderTimer.Interval = 100;
            renderTimer.Tick += delegate
            {
                LoadOverlayConfig(false);
                Invalidate();
            };
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

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            LoadOverlayConfig(true);
            SyncToRocketLeagueScreen();
            placementTimer.Start();
            renderTimer.Start();
            Task.Run(() => LiveApiLoop(stop.Token));
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(TransparentSurfaceColor);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            try
            {
                base.OnPaint(e);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                float scale = Math.Min(ClientSize.Width / 1920f, ClientSize.Height / 1080f);
                if (scale <= 0) scale = 1f;
                e.Graphics.TranslateTransform((ClientSize.Width - 1920f * scale) / 2f, (ClientSize.Height - 1080f * scale) / 2f);
                e.Graphics.ScaleTransform(scale, scale);

                OverlaySnapshot snap;
                lock (stateLock) snap = state.Snapshot();
                DrawOverlay(e.Graphics, snap, config);
            }
            catch
            {
                e.Graphics.Clear(TransparentSurfaceColor);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                stop.Cancel();
                placementTimer.Dispose();
                renderTimer.Dispose();
            }
            base.Dispose(disposing);
        }

        private void DrawOverlay(Graphics g, OverlaySnapshot snap, OverlayConfig cfg)
        {
            string blueName = String.IsNullOrWhiteSpace(cfg.BlueTeamName) ? snap.BlueName : cfg.BlueTeamName;
            string orangeName = String.IsNullOrWhiteSpace(cfg.OrangeTeamName) ? snap.OrangeName : cfg.OrangeTeamName;
            DrawScoreboard(g, blueName, orangeName, snap.BlueScore, snap.OrangeScore, snap.Clock, cfg);
            DrawBoostRows(g, snap.Players.Where(p => p.Team == "Blue").ToList(), true, cfg);
            DrawBoostRows(g, snap.Players.Where(p => p.Team == "Orange").ToList(), false, cfg);

            PlayerState focus = snap.Players.FirstOrDefault(p => NamesMatch(p.Name, snap.FocusedPlayerName));
            if (focus != null) DrawFocusCard(g, focus, cfg);
            if (snap.ReplayActive) DrawReplayBanner(g, cfg);
            if (!snap.Connected || snap.UpdateCount == 0) DrawWaitingBadge(g, "SPARK personal overlay", "Waiting for live feed", cfg);
        }

        private void DrawScoreboard(Graphics g, string blueName, string orangeName, int blueScore, int orangeScore, double clock, OverlayConfig cfg)
        {
            Color blue = cfg.BlueBoostColor;
            Color orange = cfg.OrangeBoostColor;
            Color text = cfg.TextColor;
            Color accent = cfg.AccentColor;
            using (Font teamFont = FontFor(25, FontStyle.Bold))
            using (Font scoreFont = FontFor(38, FontStyle.Bold))
            using (Font clockFont = FontFor(37, FontStyle.Bold))
            using (Font tagFont = FontFor(9, FontStyle.Bold))
            {
                FillRound(g, new RectangleF(418, 18, 404, 55), Color.FromArgb(224, 6, 8, 12), 8);
                FillRound(g, new RectangleF(1098, 18, 404, 55), Color.FromArgb(224, 6, 8, 12), 8);
                FillRound(g, new RectangleF(822, 18, 92, 55), blue, 5);
                FillRound(g, new RectangleF(1006, 18, 92, 55), orange, 5);
                FillRound(g, new RectangleF(914, 18, 92, 55), Color.FromArgb(232, 72, 72, 72), 4);
                FillRound(g, new RectangleF(856, 76, 208, 15), Color.FromArgb(190, 5, 6, 9), 5);

                DrawText(g, blueName.ToUpperInvariant(), teamFont, text, new RectangleF(440, 18, 352, 55), ContentAlignment.MiddleCenter);
                DrawText(g, orangeName.ToUpperInvariant(), teamFont, text, new RectangleF(1128, 18, 352, 55), ContentAlignment.MiddleCenter);
                DrawText(g, blueScore.ToString(), scoreFont, Color.White, new RectangleF(822, 18, 92, 55), ContentAlignment.MiddleCenter);
                DrawText(g, orangeScore.ToString(), scoreFont, Color.White, new RectangleF(1006, 18, 92, 55), ContentAlignment.MiddleCenter);
                DrawText(g, FormatClock(clock), clockFont, Color.White, new RectangleF(914, 18, 92, 55), ContentAlignment.MiddleCenter);
                DrawText(g, SeriesLabel(cfg), tagFont, Color.FromArgb(230, accent), new RectangleF(856, 76, 208, 15), ContentAlignment.MiddleCenter);
            }
        }

        private void DrawBoostRows(Graphics g, List<PlayerState> players, bool blueSide, OverlayConfig cfg)
        {
            players = players
                .OrderBy(p => p.Shortcut)
                .ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
                .Take(6)
                .ToList();
            float x = blueSide ? 36 : 1648;
            float y = 116;
            float w = 236;
            float h = 24;
            Color team = blueSide ? cfg.BlueBoostColor : cfg.OrangeBoostColor;
            using (Font nameFont = FontFor(11, FontStyle.Bold))
            using (Font valueFont = FontFor(11, FontStyle.Bold))
            {
                for (int i = 0; i < players.Count; i++)
                {
                    PlayerState player = players[i];
                    RectangleF row = new RectangleF(x, y + i * 30, w, h);
                    FillRound(g, row, Color.FromArgb(210, 5, 6, 9), 4);
                    using (Pen pen = new Pen(Color.FromArgb(170, team), 1f)) g.DrawRectangle(pen, row.X, row.Y, row.Width, row.Height);
                    float boostWidth = Math.Max(0, Math.Min(100, player.Boost)) / 100f * (w - 44);
                    RectangleF bar = blueSide
                        ? new RectangleF(row.X + 2, row.Y + 2, boostWidth, h - 4)
                        : new RectangleF(row.Right - 2 - boostWidth, row.Y + 2, boostWidth, h - 4);
                    if (bar.Width > 0.5f && bar.Height > 0.5f)
                    {
                        using (LinearGradientBrush brush = new LinearGradientBrush(bar, Color.FromArgb(210, team), Color.FromArgb(220, cfg.AccentColor), LinearGradientMode.Horizontal))
                        {
                            g.FillRectangle(brush, bar);
                        }
                    }
                    RectangleF valueBox = blueSide ? new RectangleF(row.Right - 38, row.Y, 38, h) : new RectangleF(row.X, row.Y, 38, h);
                    g.FillRectangle(new SolidBrush(Color.FromArgb(175, 0, 0, 0)), valueBox);
                    RectangleF nameBox = blueSide ? new RectangleF(row.X + 8, row.Y, w - 52, h) : new RectangleF(row.X + 44, row.Y, w - 52, h);
                    DrawText(g, TrimName(player.Name), nameFont, cfg.BoostTextColor, nameBox, blueSide ? ContentAlignment.MiddleLeft : ContentAlignment.MiddleRight);
                    DrawText(g, player.Boost.ToString(), valueFont, cfg.AccentColor, valueBox, ContentAlignment.MiddleCenter);
                }
            }
        }

        private void DrawFocusCard(Graphics g, PlayerState player, OverlayConfig cfg)
        {
            RectangleF card = new RectangleF(36, 820, 322, 112);
            FillRound(g, card, Color.FromArgb(215, 5, 6, 9), 6);
            using (Pen pen = new Pen(Color.FromArgb(195, cfg.AccentColor), 1.5f)) DrawRound(g, pen, card, 6);
            using (Font titleFont = FontFor(12, FontStyle.Bold))
            using (Font statFont = FontFor(18, FontStyle.Bold))
            using (Font labelFont = FontFor(8, FontStyle.Bold))
            {
                DrawText(g, TrimName(player.Name).ToUpperInvariant(), titleFont, cfg.TextColor, new RectangleF(50, 832, 206, 20), ContentAlignment.MiddleLeft);
                DrawText(g, "FOCUSED", labelFont, cfg.AccentColor, new RectangleF(236, 832, 100, 20), ContentAlignment.MiddleRight);
                DrawStat(g, "Goals", player.Goals, 52, 864, statFont, labelFont, cfg);
                DrawStat(g, "Shots", player.Shots, 118, 864, statFont, labelFont, cfg);
                DrawStat(g, "Assists", player.Assists, 184, 864, statFont, labelFont, cfg);
                DrawStat(g, "Saves", player.Saves, 250, 864, statFont, labelFont, cfg);
                RectangleF track = new RectangleF(52, 910, 248, 10);
                FillRound(g, track, Color.FromArgb(190, 36, 38, 44), 5);
                RectangleF fill = new RectangleF(track.X, track.Y, track.Width * Math.Max(0, Math.Min(100, player.Boost)) / 100f, track.Height);
                if (fill.Width > 0.5f) FillRound(g, fill, cfg.AccentColor, 5);
                DrawText(g, player.Boost + " boost", labelFont, cfg.TextColor, new RectangleF(304, 902, 45, 24), ContentAlignment.MiddleLeft);
            }
        }

        private void DrawStat(Graphics g, string label, int value, float x, float y, Font statFont, Font labelFont, OverlayConfig cfg)
        {
            DrawText(g, value.ToString(), statFont, cfg.TextColor, new RectangleF(x, y, 54, 24), ContentAlignment.MiddleCenter);
            DrawText(g, label, labelFont, Color.FromArgb(210, cfg.TextColor), new RectangleF(x, y + 23, 54, 13), ContentAlignment.MiddleCenter);
        }

        private void DrawReplayBanner(Graphics g, OverlayConfig cfg)
        {
            using (Font font = FontFor(26, FontStyle.Bold))
            {
                FillRound(g, new RectangleF(780, 1008, 360, 46), Color.FromArgb(220, cfg.AccentColor), 12);
                DrawText(g, "REPLAY", font, Color.FromArgb(8, 8, 8), new RectangleF(780, 1008, 360, 46), ContentAlignment.MiddleCenter);
            }
        }

        private void DrawWaitingBadge(Graphics g, string title, string detail, OverlayConfig cfg)
        {
            RectangleF badge = new RectangleF(24, 1014, 230, 46);
            FillRound(g, badge, Color.FromArgb(220, 5, 6, 9), 7);
            using (Pen pen = new Pen(Color.FromArgb(205, cfg.AccentColor), 1f)) DrawRound(g, pen, badge, 7);
            using (Font titleFont = FontFor(9, FontStyle.Bold))
            using (Font detailFont = FontFor(8, FontStyle.Regular))
            {
                DrawText(g, title.ToUpperInvariant(), titleFont, cfg.AccentColor, new RectangleF(34, 1019, 210, 16), ContentAlignment.MiddleLeft);
                DrawText(g, detail, detailFont, Color.FromArgb(220, cfg.TextColor), new RectangleF(34, 1036, 210, 16), ContentAlignment.MiddleLeft);
            }
        }

        private void DrawText(Graphics g, string text, Font font, Color color, RectangleF rect, ContentAlignment alignment)
        {
            using (StringFormat format = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
            using (SolidBrush brush = new SolidBrush(color))
            {
                format.Alignment = alignment == ContentAlignment.MiddleRight ? StringAlignment.Far : alignment == ContentAlignment.MiddleCenter ? StringAlignment.Center : StringAlignment.Near;
                format.LineAlignment = StringAlignment.Center;
                g.DrawString(text ?? "", font, brush, rect, format);
            }
        }

        private void FillRound(Graphics g, RectangleF rect, Color color, float radius)
        {
            if (rect.Width <= 0.5f || rect.Height <= 0.5f) return;
            using (GraphicsPath path = RoundPath(rect, radius))
            using (SolidBrush brush = new SolidBrush(color))
            {
                g.FillPath(brush, path);
            }
        }

        private void DrawRound(Graphics g, Pen pen, RectangleF rect, float radius)
        {
            if (rect.Width <= 0.5f || rect.Height <= 0.5f) return;
            using (GraphicsPath path = RoundPath(rect, radius))
            {
                g.DrawPath(pen, path);
            }
        }

        private GraphicsPath RoundPath(RectangleF rect, float radius)
        {
            float d = Math.Min(radius * 2f, Math.Min(rect.Width, rect.Height));
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private Font FontFor(float size, FontStyle style)
        {
            return new Font("Segoe UI", size, style, GraphicsUnit.Pixel);
        }

        private void LiveApiLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using (TcpClient client = new TcpClient())
                    {
                        client.Connect("127.0.0.1", 8765);
                        using (NetworkStream stream = client.GetStream())
                        {
                            stream.ReadTimeout = 5000;
                            stream.WriteTimeout = 5000;
                            SendWebSocketHandshake(stream);
                            ReadHandshake(stream);
                            lock (stateLock)
                            {
                                state.Connected = true;
                                state.LastMessageUtc = DateTime.UtcNow;
                            }
                            BeginInvokeSafe(Invalidate);
                            while (!token.IsCancellationRequested && client.Connected)
                            {
                                string message = ReadWebSocketText(stream);
                                if (message == null) break;
                                HandleLiveApiMessage(message);
                            }
                        }
                    }
                }
                catch
                {
                    lock (stateLock) state.Connected = false;
                    BeginInvokeSafe(Invalidate);
                    Thread.Sleep(1500);
                }
            }
        }

        private void SendWebSocketHandshake(NetworkStream stream)
        {
            string key = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
            string request =
                "GET /api/live-api HTTP/1.1\r\n" +
                "Host: 127.0.0.1:8765\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: " + key + "\r\n" +
                "Sec-WebSocket-Version: 13\r\n\r\n";
            byte[] bytes = Encoding.ASCII.GetBytes(request);
            stream.Write(bytes, 0, bytes.Length);
        }

        private void ReadHandshake(NetworkStream stream)
        {
            List<byte> bytes = new List<byte>();
            while (bytes.Count < 8192)
            {
                int value = stream.ReadByte();
                if (value < 0) throw new IOException("SPARK live API bridge closed.");
                bytes.Add((byte)value);
                int n = bytes.Count;
                if (n >= 4 && bytes[n - 4] == 13 && bytes[n - 3] == 10 && bytes[n - 2] == 13 && bytes[n - 1] == 10) break;
            }
            string header = Encoding.ASCII.GetString(bytes.ToArray());
            if (!header.StartsWith("HTTP/1.1 101", StringComparison.OrdinalIgnoreCase)) throw new IOException("SPARK live API bridge did not accept the overlay connection.");
        }

        private string ReadWebSocketText(NetworkStream stream)
        {
            int first = stream.ReadByte();
            if (first < 0) return null;
            int second = stream.ReadByte();
            if (second < 0) return null;
            int opcode = first & 0x0f;
            bool masked = (second & 0x80) != 0;
            ulong length = (ulong)(second & 0x7f);
            if (length == 126)
            {
                byte[] ext = ReadExact(stream, 2);
                length = (ulong)((ext[0] << 8) | ext[1]);
            }
            else if (length == 127)
            {
                byte[] ext = ReadExact(stream, 8);
                length = 0;
                for (int i = 0; i < 8; i++) length = (length << 8) | ext[i];
            }
            byte[] mask = masked ? ReadExact(stream, 4) : null;
            byte[] payload = ReadExact(stream, checked((int)length));
            if (masked && mask != null)
            {
                for (int i = 0; i < payload.Length; i++) payload[i] = (byte)(payload[i] ^ mask[i % 4]);
            }
            if (opcode == 8) return null;
            if (opcode != 1) return "";
            return Encoding.UTF8.GetString(payload);
        }

        private byte[] ReadExact(NetworkStream stream, int count)
        {
            byte[] buffer = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buffer, offset, count - offset);
                if (read <= 0) throw new IOException("SPARK live API bridge closed.");
                offset += read;
            }
            return buffer;
        }

        private void HandleLiveApiMessage(string text)
        {
            if (String.IsNullOrWhiteSpace(text)) return;
            try
            {
                Dictionary<string, object> msg = AsDictionary(serializer.DeserializeObject(text));
                if (msg == null) return;
                string eventName = Compact(Convert.ToString(First(msg, "event", "Event", "type", "Type", "name", "Name") ?? ""));
                object payloadObj = First(msg, "data", "Data", "payload", "Payload") ?? msg;
                if (payloadObj is string)
                {
                    string payloadText = Convert.ToString(payloadObj).Trim();
                    if (payloadText.StartsWith("{") || payloadText.StartsWith("[")) payloadObj = serializer.DeserializeObject(payloadText);
                }
                Dictionary<string, object> payload = AsDictionary(payloadObj) ?? msg;
                lock (stateLock)
                {
                    state.Connected = true;
                    state.UpdateCount++;
                    state.LastMessageUtc = DateTime.UtcNow;
                    double? clock = GameClock(payload);
                    if (clock.HasValue) state.Clock = clock.Value;
                    bool? replay = ReplayFlag(payload);
                    if (replay.HasValue) state.ReplayActive = replay.Value;
                    if (eventName.Contains("goalreplay")) state.ReplayActive = !(eventName.Contains("ended") || eventName.EndsWith("end") || eventName.Contains("willend"));
                    UpdateTeams(payload);
                    UpdatePlayers(payload);
                    string focus = FocusName(payload);
                    if (!String.IsNullOrWhiteSpace(focus)) state.FocusedPlayerName = focus;
                    if (eventName.Contains("statfeed")) UpdateStatFeed(payload);
                }
                BeginInvokeSafe(Invalidate);
            }
            catch
            {
            }
        }

        private void UpdateTeams(Dictionary<string, object> payload)
        {
            object teamsObj = First(payload, "Teams", "teams") ?? First(Game(payload), "Teams", "teams");
            foreach (Dictionary<string, object> team in EnumerateObjects(teamsObj))
            {
                string side = NormalizeTeam(First(team, "TeamNum", "teamNum", "Team", "team", "Index", "index"));
                if (String.IsNullOrWhiteSpace(side)) continue;
                TeamState target = side == "Blue" ? state.Blue : state.Orange;
                string name = Convert.ToString(First(team, "Name", "name", "TeamName", "teamName") ?? "");
                if (!String.IsNullOrWhiteSpace(name)) target.Name = name;
                object score = First(team, "Score", "score", "Goals", "goals");
                if (score != null) target.Score = Math.Max(0, ToInt(score, target.Score));
            }
        }

        private void UpdatePlayers(Dictionary<string, object> payload)
        {
            foreach (Dictionary<string, object> player in EnumeratePlayers(payload))
            {
                string name = CleanName(Convert.ToString(First(player, "Name", "name", "PlayerName", "playerName", "Player", "player", "__playerKey") ?? ""));
                if (String.IsNullOrWhiteSpace(name)) continue;
                string team = NormalizeTeam(First(player, "TeamNum", "teamNum", "Team", "team", "playerTeam", "PlayerTeam"));
                PlayerState target = state.GetPlayer(name);
                target.Name = name;
                if (!String.IsNullOrWhiteSpace(team)) target.Team = team;
                target.Shortcut = ToInt(First(player, "Shortcut", "shortcut", "Index", "index"), target.Shortcut);
                target.Score = ToInt(First(player, "Score", "score", "Points", "points"), target.Score);
                target.Goals = ToInt(First(player, "Goals", "goals"), target.Goals);
                target.Shots = ToInt(First(player, "Shots", "shots"), target.Shots);
                target.Assists = ToInt(First(player, "Assists", "assists"), target.Assists);
                target.Saves = ToInt(First(player, "Saves", "saves"), target.Saves);
                target.Demos = ToInt(First(player, "Demos", "demos", "Demolitions", "demolitions"), target.Demos);
                int? boost = BoostValue(player);
                if (boost.HasValue) target.Boost = boost.Value;
            }
        }

        private void UpdateStatFeed(Dictionary<string, object> payload)
        {
            string playerName = CleanName(Convert.ToString(First(payload, "MainTarget", "mainTarget", "Player", "player", "Target", "target") ?? ""));
            if (String.IsNullOrWhiteSpace(playerName)) return;
            PlayerState player = state.GetPlayer(playerName);
            string type = Convert.ToString(First(payload, "Type", "type", "EventName", "eventName") ?? "").ToLowerInvariant();
            if (type.Contains("goal")) player.Goals++;
            if (type.Contains("shot")) player.Shots++;
            if (type.Contains("assist")) player.Assists++;
            if (type.Contains("save")) player.Saves++;
            if (type.Contains("demo")) player.Demos++;
        }

        private IEnumerable<Dictionary<string, object>> EnumeratePlayers(Dictionary<string, object> payload)
        {
            object players = First(payload, "Players", "players") ?? First(Game(payload), "Players", "players");
            return EnumerateObjects(players);
        }

        private IEnumerable<Dictionary<string, object>> EnumerateObjects(object value)
        {
            if (value is object[])
            {
                foreach (object item in (object[])value)
                {
                    Dictionary<string, object> dict = AsDictionary(item);
                    if (dict != null) yield return dict;
                }
            }
            else if (value is ArrayList)
            {
                foreach (object item in (ArrayList)value)
                {
                    Dictionary<string, object> dict = AsDictionary(item);
                    if (dict != null) yield return dict;
                }
            }
            else
            {
                Dictionary<string, object> dict = AsDictionary(value);
                if (dict != null)
                {
                    bool keyedCollection = dict.Values.Any(v => AsDictionary(v) != null);
                    if (keyedCollection)
                    {
                        foreach (KeyValuePair<string, object> pair in dict)
                        {
                            Dictionary<string, object> item = AsDictionary(pair.Value);
                            if (item != null)
                            {
                                if (!item.ContainsKey("__playerKey")) item["__playerKey"] = pair.Key;
                                yield return item;
                            }
                        }
                    }
                    else yield return dict;
                }
            }
        }

        private Dictionary<string, object> Game(Dictionary<string, object> payload)
        {
            return AsDictionary(First(payload, "Game", "game")) ?? payload;
        }

        private double? GameClock(Dictionary<string, object> payload)
        {
            Dictionary<string, object> game = Game(payload);
            object raw = First(payload, "gameSecondsRemaining", "GameSecondsRemaining", "secondsRemaining", "SecondsRemaining", "timeRemaining", "TimeRemaining", "TimeSeconds", "timeSeconds")
                ?? First(game, "gameSecondsRemaining", "GameSecondsRemaining", "secondsRemaining", "SecondsRemaining", "timeRemaining", "TimeRemaining", "TimeSeconds", "timeSeconds");
            if (raw == null) return null;
            double value;
            return Double.TryParse(Convert.ToString(raw), out value) ? (double?)value : null;
        }

        private bool? ReplayFlag(Dictionary<string, object> payload)
        {
            Dictionary<string, object> game = Game(payload);
            object raw = First(payload, "bReplay", "replay", "Replay", "isReplay", "IsReplay") ?? First(game, "bReplay", "replay", "Replay", "isReplay", "IsReplay");
            if (raw == null) return null;
            return ToBool(raw);
        }

        private string FocusName(Dictionary<string, object> payload)
        {
            Dictionary<string, object> game = Game(payload);
            object raw = First(payload, "FocusedPlayer", "focusedPlayer", "FocusPlayer", "focusPlayer", "CameraPlayer", "cameraPlayer", "CameraTarget", "cameraTarget", "GameCameraPlayer", "gameCameraPlayer", "TargetPlayer", "targetPlayer", "Target", "target", "ViewedPlayer", "viewedPlayer", "SpectatedPlayer", "spectatedPlayer")
                ?? First(game, "FocusedPlayer", "focusedPlayer", "FocusPlayer", "focusPlayer", "CameraPlayer", "cameraPlayer", "CameraTarget", "cameraTarget", "MainTarget", "mainTarget", "TargetPlayer", "targetPlayer", "Target", "target", "ViewedPlayer", "viewedPlayer", "SpectatedPlayer", "spectatedPlayer");
            Dictionary<string, object> dict = AsDictionary(raw);
            if (dict != null) raw = First(dict, "Name", "name", "PlayerName", "playerName", "Player", "player", "Id", "id");
            return CleanName(Convert.ToString(raw ?? ""));
        }

        private int? BoostValue(Dictionary<string, object> player)
        {
            foreach (Dictionary<string, object> source in new[] { player, AsDictionary(First(player, "Car", "car")), AsDictionary(First(player, "State", "state")), AsDictionary(First(player, "ReplicatedBoost", "replicatedBoost")) })
            {
                if (source == null) continue;
                object raw = First(source, "boost", "Boost", "boostAmount", "BoostAmount", "boost_amount", "BoostPercent", "boostPercent", "currentBoost", "CurrentBoost", "BoostCurrent", "boostCurrent");
                if (raw == null || raw is bool) continue;
                double n;
                if (!Double.TryParse(Convert.ToString(raw), out n)) continue;
                if (n > 100 && n <= 255) n = n / 2.55;
                return Math.Max(0, Math.Min(100, (int)Math.Round(n)));
            }
            return null;
        }

        private object First(Dictionary<string, object> dict, params string[] names)
        {
            if (dict == null) return null;
            foreach (string name in names)
            {
                if (dict.ContainsKey(name)) return dict[name];
            }
            foreach (KeyValuePair<string, object> pair in dict)
            {
                if (names.Any(name => String.Equals(name, pair.Key, StringComparison.OrdinalIgnoreCase))) return pair.Value;
            }
            return null;
        }

        private Dictionary<string, object> AsDictionary(object value)
        {
            return value as Dictionary<string, object>;
        }

        private string NormalizeTeam(object value)
        {
            Dictionary<string, object> dict = AsDictionary(value);
            if (dict != null) value = First(dict, "TeamNum", "teamNum", "Team", "team");
            string text = Convert.ToString(value ?? "").Trim();
            if (text == "0") return "Blue";
            if (text == "1") return "Orange";
            if (text.IndexOf("blue", StringComparison.OrdinalIgnoreCase) >= 0) return "Blue";
            if (text.IndexOf("orange", StringComparison.OrdinalIgnoreCase) >= 0) return "Orange";
            return "";
        }

        private int ToInt(object value, int fallback)
        {
            if (value == null) return fallback;
            double n;
            return Double.TryParse(Convert.ToString(value), out n) ? Math.Max(0, (int)Math.Round(n)) : fallback;
        }

        private bool ToBool(object value)
        {
            if (value is bool) return (bool)value;
            string text = Convert.ToString(value ?? "").Trim().ToLowerInvariant();
            return text == "1" || text == "true" || text == "yes";
        }

        private string Compact(string value)
        {
            return new string((value ?? "").ToLowerInvariant().Where(Char.IsLetterOrDigit).ToArray());
        }

        private string CleanName(string name)
        {
            return String.IsNullOrWhiteSpace(name) ? "" : name.Trim();
        }

        private string TrimName(string name)
        {
            name = CleanName(name);
            return name.Length <= 14 ? name : name.Substring(0, 14);
        }

        private bool NamesMatch(string left, string right)
        {
            return String.Equals(CleanName(left), CleanName(right), StringComparison.OrdinalIgnoreCase);
        }

        private string FormatClock(double seconds)
        {
            if (seconds < 0)
            {
                int ot = (int)Math.Round(Math.Abs(seconds));
                return "+" + (ot / 60) + ":" + (ot % 60).ToString("00");
            }
            int total = Math.Max(0, (int)Math.Ceiling(seconds));
            return (total / 60) + ":" + (total % 60).ToString("00");
        }

        private string SeriesLabel(OverlayConfig cfg)
        {
            return "BEST OF " + cfg.SeriesBestOf + "   " + cfg.BlueSeriesScore + "-" + cfg.OrangeSeriesScore;
        }

        private void LoadOverlayConfig(bool force)
        {
            string file = Path.Combine(root, ".tmp", "overlay-assets", "overlay-config.json");
            try
            {
                if (!File.Exists(file)) return;
                long ticks = File.GetLastWriteTimeUtc(file).Ticks;
                if (!force && ticks == lastConfigTicks) return;
                lastConfigTicks = ticks;
                Dictionary<string, object> raw = AsDictionary(serializer.DeserializeObject(File.ReadAllText(file))) ?? new Dictionary<string, object>();
                config = OverlayConfig.From(raw);
            }
            catch
            {
            }
        }

        private void BeginInvokeSafe(Action action)
        {
            try
            {
                if (!IsDisposed && IsHandleCreated) BeginInvoke(action);
            }
            catch
            {
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
        }

        private static Screen FindRocketLeagueScreen()
        {
            IntPtr handle = FindRocketLeagueWindow();
            if (handle != IntPtr.Zero) return Screen.FromHandle(handle);
            return Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen;
        }

        private static IntPtr FindRocketLeagueWindow()
        {
            try
            {
                foreach (Process process in Process.GetProcessesByName("RocketLeague"))
                {
                    if (process.MainWindowHandle != IntPtr.Zero) return process.MainWindowHandle;
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
    }

    internal sealed class OverlayConfig
    {
        public string BlueTeamName = "";
        public string OrangeTeamName = "";
        public int SeriesBestOf = 5;
        public int BlueSeriesScore;
        public int OrangeSeriesScore;
        public Color TextColor = Color.FromArgb(247, 247, 244);
        public Color AccentColor = Color.FromArgb(255, 208, 0);
        public Color BlueBoostColor = Color.FromArgb(27, 140, 255);
        public Color OrangeBoostColor = Color.FromArgb(255, 132, 0);
        public Color BoostTextColor = Color.FromArgb(247, 247, 244);

        public static OverlayConfig From(Dictionary<string, object> raw)
        {
            OverlayConfig cfg = new OverlayConfig();
            cfg.BlueTeamName = Convert.ToString(Value(raw, "blueTeamName") ?? "");
            cfg.OrangeTeamName = Convert.ToString(Value(raw, "orangeTeamName") ?? "");
            cfg.SeriesBestOf = ClampInt(Value(raw, "seriesBestOf"), 5, 3, 7);
            cfg.BlueSeriesScore = ClampInt(Value(raw, "blueSeriesScore"), 0, 0, 4);
            cfg.OrangeSeriesScore = ClampInt(Value(raw, "orangeSeriesScore"), 0, 0, 4);
            cfg.TextColor = ParseColor(Value(raw, "overlayTextColor"), cfg.TextColor);
            cfg.AccentColor = ParseColor(Value(raw, "overlayAccentColor"), cfg.AccentColor);
            cfg.BlueBoostColor = ParseColor(Value(raw, "overlayBlueBoostColor"), cfg.BlueBoostColor);
            cfg.OrangeBoostColor = ParseColor(Value(raw, "overlayOrangeBoostColor"), cfg.OrangeBoostColor);
            cfg.BoostTextColor = ParseColor(Value(raw, "overlayBoostTextColor"), cfg.BoostTextColor);
            return cfg;
        }

        private static object Value(Dictionary<string, object> raw, string key)
        {
            return raw != null && raw.ContainsKey(key) ? raw[key] : null;
        }

        private static int ClampInt(object value, int fallback, int min, int max)
        {
            int n;
            if (!Int32.TryParse(Convert.ToString(value ?? ""), out n)) n = fallback;
            return Math.Max(min, Math.Min(max, n));
        }

        private static Color ParseColor(object value, Color fallback)
        {
            string text = Convert.ToString(value ?? "").Trim();
            if (!text.StartsWith("#") || (text.Length != 7 && text.Length != 9)) return fallback;
            try
            {
                int r = Convert.ToInt32(text.Substring(1, 2), 16);
                int g = Convert.ToInt32(text.Substring(3, 2), 16);
                int b = Convert.ToInt32(text.Substring(5, 2), 16);
                return Color.FromArgb(r, g, b);
            }
            catch
            {
                return fallback;
            }
        }
    }

    internal sealed class OverlayState
    {
        public bool Connected;
        public int UpdateCount;
        public DateTime LastMessageUtc = DateTime.MinValue;
        public double Clock = 300;
        public bool ReplayActive;
        public string FocusedPlayerName = "";
        public readonly TeamState Blue = new TeamState { Name = "Blue" };
        public readonly TeamState Orange = new TeamState { Name = "Orange" };
        private readonly Dictionary<string, PlayerState> players = new Dictionary<string, PlayerState>(StringComparer.OrdinalIgnoreCase);

        public PlayerState GetPlayer(string name)
        {
            if (!players.ContainsKey(name)) players[name] = new PlayerState { Name = name };
            return players[name];
        }

        public OverlaySnapshot Snapshot()
        {
            return new OverlaySnapshot
            {
                Connected = Connected && (DateTime.UtcNow - LastMessageUtc).TotalSeconds < 8,
                UpdateCount = UpdateCount,
                Clock = Clock,
                ReplayActive = ReplayActive,
                FocusedPlayerName = FocusedPlayerName,
                BlueName = Blue.Name,
                OrangeName = Orange.Name,
                BlueScore = Blue.Score,
                OrangeScore = Orange.Score,
                Players = players.Values.Select(p => p.Clone()).ToList()
            };
        }
    }

    internal sealed class OverlaySnapshot
    {
        public bool Connected;
        public int UpdateCount;
        public double Clock;
        public bool ReplayActive;
        public string FocusedPlayerName;
        public string BlueName;
        public string OrangeName;
        public int BlueScore;
        public int OrangeScore;
        public List<PlayerState> Players;
    }

    internal sealed class TeamState
    {
        public string Name;
        public int Score;
    }

    internal sealed class PlayerState
    {
        public string Name = "";
        public string Team = "";
        public int Shortcut = 99;
        public int Score;
        public int Goals;
        public int Shots;
        public int Assists;
        public int Saves;
        public int Demos;
        public int Boost;

        public PlayerState Clone()
        {
            return (PlayerState)MemberwiseClone();
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
