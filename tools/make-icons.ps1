# Draws the app icons (same design as tools/icon.svg) at the sizes Windows and iPhone need.
# Usage:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$icons = Join-Path $PSScriptRoot '..\icons'
$purple = [System.Drawing.ColorTranslator]::FromHtml('#4f4fc9')
$yellow = [System.Drawing.ColorTranslator]::FromHtml('#ffc44d')
$white = [System.Drawing.Color]::White

function Draw-Icon([int]$size, [string]$file, [bool]$rounded, [double]$artScale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 128.0
  $bg = New-Object System.Drawing.SolidBrush $purple
  if ($rounded) {
    $r = 26 * $k * 2; $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(0, 0, $r, $r, 180, 90); $p.AddArc($size - $r, 0, $r, $r, 270, 90)
    $p.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $p.AddArc(0, $size - $r, $r, $r, 90, 90); $p.CloseFigure()
    $g.FillPath($bg, $p)
  } else { $g.FillRectangle($bg, 0, 0, $size, $size) }
  # the artwork, optionally shrunk into the middle (maskable icons keep it inside the safe zone)
  $off = (1 - $artScale) * 64
  $g.TranslateTransform([float]($off * $k), [float]($off * $k)); $g.ScaleTransform([float]($k * $artScale), [float]($k * $artScale))
  $wb = New-Object System.Drawing.SolidBrush $white; $yb = New-Object System.Drawing.SolidBrush $yellow
  $g.FillRectangle($wb, 28, 45, 72, 35)
  $g.FillRectangle($wb, 26, 26, 19, 20); $g.FillRectangle($yb, 45, 26, 19, 20)
  $g.FillRectangle($wb, 64, 26, 20, 20); $g.FillRectangle($yb, 84, 26, 20, 20)
  $g.FillEllipse($bg, 62, 62, 32, 32)
  $ring = New-Object System.Drawing.Pen $yellow, 8; $g.DrawEllipse($ring, 62, 62, 32, 32)
  $handle = New-Object System.Drawing.Pen $yellow, 11; $handle.StartCap = 'Round'; $handle.EndCap = 'Round'
  $g.DrawLine($handle, 91, 91, 110, 111)
  $g.Dispose()
  $bmp.Save((Join-Path $icons $file), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Host "icons/$file"
}

Draw-Icon 192 'icon192.png' $true 1.0
Draw-Icon 512 'icon512.png' $true 1.0
Draw-Icon 180 'icon180.png' $false 1.0          # iPhone rounds the corners itself
Draw-Icon 512 'icon512-maskable.png' $false 0.8 # Android / Windows may crop to a circle
