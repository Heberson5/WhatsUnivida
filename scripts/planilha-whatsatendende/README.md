# Planilha do WhatsAtendende (fonte de dados)

Scripts que geram o `lista_clientes_WhatsAtendente.csv` lido em **Dados › Fontes de dados**
(painel do cliente, tags `{{dados.coluna}}` e boletos). O sistema lê as colunas **pelo nome do
cabeçalho**; colunas que ele não conhece aparecem sozinhas nas informações do cliente
(ex.: `email` → "E-mail").

| Arquivo | Para quê |
|---|---|
| `whatsatendente.sql` | Consulta no iVertex (SQL Server 2014). Somente leitura. |
| `GERAR_CSV.bat` + `gerar_csv.ps1` | Roda a consulta e grava o CSV direto (pede usuário e senha do SQL; ajuste `$servidor` no `.ps1`). |
| `CONVERTER_XLSX_PARA_CSV.bat` + `xlsx_para_csv.py` | Converte a planilha `.xlsx` (dados colados do SSMS) em CSV sem os estragos do Excel. Precisa de Python 3 com `openpyxl`. |

O CSV sai separado por `;`, em UTF-8, com o `.csv` e o `.xlsx` na pasta acima destes scripts.

## O que a consulta traz

- Só clientes com pelo menos um contrato **ativo**; contratos cancelados e as parcelas deles ficam de fora.
- Telefone e e-mail: só os marcados como **padrão** no cadastro. Sem telefone padrão, usa o primeiro
  telefone válido (linhas sem telefone são descartadas na importação).
- Parcelas: todas as vencidas e a próxima a vencer de cada contrato.
- `beneficiarios` só na primeira linha de cada contrato, para o arquivo ficar abaixo de 50 MB.
- Campos sem informação saem vazios (nunca `NULL`); valores com ponto decimal (`83.62`).

## Não abra o CSV no Excel

O Excel transforma a identificação da parcela (`10/26`) em data, corta zeros de CPF/CEP e
números longos (`2,29E+09`). Use o `CONVERTER_XLSX_PARA_CSV.bat` ou o `GERAR_CSV.bat`.
