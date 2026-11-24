# Balance Reader

[![Pages](https://github.com/AugustoCoding/Balance-Reader/actions/workflows/pages.yml/badge.svg)](https://github.com/AugustoCoding/Balance-Reader/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[English version](README.en.md)

Registrador de dados para balanças de laboratório, direto no navegador. A balança é ligada ao computador pela saída serial (cabo RS232 → USB) e a página mostra o peso ao vivo, plota o histórico, calcula a incerteza de cada leitura e exporta tudo em Excel (com gráfico) ou CSV.

**Abra: <https://augustocoding.github.io/Balance-Reader/>** — não precisa instalar nada.

## Como usar

Funciona no **Google Chrome**, **Microsoft Edge** ou Opera **no computador** (Windows, macOS, Linux, ChromeOS), que acessam a porta USB pela [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API). Firefox, Safari e celulares não têm esse acesso; neles só o simulador funciona.

1. Ligue a balança ao computador com o cabo serial-USB. Se o Windows pedir driver para o cabo (CH340, FTDI, Prolific…), instale-o.
2. Abra o endereço acima e clique em **Conectar → Escolher porta USB…**. O navegador pede permissão uma vez; depois a página reconecta sozinha, inclusive se o cabo for desplugado e plugado de novo.
3. Em **Configurações → Balança**, escolha o modelo. Se a velocidade não bater, use **Conexão → Detectar automaticamente**.
4. Clique em **Iniciar gravação**. Para encerrar sozinho, ligue **Parar automaticamente em** e informe a duração (`hh:mm:ss`).
5. Ao terminar, **Exportar** → Excel (`.xlsx`, com gráfico) ou CSV.

Sem balança por perto, use **Conectar → Usar o simulador**.

Atalhos: <kbd>Espaço</kbd> grava/pausa · <kbd>T</kbd> tara · <kbd>Ctrl</kbd>+<kbd>S</kbd> exporta em Excel.

### O arquivo exportado

| Coluna | Significado |
|---|---|
| `Tempo (s)` | Segundos desde o início da gravação |
| `Peso (g)` | Peso lido, já descontado o recipiente (se informado) |
| `Incerteza (g)` | Desvio padrão das últimas N leituras (N = 5 por padrão) — quanto a balança oscilava naquele momento |
| `Horário` | Hora do computador em que a leitura chegou |
| `Estável` | Se a balança marcou a leitura como estável |

No final aparecem a **média**, a **incerteza média**, o **peso do recipiente** descontado (se usado) e o perfil da balança.

**Recipiente**: digite o peso do béquer/frasco e clique em *Aplicar* (ou *Usar o peso atual*); todas as leituras, inclusive as já feitas, passam a mostrar o peso líquido.

### Qualquer balança

Cada balança é descrita por um **perfil**: parâmetros da porta serial, formato das linhas e comandos (tarar, zerar, pedir leitura).

| Perfil | Porta | Situação |
|---|---|---|
| BEL LG3202i | 1200 8N1 | **Testado na balança** |
| Mettler Toledo (MT-SICS) | 9600 8N1 | Padrão do fabricante |
| A&D (FX, GX, GF, EK…) | 2400 7E1 | Padrão do fabricante |
| Ohaus (Adventurer, Pioneer, Explorer) | 9600 8N1 | Padrão do fabricante |
| Sartorius (SBI) | 1200 7O1 | Padrão do fabricante |
| Genérica | 9600 8N1 | Ponto de partida |

Os perfis "padrão do fabricante" seguem os manuais e **não foram testados em balança real**: confira o menu de comunicação da sua balança. Para ajustar ou criar um perfil:

- **Formato dos dados** — o modo automático acha "número + unidade" em qualquer lugar da linha, o que cobre a maioria das balanças. Para formatos especiais há o modo *expressão regular* (grupo `(?<valor>…)`), além de regras para marcar a leitura como estável/instável ou ignorar linhas. A caixa **Teste** mostra na hora como cada linha é lida.
- **Comandos** — tarar, zerar e pedir leitura, com escapes como `\e` (ESC) e `\x1B`. Balanças que só respondem quando perguntadas usam a **consulta automática** (ex.: `SI` a cada 0,5 s).
- **Comunicação serial** — o painel no fim da página mostra cada linha recebida, se virou peso ou não, e permite enviar comandos à mão.
- Perfis podem ser salvos e **exportados/importados** como `.json` para levar a outro computador.

### Se não aparecer leitura

A página avisa quando passa 8 segundos sem leitura e aponta o motivo provável:

| Aviso | O que verificar |
|---|---|
| Nada chega da balança | A balança precisa estar no modo de envio contínuo (ou aperte PRINT nela). Se ela só responde a comandos, configure a consulta automática. |
| Chegam caracteres ilegíveis | Velocidade ou paridade diferente da balança — use *Detectar automaticamente*. |
| Chegam dados, mas nenhum peso foi reconhecido | Veja as linhas em *Comunicação serial* e ajuste o *Formato dos dados*. |
| "Não foi possível abrir a porta" | Outro programa ou outra aba está usando a porta; feche-o. |

### Onde ficam os dados

Tudo fica **só no navegador** deste computador: as configurações e uma cópia de segurança da sessão em andamento (recuperada se a aba fechar). Nada é enviado a servidor algum. Exporte as leituras para guardá-las.

## BEL LG3202i

Na balança, segure **MENU** até o bipe parar e escolha *Serial output* → **Continuous**, confirmando com **PRINT**. Porta a 1200 bps, 8 bits, sem paridade, 1 stop bit.

- **Continuous** — cerca de cinco linhas por segundo, com o último dígito entre colchetes e `S` quando estável:
  ```
       0.0[0] g S
     125.3[4] g
  ```
- **On demand** — a cada toque em PRINT, um bloco de quatro linhas; só a última traz peso:
  ```
  --------------------
  16-09-26 13:16:27
  --------------------
  Peso:       0.00 g
  ```

O computador pode tarar a balança enviando `T` + `CR LF` (botão **Tarar**).

## Desenvolvimento

Sem build e sem dependências: HTML, CSS e módulos JavaScript.

```bash
npm test     # testes (node --test, Node 20+)
npm start    # servidor local em http://localhost:8080
```

| Arquivo | Conteúdo |
|---|---|
| `src/protocol.js` | parser das linhas, comandos, divisão em linhas |
| `src/profiles.js` | perfis prontos das balanças |
| `src/reader.js` | aquisição: leituras, gravação, consulta automática, diagnóstico |
| `src/serial.js` | porta USB pela Web Serial API |
| `src/simulator.js` | balança simulada nos formatos dos perfis |
| `src/session.js`, `src/stats.js` | sessão, incerteza, CSV e cópia de segurança |
| `src/xlsx.js` | gerador de Excel com gráfico, sem bibliotecas |
| `src/chart.js`, `src/app.js` | gráfico e interface |
| `sw.js` | funcionamento offline |

Cada push na `main` roda os testes e publica no GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). Na primeira vez, ative em *Settings → Pages → Source: GitHub Actions*.

## Licença

[MIT](LICENSE).
