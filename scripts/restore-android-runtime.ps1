$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$runtimeCache = Join-Path $taskRoot '.runtime-cache'
New-Item -ItemType Directory -Force -Path $runtimeCache | Out-Null
$zip = Join-Path $runtimeCache 'nodejs-mobile-android-24.22.1-0.zip'
$expected = 'd6fd9f610fe5d81fede8f0d400c5a62723247725a19831835f15abf4f0604250'
if (!(Test-Path -LiteralPath $zip)) {
 Invoke-WebRequest -Uri 'https://github.com/fogtape/nodejs-mobile/releases/download/v24.22.1-0/nodejs-mobile-android-24.22.1-0.zip' -OutFile $zip
}
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Runtime archive checksum mismatch. No libraries were installed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
 foreach ($entry in $archive.Entries) {
  $destination = $null
  if ($entry.FullName -match '^bin/(arm64-v8a|x86_64)/libnode.so$') { $destination = Join-Path $taskRoot ('android/app/src/main/jniLibs/' + $Matches[1] + '/libnode.so') }
  elseif ($entry.FullName.StartsWith('include/node/') -and !$entry.FullName.EndsWith('/')) { $destination = Join-Path $taskRoot ('android/app/src/main/cpp/include/node/' + $entry.FullName.Substring(13)) }
  if ($destination) {
   $absolute = [IO.Path]::GetFullPath($destination)
   $allowed = [IO.Path]::GetFullPath((Join-Path $taskRoot 'android/app/src/main/'))
   if (!$absolute.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path' }
   New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($absolute)) | Out-Null
   [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$absolute,$true)
  }
 }
} finally { $archive.Dispose() }
Write-Output 'Pinned Android Node libraries and headers restored. Configure android/local.properties before building.'
