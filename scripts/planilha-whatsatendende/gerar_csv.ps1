# Gera lista_clientes_WhatsAtendente.csv (separado por ";", UTF-8) direto do banco.
# Somente leitura no banco. Rodar pelo GERAR_CSV.bat.

# ======== AJUSTE AQUI (uma vez só) ========
$servidor = 'NOME_DO_SERVIDOR'          # o mesmo nome usado para conectar no SSMS
$banco    = 'iVertex_UNIVIDA_QLD'
# ==========================================

$ErrorActionPreference = 'Stop'
$pasta   = Split-Path -Parent $MyInvocation.MyCommand.Path
$sqlFile = Join-Path $pasta 'whatsatendente.sql'
$destino = Join-Path (Split-Path -Parent $pasta) 'lista_clientes_WhatsAtendente.csv'
$tmp     = "$destino.tmp"

# Login do SQL Server (o mesmo do SSMS). A senha é digitada aqui e não fica gravada.
$usuario = Read-Host 'Usuario do SQL Server'
$senha   = Read-Host 'Senha' -AsSecureString
$senha.MakeReadOnly()
$credencial = New-Object System.Data.SqlClient.SqlCredential($usuario, $senha)

Write-Host "Consultando o banco $banco em $servidor (pode levar alguns minutos)..."
$conn = New-Object System.Data.SqlClient.SqlConnection("Server=$servidor;Database=$banco", $credencial)
$cmd  = $conn.CreateCommand()
$cmd.CommandText    = [IO.File]::ReadAllText($sqlFile, [Text.Encoding]::UTF8)
$cmd.CommandTimeout = 0
$conn.Open()
$leitor = $cmd.ExecuteReader()

$escritor = New-Object IO.StreamWriter($tmp, $false, (New-Object Text.UTF8Encoding($true)))
$escritor.NewLine = "`r`n"
try {
    $n = $leitor.FieldCount
    $escritor.WriteLine((0..($n - 1) | ForEach-Object { $leitor.GetName($_) }) -join ';')
    $campos = New-Object string[] $n
    $linhas = 0
    while ($leitor.Read()) {
        for ($i = 0; $i -lt $n; $i++) {
            $v = if ($leitor.IsDBNull($i)) { '' } else { [string]$leitor.GetValue($i) }
            # aspas só quando o campo tem ; ou aspas (ex.: beneficiarios)
            if ($v.IndexOf(';') -ge 0 -or $v.IndexOf('"') -ge 0) { $v = '"' + $v.Replace('"', '""') + '"' }
            $campos[$i] = $v
        }
        $escritor.WriteLine([string]::Join(';', $campos))
        $linhas++
    }
}
finally {
    $escritor.Close(); $leitor.Close(); $conn.Close()
}

Move-Item -Force $tmp $destino
$mb = [math]::Round((Get-Item $destino).Length / 1MB, 1)
Write-Host "Pronto: $linhas linhas, $mb MB -> $destino"
