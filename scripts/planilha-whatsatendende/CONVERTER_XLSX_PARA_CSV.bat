@echo off
rem Converte a planilha .xlsx em CSV separado por ";" sem estragar os dados.
rem Dois cliques: usa ..\lista_clientes_WhatsAtendente.xlsx
rem Ou arraste outro .xlsx em cima deste arquivo.
chcp 65001 >nul
if "%~1"=="" (
  python "%~dp0xlsx_para_csv.py"
) else (
  python "%~dp0xlsx_para_csv.py" "%~1"
)
pause
