# shots-to-previews.ps1 - turn tools/.shots/<id>.png (1920x1080 stage screenshots) into
# each theme's preview.jpg (640x360). ASCII only: PowerShell 5.1 reads BOM-less .ps1 as ANSI.

param(
  [string]$Shots = '',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $Shots) { $Shots = Join-Path $PSScriptRoot '.shots' }
if (-not $Root) { $Root = Join-Path $PSScriptRoot '..\packages\dsh-livestreamingcompanion\assets\templates' }
$Shots = (Resolve-Path $Shots).Path
$Root = (Resolve-Path $Root).Path
Write-Host "shots: $Shots"

$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]86)

Get-ChildItem $Shots -Filter *.png | ForEach-Object {
  $id = $_.BaseName
  $dir = Join-Path $Root $id
  if (-not (Test-Path $dir)) { Write-Host "skip $id (no theme dir)"; return }

  $img = [System.Drawing.Image]::FromFile($_.FullName)
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
    Write-Host ("preview: {0} {1}x{2} {3} bytes" -f $id, $w, $h, (Get-Item $out).Length)
  } finally {
    $img.Dispose()
  }
}
