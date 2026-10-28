# Converte lista_clientes_WhatsAtendente.xlsx em CSV separado por ";" (UTF-8),
# desfazendo o que o Excel muda nos dados (telefone/CPF/CEP como número,
# identificação da parcela "10/26" virando data, datas, centavos).
# Uso: python xlsx_para_csv.py [arquivo.xlsx] [arquivo.csv]
import csv, datetime, os, sys

try:
    import openpyxl
except ImportError:
    sys.exit('Falta o openpyxl. Rode uma vez:  python -m pip install --user openpyxl')

pasta = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
origem = sys.argv[1] if len(sys.argv) > 1 else os.path.join(pasta, 'lista_clientes_WhatsAtendente.xlsx')
destino = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(origem)[0] + '.csv'

DATAS = {'data_contrato', 'data_cancelamento', 'ultimo_pagamento', 'vencimento_parcela', 'vencimento_boleto'}
VALORES = {'valor_em_atraso', 'valor_original', 'saldo', 'multa', 'juros', 'valor_atualizado', 'valor_boleto'}
ZEROS = {'cep': 8}  # completa zeros à esquerda que o Excel apagou


def texto(col, v, formato):
    if v is None:
        return ''
    if isinstance(v, (datetime.datetime, datetime.date)):
        if col in DATAS:
            return v.strftime('%d/%m/%Y')
        # identificação da parcela (ex.: "10/26") que o Excel virou data
        f = (formato or '').lower()
        if 'y' in f and 'd' not in f:          # mmm/aa  -> MM/AA
            return v.strftime('%m/%y')
        if 'd' in f and 'y' not in f:          # dd/mmm  -> DD/MM
            return v.strftime('%d/%m')
        return v.strftime('%d/%m/%Y')
    if isinstance(v, bool):
        return 'Sim' if v else 'Não'
    if isinstance(v, float):
        if col in VALORES:
            return f'{v:.2f}'
        if v.is_integer():
            v = int(v)
        else:
            return repr(v)
    s = str(v).strip() if not isinstance(v, int) else str(v)
    if s.upper() == 'NULL':
        return ''
    if col in ZEROS and s.isdigit():
        s = s.zfill(ZEROS[col])
    if col == 'cpf_cnpj' and s.isdigit():
        s = s.zfill(11) if len(s) <= 11 else s.zfill(14)
    return s


print('Lendo', origem, '(pode levar alguns minutos)...')
wb = openpyxl.load_workbook(origem, read_only=True)
ws = wb.worksheets[0]
linhas = ws.iter_rows()
cab = [texto('', c.value, None) for c in next(linhas)]
while cab and cab[-1] == '':
    cab.pop()
n = len(cab)

tmp = destino + '.tmp'
total = 0
perdidos = 0
with open(tmp, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f, delimiter=';', lineterminator='\r\n')
    w.writerow(cab)
    for linha in linhas:
        celulas = list(linha)[:n]
        valores = [texto(cab[i], c.value, getattr(c, 'number_format', None)) for i, c in enumerate(celulas)]
        valores += [''] * (n - len(valores))
        if not any(valores):
            continue
        if any('E+' in v for v in valores):
            perdidos += 1
        w.writerow(valores)
        total += 1
os.replace(tmp, destino)

print(f'Pronto: {total} linhas, {os.path.getsize(destino) / 1048576:.1f} MB -> {destino}')
if perdidos:
    print(f'ATENCAO: {perdidos} linhas tem numeros que o Excel ja havia cortado (ex.: 2,29E+09).')
    print('Esses digitos nao existem mais no .xlsx e so voltam gerando de novo pelo banco.')
