$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'extension\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-ZoomIcon {
  param([int]$Size, [string]$Path)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $radius = [float]($Size * 0.23)
    $diameter = $radius * 2
    $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $shape.AddArc(0, 0, $diameter, $diameter, 180, 90)
      $shape.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
      $shape.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
      $shape.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
      $shape.CloseFigure()

      $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 29, 155, 240))
      try { $g.FillPath($bg, $shape) } finally { $bg.Dispose() }

      $penWidth = [float][Math]::Max(1.4, $Size * 0.075)
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penWidth)
      try {
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

        $cx = [float]($Size * 0.43)
        $cy = [float]($Size * 0.43)
        $lensRadius = [float]($Size * 0.215)
        $g.DrawEllipse($pen, $cx - $lensRadius, $cy - $lensRadius, $lensRadius * 2, $lensRadius * 2)

        $hx1 = [float]($cx + $lensRadius * 0.72)
        $hy1 = [float]($cy + $lensRadius * 0.72)
        $hx2 = [float]($Size * 0.80)
        $hy2 = [float]($Size * 0.80)
        $g.DrawLine($pen, $hx1, $hy1, $hx2, $hy2)
      } finally { $pen.Dispose() }
    } finally { $shape.Dispose() }

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

foreach ($size in 16, 48, 128) {
  New-ZoomIcon -Size $size -Path (Join-Path $outDir "icon$size.png")
}
Write-Output "Icons written to $outDir"
