# Capture the full virtual screen including layered/topmost overlay windows.
# The built-in Graphics.CopyFromScreen 6-arg overload rejects SRCCOPY|CAPTUREBLT,
# so BitBlt with 0x40CC0020 is called directly.
param([string]$Out = 'E:\ai-veil\evidence\_shot.png')

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Veil -Name Gdi -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
[DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int w, int h, IntPtr hdcSrc, int xSrc, int ySrc, int rop);
'@

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$dst = $graphics.GetHdc()
$src = [Veil.Gdi]::GetDC([IntPtr]::Zero)
$ok = [Veil.Gdi]::BitBlt($dst, 0, 0, $bounds.Width, $bounds.Height, $src, $bounds.Left, $bounds.Top, 0x40CC0020)
[void][Veil.Gdi]::ReleaseDC([IntPtr]::Zero, $src)
$graphics.ReleaseHdc($dst)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Host ("saved " + $Out + " bitblt=" + $ok)
