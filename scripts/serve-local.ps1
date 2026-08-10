param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8766,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$rootPrefix = $appRoot + [System.IO.Path]::DirectorySeparatorChar
$loopback = [System.Net.IPAddress]::Parse("127.0.0.1")
$listener = [System.Net.Sockets.TcpListener]::new($loopback, $Port)

$mimeTypes = @{
  ".css" = "text/css; charset=utf-8"
  ".csv" = "text/csv; charset=utf-8"
  ".data" = "application/octet-stream"
  ".gz" = "application/gzip"
  ".html" = "text/html; charset=utf-8"
  ".js" = "text/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".metadata" = "application/json; charset=utf-8"
  ".mjs" = "text/javascript; charset=utf-8"
  ".so" = "application/octet-stream"
  ".tsv" = "text/tab-separated-values; charset=utf-8"
  ".txt" = "text/plain; charset=utf-8"
  ".wasm" = "application/wasm"
}

function Write-Headers {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [long]$ContentLength
  )

  $header = @(
    "HTTP/1.1 $StatusCode $StatusText"
    "Content-Type: $ContentType"
    "Content-Length: $ContentLength"
    "Cache-Control: no-cache"
    "Cross-Origin-Embedder-Policy: require-corp"
    "Cross-Origin-Opener-Policy: same-origin"
    "Cross-Origin-Resource-Policy: same-origin"
    "Connection: close"
    ""
    ""
  ) -join "`r`n"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($bytes, 0, $bytes.Length)
}

function Write-TextResponse {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$Message
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Message)
  Write-Headers $Stream $StatusCode $StatusText "text/plain; charset=utf-8" $bytes.Length
  $Stream.Write($bytes, 0, $bytes.Length)
}

try {
  $listener.Start()
} catch {
  Write-Host "DEAR-OWL could not listen on port $Port." -ForegroundColor Red
  Write-Host "Close another DEAR-OWL local window, or run: start-local.cmd -Port 8767"
  throw
}

$localUrl = "http://127.0.0.1:$Port/?mode=upload"
Write-Host ""
Write-Host "DEAR-OWL is running only on this PC." -ForegroundColor Green
Write-Host $localUrl -ForegroundColor Cyan
Write-Host "Keep this window open while using the app. Press Ctrl+C to stop."
Write-Host "Uploaded count matrices remain in the browser and are not sent to a remote server."
Write-Host ""
if (-not $NoBrowser) {
  Start-Process $localUrl
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $null
    $reader = $null
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new(
        $stream,
        [System.Text.Encoding]::ASCII,
        $false,
        8192,
        $true
      )
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        continue
      }

      $requestParts = $requestLine.Split(" ")
      if ($requestParts.Length -lt 2) {
        Write-TextResponse $stream 400 "Bad Request" "Bad request"
        continue
      }
      $method = $requestParts[0].ToUpperInvariant()
      $requestTarget = $requestParts[1]

      while ($true) {
        $headerLine = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($headerLine)) {
          break
        }
      }

      if ($method -ne "GET" -and $method -ne "HEAD") {
        Write-TextResponse $stream 405 "Method Not Allowed" "Method not allowed"
        continue
      }

      $requestUri = [System.Uri]::new("http://127.0.0.1$requestTarget")
      $relativePath = [System.Uri]::UnescapeDataString($requestUri.AbsolutePath).TrimStart("/")
      if ([string]::IsNullOrEmpty($relativePath)) {
        $relativePath = "index.html"
      }
      $relativePath = $relativePath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
      $filePath = [System.IO.Path]::GetFullPath((Join-Path $appRoot $relativePath))

      if ($filePath -ne $appRoot -and
          -not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-TextResponse $stream 403 "Forbidden" "Forbidden"
        continue
      }

      if (Test-Path -LiteralPath $filePath -PathType Container) {
        $filePath = Join-Path $filePath "index.html"
      }
      if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        Write-TextResponse $stream 404 "Not Found" "Not found"
        continue
      }

      $file = Get-Item -LiteralPath $filePath
      $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
      $contentType = $mimeTypes[$extension]
      if (-not $contentType) {
        $contentType = "application/octet-stream"
      }

      Write-Headers $stream 200 "OK" $contentType $file.Length
      if ($method -eq "GET") {
        $fileStream = [System.IO.File]::OpenRead($filePath)
        try {
          $fileStream.CopyTo($stream)
        } finally {
          $fileStream.Dispose()
        }
      }
    } catch {
      try {
        Write-TextResponse $stream 500 "Internal Server Error" "Local server error"
      } catch {
        # The browser may have closed the connection already.
      }
    } finally {
      if ($reader) {
        $reader.Dispose()
      }
      if ($stream) {
        $stream.Dispose()
      }
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
