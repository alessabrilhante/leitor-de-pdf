# Folha

Leitor de PDF pra iPhone e iPad. Com o livro aberto, a tela mostra só a página, sem barra, sem botão e sem margem sobrando.

## Como usar

- **Adicionar PDF:** escolhe o arquivo e ele fica guardado no aparelho.
- **Virar página:** toca na direita pra avançar e na esquerda pra voltar, ou arrasta o dedo pro lado.
- **Menu:** toca no meio da página. Aparecem a estante, a barra pra pular de página, o ajuste (página inteira ou largura) e o tema (claro, sépia ou escuro).
- O Folha lembra em que página você parou em cada livro.

## Instalar no iPhone/iPad

Abre o site no Safari, toca em **Compartilhar → Adicionar à Tela de Início**. Assim ele abre em tela cheia e funciona sem internet.

Os livros ficam salvos só no aparelho onde foram adicionados. O app da tela de início tem a estante dele, separada da do Safari.

## Por dentro

HTML, CSS e JS puros, sem build. Usa o [PDF.js](https://mozilla.github.io/pdf.js/) (licença Apache 2.0, em `lib/`) pra desenhar as páginas e o IndexedDB pra guardar os arquivos.
