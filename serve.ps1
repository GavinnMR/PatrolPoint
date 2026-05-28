# Simple local HTTP server for PatrolPoint
# Run: powershell -ExecutionPolicy Bypass -File serve.ps1
# Then open: http://localhost:8080

$port = 8080
$root = $PSScriptRoot
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "PatrolPoint server running at $prefix"
Write-Host "Open http://localhost:$port in your browser"
Write-Host "Press Ctrl+C to stop"

$mimeTypes = @{
    '.html' = 'text/html'
    '.css'  = 'text/css'
    '.js'   = 'application/javascript'
    '.json' = 'application/json'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req  = $context.Request
        $resp = $context.Response

        $urlPath = $req.Url.LocalPath.TrimStart('/')
        if ($urlPath -eq '') { $urlPath = 'index.html' }

        $filePath = Join-Path $root $urlPath

        if (Test-Path $filePath -PathType Leaf) {
            $ext  = [System.IO.Path]::GetExtension($filePath).ToLower()
            $mime = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $resp.ContentType   = $mime
            $resp.ContentLength64 = $bytes.Length
            $resp.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
            $resp.Headers.Add('Pragma', 'no-cache')
            $resp.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $resp.StatusCode = 404
        }
        $resp.OutputStream.Close()
    }
} finally {
    $listener.Stop()
}
