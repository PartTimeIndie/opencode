// Only configured taps and pair resets leave this helper; no raw key stream is exported.
export const doubleTapNativeSource = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public sealed class OpenCodeTapFilter {
  readonly int key, modifiers;
  readonly HashSet<int> down = new HashSet<int>();
  bool armed;
  public OpenCodeTapFilter(int key, int modifiers) { this.key = key; this.modifiers = modifiers; }
  public string Feed(int code, bool up, bool injected, int mask, string window, long time) {
    if (injected) return null;
    if (up) {
      down.Remove(code);
      if (code != key || !armed) return null;
      armed = false;
      if (mask != modifiers) return "{\"type\":\"reset\"}";
      return "{\"type\":\"tap\",\"time\":" + time + ",\"window\":\"" + window + "\"}";
    }
    if (!down.Add(code)) return null;
    if (code == key && mask == modifiers) { armed = true; return null; }
    if (code == 16 || code == 17 || code == 18 || (code >= 160 && code <= 165) || code == 91 || code == 92) return null;
    armed = false;
    return "{\"type\":\"reset\"}";
  }
  public void Reset() { armed = false; }
}

public static class OpenCodeDoubleTap {
  delegate IntPtr KeyboardProc(int code, IntPtr message, IntPtr data);
  delegate void ForegroundProc(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
  delegate void TimerProc(IntPtr window, uint message, UIntPtr timer, uint time);
  [StructLayout(LayoutKind.Sequential)] struct Keyboard { public uint Key, Scan, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint ID; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Private; }
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, KeyboardProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, ForegroundProc callback, uint process, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint interval, TimerProc callback);
  [DllImport("user32.dll")] static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  static bool Held(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

  public static void Run(int key, int modifiers, int parentID) {
    var filter = new OpenCodeTapFilter(key, modifiers);
    var queue = new Queue<string>();
    var clock = Stopwatch.StartNew();
    var parent = Process.GetProcessById(parentID);
    Action<string> enqueue = value => {
      if (value == null) return;
      if (queue.Count >= 128) { queue.Clear(); filter.Reset(); queue.Enqueue("{\"type\":\"reset\"}"); return; }
      queue.Enqueue(value);
    };
    KeyboardProc keyboard = (code, message, data) => {
      // A low-level hook must return promptly and always pass the original event on.
      try {
        if (code >= 0) {
          var value = (Keyboard)Marshal.PtrToStructure(data, typeof(Keyboard));
          var mask = (Held(17) ? 1 : 0) | (Held(18) ? 2 : 0) | (Held(16) ? 4 : 0) | ((Held(91) || Held(92)) ? 8 : 0);
          enqueue(filter.Feed((int)value.Key, (value.Flags & 128) != 0, (value.Flags & 18) != 0, mask, GetForegroundWindow().ToInt64().ToString(), clock.ElapsedMilliseconds));
        }
      } catch { filter.Reset(); }
      return CallNextHookEx(IntPtr.Zero, code, message, data);
    };
    ForegroundProc foreground = (hook, evt, window, obj, child, thread, time) => { filter.Reset(); enqueue("{\"type\":\"reset\"}"); };
    TimerProc tick = (window, message, id, time) => {
      try {
        if (parent.HasExited) { PostQuitMessage(0); return; }
        while (queue.Count > 0) Console.WriteLine(queue.Dequeue());
        Console.Out.Flush();
      } catch { PostQuitMessage(1); }
    };
    var keyboardHook = SetWindowsHookEx(13, keyboard, GetModuleHandle(null), 0);
    if (keyboardHook == IntPtr.Zero) throw new InvalidOperationException("Keyboard observer unavailable.");
    IntPtr foregroundHook = IntPtr.Zero;
    UIntPtr timer = UIntPtr.Zero;
    try {
      foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, foreground, 0, 0, 0);
      timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 20, tick);
      if (foregroundHook == IntPtr.Zero || timer == UIntPtr.Zero) throw new InvalidOperationException("Observer lifecycle unavailable.");
      Console.WriteLine("{\"type\":\"ready\"}"); Console.Out.Flush();
      Message message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) DispatchMessage(ref message);
    } finally {
      if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timer);
      if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
      UnhookWindowsHookEx(keyboardHook);
      parent.Dispose();
      GC.KeepAlive(keyboard); GC.KeepAlive(foreground); GC.KeepAlive(tick);
    }
  }
}
`
