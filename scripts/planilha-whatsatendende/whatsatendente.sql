/* =====================================================================
   WhatsAtendende — PLANILHA ÚNICA (cliente, contrato e boletos)
   Banco: iVertex_UNIVIDA_QLD (SQL Server 2014)
   ---------------------------------------------------------------------
   Este script é rodado pelo GERAR_CSV.bat (mesma pasta), que grava o
   arquivo lista_clientes_WhatsAtendente.csv já pronto (separado por
   ";", UTF-8). Não precisa abrir no SSMS nem no Excel.
   (Pode ser executado no SSMS só para conferir: sai em colunas.)

   SOMENTE LEITURA: não altera, não apaga e não grava nada no banco do
   sistema. Usa só tabelas temporárias (#...), que somem sozinhas.

   O QUE TEM EM CADA LINHA
   Uma linha por telefone + contrato + parcela. Só entram clientes
   que têm pelo menos um contrato ATIVO. Contratos cancelados (e as
   parcelas deles) ficam de fora. Parcelas que entram:
     - TODAS as vencidas e não pagas;
     - e só a PRÓXIMA parcela a vencer de cada contrato (uma só).
   Contrato sem nenhuma dessas aparece numa linha com as colunas da
   parcela vazias. Vendas/acordos avulsos (que não são de contrato)
   aparecem em linhas com as colunas do contrato vazias.

   beneficiarios: "Nome;Parentesco;Nascimento;Agregado" separados por
   " | ", titular primeiro. Preenchida SÓ NA PRIMEIRA linha de cada
   contrato (a parcela mais antiga), para o arquivo ficar menor.
   multa / juros / valor_atualizado: calculados para o dia em que o
   script roda, pelas funções do sistema. Só informativo.
   parcelas_suspensao: parâmetro do sistema (parcelas vencidas para
   suspender o contrato).

   telefone_whatsapp / email: só os contatos marcados como PADRÃO no
   cadastro. Cliente sem telefone padrão usa o primeiro telefone válido
   do cadastro (o WhatsAtendente descarta linhas sem telefone).
   email é a última coluna.

   - "Sem data" no sistema (01/01/1900) sai vazio.
   - Campos sem informação saem EM BRANCO (nunca "NULL").
   - Valores com centavos usam ponto (ex.: 123.45).
   ===================================================================== */

SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

DECLARE @telefone      VARCHAR(20) = NULL;  -- teste com um número (ex.: '65999991234'); NULL = todos

DECLARE @hoje DATE = CAST(GETDATE() AS DATE);
DECLARE @parcelas_suspensao INT =
  (SELECT TOP 1 [nm_quantidade_débitos_suspensão_contratos] FROM dbo.[tbl_contas_a_receber_parâmetros]);
DECLARE @ddd_padrao VARCHAR(3) =
  ISNULL((SELECT TOP 1 NULLIF(LTRIM(RTRIM([ch_ddd_padrão])), '') FROM dbo.[tbl_contatos_parâmetros]), '65');

IF OBJECT_ID('tempdb..#tel_todos') IS NOT NULL DROP TABLE #tel_todos;
IF OBJECT_ID('tempdb..#telefones') IS NOT NULL DROP TABLE #telefones;
IF OBJECT_ID('tempdb..#clientes')  IS NOT NULL DROP TABLE #clientes;
IF OBJECT_ID('tempdb..#contratos') IS NOT NULL DROP TABLE #contratos;
IF OBJECT_ID('tempdb..#parcelas')  IS NOT NULL DROP TABLE #parcelas;

/* 1. Telefones no formato do WhatsApp: 55 + DDD + número (celular antigo ganha o 9) */
SELECT ec.[nm_id] AS id_contato, ec.[nm_id_entidade] AS id_cliente, n5.telefone, CAST(ISNULL(ec.[bt_padrão], 0) AS INT) AS padrao
INTO #tel_todos
FROM dbo.[tbl_entidades_contatos] ec
CROSS APPLY (SELECT
  ref = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(ec.[ch_referência], ''),
          ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '/', ''), '+', ''), CHAR(9), ''),
  pre = REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(ec.[ch_prefixo], ''), ' ', ''), '(', ''), ')', ''), '0', '')
) n1
CROSS APPLY (SELECT ref = SUBSTRING(n1.ref, PATINDEX('%[^0]%', n1.ref + '.'), 30)) n2
CROSS APPLY (SELECT base = CASE
  WHEN LEN(n2.ref) >= 10 THEN n2.ref
  WHEN LEN(n2.ref) IN (8, 9) THEN ISNULL(NULLIF(n1.pre, ''), @ddd_padrao) + n2.ref
END) n3
CROSS APPLY (SELECT num = CASE WHEN LEFT(n3.base, 2) = '55' AND LEN(n3.base) >= 12 THEN n3.base ELSE '55' + n3.base END) n4
CROSS APPLY (SELECT telefone = CASE
  WHEN LEN(n4.num) = 12 AND SUBSTRING(n4.num, 5, 1) IN ('6', '7', '8', '9') THEN STUFF(n4.num, 5, 0, '9')
  ELSE n4.num END) n5
WHERE ec.[nm_id_tipo] IN (1, 6, 8, 9)            -- TELEFONE, CELULAR, SMS, WHATSAPP
  AND ec.[ch_referência] NOT LIKE '%@%'
  AND ISNULL(ec.[bt_bloqueado], 0) = 0
  AND n1.ref <> '' AND n1.ref NOT LIKE '%[^0-9]%'
  AND n3.base IS NOT NULL
  AND LEN(n5.telefone) IN (12, 13);

-- Só o telefone/celular marcado como PADRÃO. Cliente que não tem nenhum
-- marcado como padrão usa o primeiro telefone válido do cadastro.
SELECT DISTINCT id_cliente, telefone
INTO #telefones
FROM #tel_todos
WHERE padrao = 1
UNION
SELECT t.id_cliente, t.telefone
FROM #tel_todos t
WHERE NOT EXISTS (SELECT 1 FROM #tel_todos p WHERE p.id_cliente = t.id_cliente AND p.padrao = 1)
  AND t.id_contato = (SELECT MIN(x.id_contato) FROM #tel_todos x WHERE x.id_cliente = t.id_cliente);

DROP TABLE #tel_todos;

IF @telefone IS NOT NULL
  DELETE FROM #telefones
  WHERE RIGHT(telefone, 8) <> RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(@telefone, ' ', ''), '-', ''), '(', ''), ')', ''), 8);

/* 2. Clientes (cadastro, endereço e se é falecido) */
SELECT
  e.[nm_id]                 AS id_cliente,
  e.[ch_nome_completo]      AS nome_cliente,
  e.[ch_inscrição_ativa]    AS cpf_cnpj,
  CASE WHEN EXISTS (SELECT 1 FROM dbo.[tbl_entidades_falecidos] f
                    WHERE f.[nm_id_entidade] = e.[nm_id] AND ISNULL(f.[bt_registro_ativo], 1) = 1)
       THEN 'Sim' ELSE 'Não' END AS cliente_falecido,
  ende.endereco, ende.bairro, ende.cidade, ende.cep,
  em_c.email
INTO #clientes
FROM dbo.[tbl_entidades] e
-- e-mail: só o marcado como PADRÃO
OUTER APPLY (
  SELECT TOP 1 email = LTRIM(RTRIM(ce.[ch_referência]))
  FROM dbo.[tbl_entidades_contatos] ce
  WHERE ce.[nm_id_entidade] = e.[nm_id]
    AND ce.[ch_referência] LIKE '%_@_%'
    AND ISNULL(ce.[bt_bloqueado], 0) = 0
    AND ISNULL(ce.[bt_padrão], 0) = 1
  ORDER BY ce.[nm_id] DESC
) em_c
OUTER APPLY (
  SELECT TOP 1
    endereco = LTRIM(ISNULL(en.[ch_logradouro], '') + ISNULL(' nº ' + NULLIF(en.[ch_logradouro_número], ''), '')
               + ISNULL(' - ' + NULLIF(en.[ch_logradouro_complemento], ''), '')),
    bairro   = ba.[ch_nome],
    cidade   = ci.[ch_nome] + ISNULL(' - ' + es.[ch_sigla], ''),
    cep      = en.[ch_cep]
  FROM dbo.[tbl_entidades_endereços] en
  LEFT JOIN dbo.[tbl_bairros] ba ON ba.[nm_id] = en.[nm_id_bairro]
  LEFT JOIN dbo.[tbl_cidades] ci ON ci.[nm_id] = en.[nm_id_cidade]
  LEFT JOIN dbo.[tbl_estados] es ON es.[nm_id] = en.[nm_id_estado]
  WHERE en.[nm_id_entidade] = e.[nm_id]
  ORDER BY ISNULL(en.[bt_padrão], 0) DESC, en.[nm_id] DESC
) ende
WHERE e.[nm_id] IN (SELECT id_cliente FROM #telefones);

/* 3. Contratos (só os ATIVOS — cancelados ficam de fora) */
SELECT
  c.[nm_id]                                   AS id_contrato,
  c.[nm_id_cliente]                           AS id_cliente,
  c.[ch_referência]                           AS numero_contrato,
  ct.[ch_nome]                                AS plano,
  CASE WHEN c.[dt_cancelamento] > '19000101' OR ISNULL(c.[bt_registro_ativo], 1) = 0
       THEN 'Cancelado' ELSE 'Ativo' END      AS situacao_contrato,
  mc.[ch_nome]                                AS motivo_cancelamento,
  CONVERT(VARCHAR(10), NULLIF(c.[dt_contrato], '19000101'), 103)     AS data_contrato,
  CONVERT(VARCHAR(10), NULLIF(c.[dt_cancelamento], '19000101'), 103) AS data_cancelamento,
  c.[ch_dia_vencimento]                       AS dia_vencimento,
  (SELECT COUNT(*) FROM dbo.[tbl_contratos_beneficiários] b
   WHERE b.[nm_id_contrato] = c.[nm_id] AND ISNULL(b.[bt_registro_ativo], 1) = 1)
  + CASE WHEN tl.titular_na_lista = 1 THEN 0 ELSE 1 END   AS quantidade_beneficiarios,
  STUFF(
    CASE WHEN tl.titular_na_lista = 1 THEN '' ELSE
      ' | ' + REPLACE(REPLACE(ISNULL(et.[ch_nome_completo], ''), ';', ' '), '|', ' ') + ';Titular;'
      + ISNULL(CONVERT(VARCHAR(10), NULLIF(nt.dt_nascimento, '19000101'), 103), '') + ';Não'
    END
    + ISNULL((
      SELECT ' | ' + REPLACE(REPLACE(eb.[ch_nome_completo], ';', ' '), '|', ' ')
        + ';' + CASE WHEN b.[nm_id_beneficiário] = c.[nm_id_cliente] THEN 'Titular' ELSE ISNULL(gr.[ch_nome], '') END
        + ';' + ISNULL(CONVERT(VARCHAR(10), NULLIF((SELECT TOP 1 fb.[dt_nascimento] FROM dbo.[tbl_entidades_física] fb
                                                   WHERE fb.[nm_id_entidade] = b.[nm_id_beneficiário]), '19000101'), 103), '')
        + ';' + CASE WHEN ISNULL(b.[bt_agregado], 0) = 1 THEN 'Sim' ELSE 'Não' END
      FROM dbo.[tbl_contratos_beneficiários] b
      JOIN dbo.[tbl_entidades] eb          ON eb.[nm_id] = b.[nm_id_beneficiário]
      LEFT JOIN dbo.[tbl_graus_relação] gr ON gr.[nm_id] = b.[nm_id_grau_relação]
      WHERE b.[nm_id_contrato] = c.[nm_id] AND ISNULL(b.[bt_registro_ativo], 1) = 1
      ORDER BY CASE WHEN b.[nm_id_beneficiário] = c.[nm_id_cliente] THEN 0 ELSE 1 END, eb.[ch_nome_completo]
      FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), ''),
    1, 3, '')                                 AS beneficiarios,
  res.[nm_documentos_em_atraso]                          AS parcelas_em_atraso,
  CAST(res.[mn_total_saldo_em_atraso] AS DECIMAL(12, 2)) AS valor_em_atraso,
  CONVERT(VARCHAR(10), NULLIF(res.[dt_último_recebimento], '19000101'), 103) AS ultimo_pagamento
INTO #contratos
FROM dbo.[tbl_contratos] c
LEFT JOIN dbo.[tbl_entidades] et                      ON et.[nm_id] = c.[nm_id_cliente]
OUTER APPLY (SELECT TOP 1 f.[dt_nascimento] AS dt_nascimento FROM dbo.[tbl_entidades_física] f
             WHERE f.[nm_id_entidade] = c.[nm_id_cliente]) nt
OUTER APPLY (SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.[tbl_contratos_beneficiários] b
                                      WHERE b.[nm_id_contrato] = c.[nm_id] AND b.[nm_id_beneficiário] = c.[nm_id_cliente]
                                        AND ISNULL(b.[bt_registro_ativo], 1) = 1)
                         THEN 1 ELSE 0 END AS titular_na_lista) tl
LEFT JOIN dbo.[tbl_contratos_tipos] ct                ON ct.[nm_id] = c.[nm_id_tipo]
LEFT JOIN dbo.[tbl_contratos_motivos_cancelamento] mc ON mc.[nm_id] = c.[nm_id_motivo_cancelamento]
OUTER APPLY (
  SELECT TOP 1 r.[nm_documentos_em_atraso], r.[mn_total_saldo_em_atraso], r.[dt_último_recebimento]
  FROM dbo.[tbl_contas_a_receber_origens_resumo] r
  WHERE r.[nm_id_cliente] = c.[nm_id_cliente] AND r.[nm_id_origem] = c.[nm_id]
  ORDER BY r.[dt_processamento] DESC
) res
WHERE c.[nm_id_cliente] IN (SELECT id_cliente FROM #clientes)
  AND (c.[dt_cancelamento] IS NULL OR c.[dt_cancelamento] <= '19000101')
  AND ISNULL(c.[bt_registro_ativo], 1) = 1;

/* 4. Parcelas (vencidas + a próxima a vencer) e dados do boleto */
SELECT
  d.[nm_id_cliente]                                       AS id_cliente,
  CASE WHEN d.[nm_tipo_origem] = 2 THEN d.[nm_id_origem] END AS id_contrato,   -- 2 = parcela de contrato
  d.[ch_identificação]                                    AS documento,
  d.[dt_vencimento]                                       AS dt_vencimento,
  CONVERT(VARCHAR(10), d.[dt_vencimento], 103)            AS vencimento_parcela,
  CASE WHEN d.[dt_vencimento] < @hoje THEN DATEDIFF(DAY, d.[dt_vencimento], @hoje) ELSE 0 END AS dias_em_atraso,
  CAST(d.[mn_original] AS DECIMAL(12, 2))                 AS valor_original,
  CAST(d.[mn_saldo] AS DECIMAL(12, 2))                    AS saldo,
  CAST(dbo.fn_contas_a_receber_documentos_multa(d.[nm_id], GETDATE()) AS DECIMAL(12, 2)) AS multa,
  CAST(dbo.fn_contas_a_receber_documentos_juros(d.[nm_id], GETDATE()) AS DECIMAL(12, 2)) AS juros,
  CONVERT(VARCHAR(10), NULLIF(em.[dt_vencimento], '19000101'), 103) AS vencimento_boleto,
  CAST(em.[mn_valor_total] AS DECIMAL(12, 2))             AS valor_boleto,
  CASE
    WHEN em.[nm_id] IS NULL                          THEN 'Sem boleto emitido'
    WHEN cf.[nm_tipo_configuração] = 5               THEN 'Cartão recorrente'
    WHEN lb.[ch_arquivo] LIKE '%Sem[_]Emiss%'        THEN 'Sem boleto (aviso de carteira)'
    ELSE 'Boleto' END                                     AS forma_pagamento,
  ISNULL(NULLIF(em.[ch_nosso_número_banco], ''), em.[ch_nosso_número]) AS nosso_numero,
  bc.[ch_número]                                          AS banco_codigo,
  bc.[ch_nome_fantasia]                                   AS banco_nome,
  ag.[ch_agência_número] + ISNULL('-' + NULLIF(ag.[ch_agência_dígito], ''), '') AS agencia_beneficiario,
  cb.[ch_conta_número] + ISNULL('-' + cb.[ch_conta_dígito], '')                 AS conta_beneficiario,
  cv.[ch_número_convênio]                                 AS convenio,
  CASE WHEN bc.[ch_número] = '001' THEN LEFT(cf.[ch_configurações_gerais], 2) END        AS carteira,
  CASE WHEN bc.[ch_número] = '001' THEN SUBSTRING(cf.[ch_configurações_gerais], 3, 3) END AS variacao_carteira,
  COALESCE(NULLIF(ge.[ch_razão_social], ''), NULLIF(cv.[ch_razão_social], ''), ge.[ch_nome_fantasia]) AS beneficiario_nome,
  ge.[ch_cnpj]                                            AS beneficiario_cnpj,
  em.[nm_id_configuração]                                 AS id_configuracao_boleto
INTO #parcelas
FROM (
  SELECT a.*
  FROM (
    SELECT dd.*,
           proxima = CASE WHEN dd.[dt_vencimento] >= @hoje THEN
                       ROW_NUMBER() OVER (
                         PARTITION BY dd.[nm_id_cliente], dd.[nm_tipo_origem], dd.[nm_id_origem],
                                      CASE WHEN dd.[dt_vencimento] >= @hoje THEN 1 ELSE 0 END
                         ORDER BY dd.[dt_vencimento], dd.[nm_id]) END
    FROM dbo.[tbl_contas_a_receber_documentos] dd
    WHERE dd.[nm_id_cliente] IN (SELECT id_cliente FROM #clientes)
      AND ISNULL(dd.[bt_registro_ativo], 1) = 1
      AND (dd.[dt_cancelamento] IS NULL OR dd.[dt_cancelamento] <= '19000101')
      AND dd.[mn_saldo] > 0
  ) a
  WHERE a.[dt_vencimento] < @hoje OR a.proxima = 1
) d
OUTER APPLY (
  SELECT TOP 1 x.[nm_id], x.[dt_vencimento], x.[mn_valor_total], x.[ch_nosso_número], x.[ch_nosso_número_banco], x.[nm_id_configuração]
  FROM dbo.[tbl_contas_a_receber_documentos_emissões] x
  WHERE x.[nm_id_documento] = d.[nm_id] AND ISNULL(x.[bt_atual], 0) = 1
  ORDER BY x.[nm_id] DESC
) em
LEFT JOIN dbo.[tbl_contas_a_receber_documentos_emissões_configurações] cf ON cf.[nm_id] = em.[nm_id_configuração]
LEFT JOIN dbo.[tbl_contas_a_receber_documentos_emissões_configurações_layouts_boletos] lb ON lb.[nm_id] = cf.[nm_id_layout_boleto]
LEFT JOIN dbo.[tbl_contas_a_receber_documentos_emissões_configurações_convênios] cv ON cv.[nm_id] = cf.[nm_id_convênio]
LEFT JOIN dbo.[tbl_contas_bancárias] cb   ON cb.[nm_id] = cv.[nm_id_conta_bancária]
LEFT JOIN dbo.[tbl_bancos] bc             ON bc.[nm_id] = cb.[nm_id_banco]
LEFT JOIN dbo.[tbl_agências_bancárias] ag ON ag.[nm_id] = cb.[nm_id_agência]
LEFT JOIN dbo.[tbl_grupo_empresas] ge     ON ge.[nm_id] = cv.[nm_id_empresa];

/* 5. Resultado único, em colunas — campos vazios em branco */
;WITH linhas AS (
  -- contratos ativos (com ou sem parcela em aberto)
  SELECT t.telefone, t.id_cliente, c.id_contrato, c.numero_contrato, c.plano, c.situacao_contrato, c.motivo_cancelamento,
         c.data_contrato, c.data_cancelamento, c.dia_vencimento, c.quantidade_beneficiarios, c.beneficiarios,
         c.parcelas_em_atraso, c.valor_em_atraso, c.ultimo_pagamento,
         p.documento, p.dt_vencimento, p.vencimento_parcela, p.dias_em_atraso, p.valor_original, p.saldo, p.multa, p.juros, p.vencimento_boleto, p.valor_boleto, p.forma_pagamento, p.nosso_numero, p.banco_codigo, p.banco_nome, p.agencia_beneficiario, p.conta_beneficiario, p.convenio, p.carteira, p.variacao_carteira, p.beneficiario_nome, p.beneficiario_cnpj, p.id_configuracao_boleto
  FROM #telefones t
  JOIN #contratos c       ON c.id_cliente = t.id_cliente
  LEFT JOIN #parcelas p   ON p.id_cliente = t.id_cliente AND p.id_contrato = c.id_contrato
  UNION ALL
  -- vendas/acordos avulsos (NÃO são parcela de contrato), só de clientes com contrato ativo.
  -- Parcelas de contratos cancelados NÃO entram aqui.
  SELECT t.telefone, t.id_cliente, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         p.documento, p.dt_vencimento, p.vencimento_parcela, p.dias_em_atraso, p.valor_original, p.saldo, p.multa, p.juros, p.vencimento_boleto, p.valor_boleto, p.forma_pagamento, p.nosso_numero, p.banco_codigo, p.banco_nome, p.agencia_beneficiario, p.conta_beneficiario, p.convenio, p.carteira, p.variacao_carteira, p.beneficiario_nome, p.beneficiario_cnpj, p.id_configuracao_boleto
  FROM #telefones t
  JOIN #parcelas p ON p.id_cliente = t.id_cliente AND p.id_contrato IS NULL
  WHERE EXISTS (SELECT 1 FROM #contratos c WHERE c.id_cliente = t.id_cliente)
)
SELECT
  ISNULL(l.telefone, '')                                                                    AS telefone_whatsapp,
  ISNULL(CONVERT(VARCHAR(20), l.id_cliente), '')                                            AS codigo_cliente,
  ISNULL(REPLACE(REPLACE(REPLACE(REPLACE(cl.nome_cliente, ';', ' '), ',', ' '), CHAR(13), ' '), CHAR(10), ' '), '') AS nome_cliente,
  ISNULL(REPLACE(cl.cpf_cnpj, ';', ' '), '')                                                AS cpf_cnpj,
  ISNULL(cl.cliente_falecido, '')                                                           AS cliente_falecido,
  ISNULL(REPLACE(REPLACE(REPLACE(REPLACE(cl.endereco, ';', ' '), ',', ' '), CHAR(13), ' '), CHAR(10), ' '), '') AS endereco,
  ISNULL(REPLACE(REPLACE(cl.bairro, ';', ' '), ',', ' '), '')                               AS bairro,
  ISNULL(REPLACE(REPLACE(cl.cidade, ';', ' '), ',', ' '), '')                               AS cidade,
  ISNULL(REPLACE(cl.cep, ';', ' '), '')                                                     AS cep,
  ISNULL(REPLACE(CONVERT(NVARCHAR(100), l.numero_contrato), ';', ' '), '')                  AS numero_contrato,
  ISNULL(REPLACE(REPLACE(l.plano, ';', ' '), ',', ' '), '')                                 AS plano,
  ISNULL(l.situacao_contrato, '')                                                           AS situacao_contrato,
  ISNULL(l.data_contrato, '')                                                               AS data_contrato,
  ISNULL(REPLACE(CONVERT(VARCHAR(10), l.dia_vencimento), ';', ' '), '')                     AS dia_vencimento,
  ISNULL(CONVERT(VARCHAR(10), l.quantidade_beneficiarios), '')                              AS quantidade_beneficiarios,
  CASE WHEN l.beneficiarios IS NULL OR l.id_contrato IS NULL THEN ''
       WHEN ROW_NUMBER() OVER (PARTITION BY l.telefone, l.id_contrato ORDER BY l.dt_vencimento) > 1 THEN ''
       ELSE REPLACE(REPLACE(REPLACE(REPLACE(l.beneficiarios, '"', ' '), ',', ' '), CHAR(13), ' '), CHAR(10), ' ')
  END                                                                                       AS beneficiarios,
  ISNULL(CONVERT(VARCHAR(10), l.parcelas_em_atraso), '')                                    AS parcelas_em_atraso,
  ISNULL(CONVERT(VARCHAR(10), @parcelas_suspensao), '')                                     AS parcelas_suspensao,
  ISNULL(CONVERT(VARCHAR(20), l.valor_em_atraso), '')                                       AS valor_em_atraso,
  ISNULL(REPLACE(REPLACE(l.documento, ';', ' '), ',', ' '), '')                             AS documento,
  ISNULL(l.vencimento_parcela, '')                                                          AS vencimento_parcela,
  ISNULL(CONVERT(VARCHAR(10), l.dias_em_atraso), '')                                        AS dias_em_atraso,
  ISNULL(CONVERT(VARCHAR(20), l.valor_original), '')                                        AS valor_original,
  ISNULL(CONVERT(VARCHAR(20), l.saldo), '')                                                 AS saldo,
  ISNULL(CONVERT(VARCHAR(20), l.multa), '')                                                 AS multa,
  ISNULL(CONVERT(VARCHAR(20), l.juros), '')                                                 AS juros,
  ISNULL(CONVERT(VARCHAR(20), CAST(l.saldo + ISNULL(l.multa, 0) + ISNULL(l.juros, 0) AS DECIMAL(12, 2))), '') AS valor_atualizado,
  ISNULL(l.vencimento_boleto, '')                                                           AS vencimento_boleto,
  ISNULL(CONVERT(VARCHAR(20), l.valor_boleto), '')                                          AS valor_boleto,
  ISNULL(l.forma_pagamento, '')                                                             AS forma_pagamento,
  ISNULL(REPLACE(l.nosso_numero, ';', ' '), '')                                             AS nosso_numero,
  ISNULL(REPLACE(l.banco_codigo, ';', ' '), '')                                             AS banco_codigo,
  ISNULL(REPLACE(REPLACE(l.banco_nome, ';', ' '), ',', ' '), '')                            AS banco_nome,
  ISNULL(REPLACE(l.agencia_beneficiario, ';', ' '), '')                                     AS agencia_beneficiario,
  ISNULL(REPLACE(l.conta_beneficiario, ';', ' '), '')                                       AS conta_beneficiario,
  ISNULL(REPLACE(l.convenio, ';', ' '), '')                                                 AS convenio,
  ISNULL(REPLACE(l.carteira, ';', ' '), '')                                                 AS carteira,
  ISNULL(REPLACE(l.variacao_carteira, ';', ' '), '')                                        AS variacao_carteira,
  ISNULL(REPLACE(REPLACE(l.beneficiario_nome, ';', ' '), ',', ' '), '')                     AS beneficiario_nome,
  ISNULL(REPLACE(l.beneficiario_cnpj, ';', ' '), '')                                        AS beneficiario_cnpj,
  ISNULL(CONVERT(VARCHAR(20), l.id_configuracao_boleto), '')                                AS id_configuracao_boleto,
  ISNULL(REPLACE(REPLACE(REPLACE(REPLACE(cl.email, ';', ' '), ',', ' '), CHAR(13), ' '), CHAR(10), ' '), '') AS email
FROM linhas l
JOIN #clientes cl ON cl.id_cliente = l.id_cliente
ORDER BY l.telefone, l.situacao_contrato, l.numero_contrato, l.dt_vencimento;

DROP TABLE #parcelas;
DROP TABLE #contratos;
DROP TABLE #clientes;
DROP TABLE #telefones;
