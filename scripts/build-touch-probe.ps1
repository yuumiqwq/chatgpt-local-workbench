param(
    [string]$SdkRoot = 'D:\StudyServer\runtime\android-sdk',
    [string]$JavaRoot = 'D:\StudyServer\runtime\jdk17\jdk-17.0.20.1+1',
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'codex-generated\touch-probe-build' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$env:JAVA_HOME = $JavaRoot
$androidJar = Join-Path $SdkRoot 'platforms\android-35\android.jar'
$buildTools = Join-Path $SdkRoot 'build-tools\35.0.0'
foreach ($folder in @($OutputDirectory, "$OutputDirectory\classes", "$OutputDirectory\dex")) {
    [IO.Directory]::CreateDirectory($folder) | Out-Null
}
function Run-Native([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Program (exit $LASTEXITCODE)" }
}
Run-Native "$JavaRoot\bin\javac.exe" @('-encoding','UTF-8','-source','8','-target','8','-classpath',$androidJar,'-d',"$OutputDirectory\classes",(Join-Path $repoRoot 'android\touch-probe\src\org\workbench\touchprobe\MainActivity.java'))
Run-Native "$JavaRoot\bin\jar.exe" @('cf',"$OutputDirectory\classes.jar",'-C',"$OutputDirectory\classes",'.')
Run-Native "$JavaRoot\bin\java.exe" @('-cp',"$buildTools\lib\d8.jar",'com.android.tools.r8.D8','--lib',$androidJar,'--min-api','26','--output',"$OutputDirectory\dex", "$OutputDirectory\classes.jar")
Run-Native "$buildTools\aapt2.exe" @('link','-I',$androidJar,'--manifest',(Join-Path $repoRoot 'android\touch-probe\AndroidManifest.xml'),'-o',"$OutputDirectory\unsigned.apk")
Run-Native "$JavaRoot\bin\jar.exe" @('uf',"$OutputDirectory\unsigned.apk",'-C',"$OutputDirectory\dex",'classes.dex')
Run-Native "$buildTools\zipalign.exe" @('-f','4',"$OutputDirectory\unsigned.apk", "$OutputDirectory\aligned.apk")
$keyPath = Join-Path $OutputDirectory 'debug.keystore'
if (!(Test-Path -LiteralPath $keyPath)) {
    Run-Native "$JavaRoot\bin\keytool.exe" @('-genkeypair','-keystore',$keyPath,'-storepass','android','-keypass','android','-alias','androiddebugkey','-dname','CN=Android Debug,O=Android,C=US','-keyalg','RSA','-keysize','2048','-validity','10000')
}
Run-Native "$buildTools\apksigner.bat" @('sign','--ks',$keyPath,'--ks-pass','pass:android','--key-pass','pass:android','--out',"$OutputDirectory\touch-probe.apk", "$OutputDirectory\aligned.apk")
Run-Native "$buildTools\apksigner.bat" @('verify',"$OutputDirectory\touch-probe.apk")
Write-Output "$OutputDirectory\touch-probe.apk"
