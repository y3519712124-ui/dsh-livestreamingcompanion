# theme-previews.ps1 - turn each generated theme bg.png into a 640px preview.jpg
# (the console gallery always asks for preview.jpg; System.Drawing is available on Windows PowerShell 5.1).
# ASCII only: PowerShell 5.1 reads BOM-less .ps1 as ANSI.

param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $Root) { $Root = Join-Path $PSScriptRoot '..\packages\dsh-livestreamingcompanion\assets\templates' }
$Root = (Resolve-Path $Root).Path
Write-Host "templates: $Root"

$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]88)

Get-ChildItem $Root -Directory | ForEach-Object {
  $dir = $_.FullName
  $bg = Join-Path $dir 'bg.png'
  if (-not (Test-Path $bg)) { return }

  $img = [System.Drawing.Image]::FromFile($bg)
  try {
    $w = 640
    $h = [int][math]::Round($img.Height * ($w / $img.Width))
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $w, $h)
    } finally { $g.Dispose() }
    $out = Join-Path $dir 'preview.jpg'
    $bmp.Save($out, $enc, $params)
    $bmp.Dispose()
    Write-Host ("preview: {0} -> {1}x{2} {3} bytes" -f $_.Name, $w, $h, (Get-Item $out).Length)
  } finally {
    $img.Dispose()
  }

  $placeholder = Join-Path $dir 'preview.png'
  if (Test-Path $placeholder) { Remove-Item $placeholder -Force }
}
