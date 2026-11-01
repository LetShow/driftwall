# 按显示器设置桌面壁纸（Windows 8+，使用 IDesktopWallpaper COM 接口）
# 由 main.js 调用；只依赖系统自带的 powershell.exe，不需要额外运行库。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File windows-wallpaper.ps1 -Action list
#   powershell -ExecutionPolicy Bypass -File windows-wallpaper.ps1 -Action set -Index 1 -Path "D:\a.png"
#   powershell -ExecutionPolicy Bypass -File windows-wallpaper.ps1 -Action setall -Path "D:\a.png"
#   powershell -ExecutionPolicy Bypass -File windows-wallpaper.ps1 -Action get -Index 1
#
# list 输出每行：index<TAB>left<TAB>top<TAB>right<TAB>bottom<TAB>monitorDevicePath

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'set', 'setall', 'get')]
  [string]$Action,
  [int]$Index = -1,
  [string]$Path = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Driftwall {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [ComImport]
  [Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDesktopWallpaper {
    void SetWallpaper(
      [MarshalAs(UnmanagedType.LPWStr)] string monitorID,
      [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);

    [return: MarshalAs(UnmanagedType.LPWStr)]
    string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);

    [return: MarshalAs(UnmanagedType.LPWStr)]
    string GetMonitorDevicePathAt(uint monitorIndex);

    [return: MarshalAs(UnmanagedType.U4)]
    uint GetMonitorDevicePathCount();

    void GetMonitorRECT(
      [MarshalAs(UnmanagedType.LPWStr)] string monitorID,
      out RECT displayRect);
  }

  [ComImport]
  [Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD")]
  public class DesktopWallpaperClass {
  }

  public static class WallpaperApi {
    private static IDesktopWallpaper Create() {
      return (IDesktopWallpaper)new DesktopWallpaperClass();
    }

    public static string List() {
      IDesktopWallpaper api = Create();
      uint count = api.GetMonitorDevicePathCount();
      StringBuilder sb = new StringBuilder();
      for (uint i = 0; i < count; i++) {
        string id = api.GetMonitorDevicePathAt(i);
        if (String.IsNullOrEmpty(id)) continue;
        RECT r;
        api.GetMonitorRECT(id, out r);
        if (sb.Length > 0) sb.Append('\n');
        sb.Append(i).Append('\t')
          .Append(r.Left).Append('\t')
          .Append(r.Top).Append('\t')
          .Append(r.Right).Append('\t')
          .Append(r.Bottom).Append('\t')
          .Append(id);
      }
      return sb.ToString();
    }

    public static void Set(int index, string path) {
      IDesktopWallpaper api = Create();
      string id = api.GetMonitorDevicePathAt((uint)index);
      if (String.IsNullOrEmpty(id)) throw new Exception("找不到指定显示器: " + index);
      api.SetWallpaper(id, path);
    }

    public static void SetAll(string path) {
      IDesktopWallpaper api = Create();
      // monitorID 为 NULL 表示应用到所有显示器
      api.SetWallpaper(null, path);
    }

    public static string Get(int index) {
      IDesktopWallpaper api = Create();
      string id = api.GetMonitorDevicePathAt((uint)index);
      if (String.IsNullOrEmpty(id)) return "";
      return api.GetWallpaper(id) ?? "";
    }
  }
}
'@

$output = ''
switch ($Action) {
  'list' { $output = [Driftwall.WallpaperApi]::List() }
  'set' {
    if ($Index -lt 0) { throw '缺少 -Index' }
    [Driftwall.WallpaperApi]::Set($Index, $Path)
  }
  'setall' { [Driftwall.WallpaperApi]::SetAll($Path) }
  'get' {
    if ($Index -lt 0) { throw '缺少 -Index' }
    $output = [Driftwall.WallpaperApi]::Get($Index)
  }
}

if ($output) {
  Write-Output $output
}
