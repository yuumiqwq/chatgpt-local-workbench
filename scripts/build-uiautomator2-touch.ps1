param(
    [string]$SdkRoot = 'D:\StudyServer\runtime\android-sdk',
    [string]$JavaRoot = 'D:\StudyServer\runtime\jdk17\jdk-17.0.20.1+1',
    [string]$GradleHome = 'D:\StudyServer\runtime\gradle-home',
    [string]$SourceDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (!$SourceDirectory) { $SourceDirectory = Join-Path $repoRoot 'codex-generated\uiautomator2-touch-source' }
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$expectedCommit = '4a8139161cbb3aad078e36539995eb734297d56e'
$patchPath = Join-Path $repoRoot 'android\uiautomator2-touch\10.6.6.patch'
if (!(Test-Path -LiteralPath $SourceDirectory)) {
    & git clone --depth 1 --branch v10.6.6 https://github.com/appium/appium-uiautomator2-server.git $SourceDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Source checkout failed' }
}
$actualCommit = (& git -C $SourceDirectory rev-parse HEAD).Trim()
if ($actualCommit -ne $expectedCommit) { throw "Expected source revision $expectedCommit" }
& git -C $SourceDirectory apply --reverse --check $patchPath 2>$null
if ($LASTEXITCODE -ne 0) {
    & git -C $SourceDirectory apply --check $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Patch does not match this source tree' }
    & git -C $SourceDirectory apply $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Patch application failed' }
}
$env:JAVA_HOME = $JavaRoot
$env:ANDROID_HOME = $SdkRoot
$env:GRADLE_USER_HOME = $GradleHome
$gradleArguments = @(':app:assembleServerDebug', ':app:assembleServerDebugAndroidTest', '--no-daemon', '--max-workers=2', '--console=plain', '-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8')
if ($env:HTTPS_PROXY) {
    $buildProxy = [uri]$env:HTTPS_PROXY
    $gradleArguments += @("-Dhttps.proxyHost=$($buildProxy.Host)", "-Dhttps.proxyPort=$($buildProxy.Port)", "-Dhttp.proxyHost=$($buildProxy.Host)", "-Dhttp.proxyPort=$($buildProxy.Port)")
}
Push-Location -LiteralPath $SourceDirectory
try {
    & .\gradlew.bat @gradleArguments
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    Get-ChildItem -LiteralPath '.\app\build\outputs\apk' -Recurse -Filter '*.apk' | Select-Object -ExpandProperty FullName
} finally { Pop-Location }
