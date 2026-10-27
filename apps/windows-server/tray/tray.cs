// The Flow Server's icon in the notification area (build.js compiles it with
// the C# compiler that comes with Windows, so C# 5 only). The server itself
// runs as a task before anyone signs in, without a window, so it can't show an
// icon of its own; this starts when the user signs in (the installer adds it to
// HKCU\...\Run) and asks the server's /api/hello every few seconds: Flow's
// icon while it answers, a grey one while it doesn't.
//
// A left click opens the Flow Server Command Line; a right click a menu with
// the Start menu's entries (Settings, Start, Stop, Restart, Log), "Start with
// Windows" and Close.
//
//   "Flow Server Tray.exe"           the icon (one per sign-in; a second does nothing)
//   "Flow Server Tray.exe" --quit    closes the icon of this sign-in and waits for it (the installer)
//   "Flow Server Tray.exe" --status  exit code 0 while the server answers, else 1
//
// It sits next to node.exe and flow-server.cmd; FLOW_SERVER_HOME (or
// %LOCALAPPDATA%\Flow\server) is the server's folder, where server.json has
// the port.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class FlowServerTray
{
    // One icon per sign-in. FLOW_SERVER_TRAY_ID gives a run names of its own
    // (the tests), so it never closes or blocks the real icon.
    static readonly string Id = Environment.GetEnvironmentVariable("FLOW_SERVER_TRAY_ID") ?? "";
    static readonly string MUTEX = "Local\\FlowServerTray" + Id;
    static readonly string QUIT = "Local\\FlowServerTrayQuit" + Id;
    const string RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const string RUN_NAME = "Flow Server Tray";
    const int DEFAULT_PORT = 7878;

    static readonly string Dir = Path.GetDirectoryName(Application.ExecutablePath);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main(string[] args)
    {
        string command = args.Length > 0 ? args[0] : "";
        if (command == "--status") return Hello(Port()) ? 0 : 1;
        if (command == "--quit") return Quit();

        bool first;
        using (Mutex one = new Mutex(true, MUTEX, out first))
        {
            if (!first) return 0;
            try { SetProcessDPIAware(); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (EventWaitHandle quit = new EventWaitHandle(false, EventResetMode.AutoReset, QUIT))
            using (Icon icon = new Icon())
            {
                ThreadPool.RegisterWaitForSingleObject(quit, delegate { icon.Close(); }, null, Timeout.Infinite, true);
                Application.Run();
            }
            one.ReleaseMutex();
        }
        return 0;
    }

    /** Asks the icon of this sign-in to close, and waits until it has (its exe is free then). */
    static int Quit()
    {
        EventWaitHandle quit;
        if (!EventWaitHandle.TryOpenExisting(QUIT, out quit)) return 0;
        using (quit) quit.Set();
        for (int i = 0; i < 50; i++)
        {
            Mutex one;
            if (!Mutex.TryOpenExisting(MUTEX, out one)) return 0;
            one.Dispose();
            Thread.Sleep(100);
        }
        return 1;
    }

    static string Home()
    {
        string home = Environment.GetEnvironmentVariable("FLOW_SERVER_HOME");
        if (!String.IsNullOrEmpty(home)) return home;
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Flow", "server");
    }

    /** The port in server.json, else 7878. */
    static int Port()
    {
        try
        {
            Match m = Regex.Match(File.ReadAllText(Path.Combine(Home(), "server.json")), "\"port\"\\s*:\\s*(\\d+)");
            int port;
            if (m.Success && Int32.TryParse(m.Groups[1].Value, out port) && port > 0 && port < 65536) return port;
        }
        catch (Exception) { }
        return DEFAULT_PORT;
    }

    /** Whether the Flow Server answers at this port on this PC. */
    static bool Hello(int port)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/hello");
            req.Timeout = 2000;
            req.ReadWriteTimeout = 2000;
            req.Proxy = null;
            req.KeepAlive = false;
            using (WebResponse res = req.GetResponse())
            using (StreamReader body = new StreamReader(res.GetResponseStream()))
                return Regex.IsMatch(body.ReadToEnd(), "\"app\"\\s*:\\s*\"flow-server\"");
        }
        catch (Exception)
        {
            return false;
        }
    }

    /** A program of the server's folder, started the way the Start menu's shortcuts start it. */
    static void Open(string file, string arguments, bool window)
    {
        try
        {
            ProcessStartInfo p = new ProcessStartInfo(file, arguments);
            p.WorkingDirectory = Dir;
            p.UseShellExecute = false;
            p.CreateNoWindow = !window;
            // flow-server works in the window wherever it is cd'd to.
            p.EnvironmentVariables["PATH"] = Dir + ";" + Environment.GetEnvironmentVariable("PATH");
            Process.Start(p).Dispose();
        }
        catch (Exception err)
        {
            MessageBox.Show("Could not open " + Path.GetFileName(file) + ": " + err.Message, "Flow Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    static string Setup(string command)
    {
        return "\"" + Path.Combine(Dir, "app", "windows", "setup.js") + "\"" + (command.Length > 0 ? " " + command : "") + " --pause";
    }

    static string Node()
    {
        return Path.Combine(Dir, "node.exe");
    }

    static void CommandLine()
    {
        string cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        Open(cmd, "/k \"\"" + Path.Combine(Dir, "flow-server.cmd") + "\" --help\"", true);
    }

    static void Log()
    {
        string log = Path.Combine(Home(), "flow-server.log");
        if (!File.Exists(log))
        {
            MessageBox.Show("No log yet (" + log + "): the server has not run.", "Flow Server", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Open(Path.Combine(Environment.SystemDirectory, "notepad.exe"), "\"" + log + "\"", true);
    }

    static bool StartsWithWindows()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY))
            return key != null && key.GetValue(RUN_NAME) != null;
    }

    static void StartWithWindows(bool on)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RUN_KEY))
        {
            if (on) key.SetValue(RUN_NAME, "\"" + Application.ExecutablePath + "\"");
            else key.DeleteValue(RUN_NAME, false);
        }
    }

    /** Flow's icon at the notification area's size; grey and paler for a server that is not running. */
    static System.Drawing.Icon LoadIcon(bool grey)
    {
        Size size = SystemInformation.SmallIconSize;
        System.Drawing.Icon source;
        try { source = new System.Drawing.Icon(Path.Combine(Dir, "icon.ico"), size); }
        catch (Exception) { source = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        if (!grey) return source;
        using (source)
        using (Bitmap colour = source.ToBitmap())
        using (Bitmap pale = new Bitmap(colour.Width, colour.Height))
        {
            ColorMatrix m = new ColorMatrix(new float[][] {
                new float[] { 0.3f, 0.3f, 0.3f, 0, 0 },
                new float[] { 0.59f, 0.59f, 0.59f, 0, 0 },
                new float[] { 0.11f, 0.11f, 0.11f, 0, 0 },
                new float[] { 0, 0, 0, 0.55f, 0 },
                new float[] { 0, 0, 0, 0, 1 },
            });
            using (ImageAttributes a = new ImageAttributes())
            using (Graphics g = Graphics.FromImage(pale))
            {
                a.SetColorMatrix(m);
                g.DrawImage(colour, new Rectangle(0, 0, colour.Width, colour.Height), 0, 0, colour.Width, colour.Height, GraphicsUnit.Pixel, a);
            }
            IntPtr handle = pale.GetHicon();
            using (System.Drawing.Icon made = System.Drawing.Icon.FromHandle(handle))
            {
                System.Drawing.Icon copy = (System.Drawing.Icon)made.Clone();
                DestroyIcon(handle);
                return copy;
            }
        }
    }

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr handle);

    /** The icon, its menu, and the check every few seconds. */
    sealed class Icon : IDisposable
    {
        readonly NotifyIcon tray = new NotifyIcon();
        readonly System.Drawing.Icon on = LoadIcon(false);
        readonly System.Drawing.Icon off = LoadIcon(true);
        readonly ToolStripMenuItem state = new ToolStripMenuItem();
        readonly ToolStripMenuItem start, stop, restart, withWindows;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly Control ui = new Control();
        int checking;
        bool? running;
        int port = DEFAULT_PORT;
        DateTime lastOpen = DateTime.MinValue;

        public Icon()
        {
            ui.CreateControl();
            ContextMenuStrip menu = new ContextMenuStrip();
            state.Enabled = false;
            menu.Items.Add(state);
            menu.Items.Add(new ToolStripSeparator());
            ToolStripMenuItem commandLine = Item(menu, "Flow Server Command Line", CommandLine);
            commandLine.Font = new Font(commandLine.Font, FontStyle.Bold);
            Item(menu, "Flow Server Settings", delegate { Open(Node(), Setup(""), true); });
            menu.Items.Add(new ToolStripSeparator());
            start = Item(menu, "Start Flow Server", delegate { Open(Node(), Setup("start"), true); });
            stop = Item(menu, "Stop Flow Server", delegate { Open(Node(), Setup("stop"), true); });
            restart = Item(menu, "Restart Flow Server", delegate { Open(Node(), Setup("restart"), true); });
            menu.Items.Add(new ToolStripSeparator());
            Item(menu, "Flow Server Log", Log);
            menu.Items.Add(new ToolStripSeparator());
            withWindows = Item(menu, "Show this icon when Windows starts", delegate {
                try { StartWithWindows(!withWindows.Checked); }
                catch (Exception err) { MessageBox.Show(err.Message, "Flow Server", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            });
            Item(menu, "Close this icon", Close);
            menu.Opening += delegate {
                try { withWindows.Checked = StartsWithWindows(); } catch (Exception) { }
                Check();
            };

            tray.ContextMenuStrip = menu;
            tray.MouseClick += delegate(object sender, MouseEventArgs e) {
                if (e.Button != MouseButtons.Left) return;
                // A double click is one window, not two.
                if ((DateTime.Now - lastOpen).TotalMilliseconds < SystemInformation.DoubleClickTime) return;
                lastOpen = DateTime.Now;
                CommandLine();
            };
            Show(false);
            tray.Visible = true;

            timer.Interval = 4000;
            timer.Tick += delegate { Check(); };
            timer.Start();
            Check();
        }

        static ToolStripMenuItem Item(ContextMenuStrip menu, string text, Action click)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.Click += delegate { click(); };
            menu.Items.Add(item);
            return item;
        }

        /** Asks the server, off the window's thread; one question at a time. */
        void Check()
        {
            if (Interlocked.Exchange(ref checking, 1) == 1) return;
            ThreadPool.QueueUserWorkItem(delegate {
                int p = Port();
                bool up = Hello(p);
                try
                {
                    ui.BeginInvoke((Action)delegate {
                        port = p;
                        Show(up);
                        checking = 0;
                    });
                }
                catch (Exception)
                {
                    checking = 0;
                }
            });
        }

        void Show(bool up)
        {
            string text = up ? "Flow Server: running (port " + port + ")" : "Flow Server: not running";
            if (running == up && tray.Text == text) return;
            running = up;
            tray.Icon = up ? on : off;
            tray.Text = text;
            state.Text = text;
            start.Enabled = !up;
            stop.Enabled = up;
            restart.Enabled = up;
        }

        /** Closes the icon (from any thread). */
        public void Close()
        {
            try
            {
                ui.BeginInvoke((Action)delegate {
                    tray.Visible = false;
                    Application.ExitThread();
                });
            }
            catch (Exception)
            {
                Application.Exit();
            }
        }

        public void Dispose()
        {
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            on.Dispose();
            off.Dispose();
            ui.Dispose();
        }
    }
}
