$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRectangle([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

$sourceSize = 1024
$source = New-Object System.Drawing.Bitmap($sourceSize, $sourceSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($source)
$graphics.Clear([System.Drawing.Color]::Transparent)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$tile = New-RoundedRectangle 48 48 928 928 224
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(120, 100)),
    (New-Object System.Drawing.PointF(900, 940)),
    [System.Drawing.Color]::FromArgb(255, 45, 102, 98),
    [System.Drawing.Color]::FromArgb(255, 18, 43, 45)
)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend
$blend.Colors = @(
    [System.Drawing.Color]::FromArgb(255, 45, 102, 98),
    [System.Drawing.Color]::FromArgb(255, 30, 75, 73),
    [System.Drawing.Color]::FromArgb(255, 18, 43, 45)
)
$blend.Positions = @(0.0, 0.52, 1.0)
$gradient.InterpolationColors = $blend
$graphics.FillPath($gradient, $tile)

$inner = New-RoundedRectangle 68 68 888 888 204
$innerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(62, 159, 225, 214), 8)
$graphics.DrawPath($innerPen, $inner)

$ivory = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 237, 242, 243))
$graphics.FillRectangle($ivory, 190, 292, 282, 104)
$graphics.FillRectangle($ivory, 276, 396, 110, 342)

$dPath = New-Object System.Drawing.Drawing2D.GraphicsPath([System.Drawing.Drawing2D.FillMode]::Alternate)
$dPath.StartFigure()
$dPath.AddLine(446, 292, 640, 292)
$dPath.AddBezier(640, 292, 772, 292, 862, 381, 862, 515)
$dPath.AddBezier(862, 515, 862, 649, 772, 738, 640, 738)
$dPath.AddLine(640, 738, 446, 738)
$dPath.CloseFigure()
$dPath.StartFigure()
$dPath.AddLine(558, 397, 631, 397)
$dPath.AddBezier(631, 397, 701, 397, 747, 442, 747, 515)
$dPath.AddBezier(747, 515, 747, 588, 701, 633, 631, 633)
$dPath.AddLine(631, 633, 558, 633)
$dPath.CloseFigure()
$mint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 116, 213, 197))
$graphics.FillPath($mint, $dPath)

$graphics.Dispose()
$gradient.Dispose()
$innerPen.Dispose()
$ivory.Dispose()
$mint.Dispose()
$tile.Dispose()
$inner.Dispose()
$dPath.Dispose()

$sourcePath = Join-Path $PSScriptRoot 'icon-1024.png'
$source.Save($sourcePath, [System.Drawing.Imaging.ImageFormat]::Png)

foreach ($size in @(16, 32, 48, 128)) {
    $target = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $targetGraphics = [System.Drawing.Graphics]::FromImage($target)
    $targetGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $targetGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $targetGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $targetGraphics.DrawImage($source, 0, 0, $size, $size)
    $targetGraphics.Dispose()
    $target.Save((Join-Path $PSScriptRoot "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $target.Dispose()
}

$source.Dispose()
Write-Output '아이콘 PNG 렌더링 완료: 16, 32, 48, 128, 1024'
