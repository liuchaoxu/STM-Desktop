# Regenerate build/icon.ico (multi-size, PNG-compressed) and build/icon.icns
# from the 512x512 build/icon.png, using only System.Drawing.
# Run from anywhere: paths are derived from this script's location.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot            # project root (parent of scripts/)
$src = Join-Path $root 'build\icon.png'
$icoOut = Join-Path $root 'build\icon.ico'
$icnsOut = Join-Path $root 'build\icon.icns'

$source = [System.Drawing.Image]::FromFile($src)
try {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)

  # ---- encode each size as PNG ----
  $pngs = @{}   # size -> byte[]
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($source, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs[$s] = $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
  }

  # ---- write ICO ----
  $msIco = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($msIco)
  $bw.Write([uint16]0)            # reserved
  $bw.Write([uint16]1)            # type = icon
  $bw.Write([uint16]$sizes.Count) # count
  $offset = 6 + 16 * $sizes.Count
  foreach ($s in $sizes) {
    $data = $pngs[$s]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)            # color count
    $bw.Write([byte]0)            # reserved
    $bw.Write([uint16]1)          # planes
    $bw.Write([uint16]32)         # bit count
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
  }
  foreach ($s in $sizes) { $bw.Write($pngs[$s]) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icoOut, $msIco.ToArray())
  $bw.Dispose()
  $msIco.Dispose()

  # ---- write ICNS (chunks: icp4 16, icp5 32, icp6 64, ic07 128, ic08 256, ic09 512) ----
  $chunks = @(
    @{ type = 'icp4'; size = 16 },
    @{ type = 'icp5'; size = 32 },
    @{ type = 'icp6'; size = 64 },
    @{ type = 'ic07'; size = 128 },
    @{ type = 'ic08'; size = 256 },
    @{ type = 'ic09'; size = 512 }
  )
  $msIcns = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($msIcns)
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes('icns'))
  $bw.Write([uint32]0) # placeholder total length
  $total = 8
  foreach ($ch in $chunks) {
    $data = if ($pngs.ContainsKey($ch.size)) { $pngs[$ch.size] } else { $null }
    if ($data -eq $null) {
      # 512 has no png entry above; reuse the source PNG for ic09
      if ($ch.size -eq 512) {
        $ms512 = New-Object System.IO.MemoryStream
        $source.Save($ms512, [System.Drawing.Imaging.ImageFormat]::Png)
        $data = $ms512.ToArray()
        $ms512.Dispose()
      }
    }
    $bw.Write([System.Text.Encoding]::ASCII.GetBytes($ch.type))
    $bw.Write([uint32](8 + $data.Length))
    $bw.Write($data)
    $total += 8 + $data.Length
  }
  $msIcns.Position = 4
  $bw.Write([uint32]$total)
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icnsOut, $msIcns.ToArray())
  $bw.Dispose()
  $msIcns.Dispose()

  Write-Host ('ICO bytes: ' + (Get-Item $icoOut).Length)
  Write-Host ('ICNS bytes: ' + (Get-Item $icnsOut).Length)
} finally {
  $source.Dispose()
}
