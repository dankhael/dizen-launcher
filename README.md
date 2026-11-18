# Dizen

Launcher minimalista para TVs Samsung com Tizen, feito pela **Eraserhead Software**.
Uma tela inicial limpa, navegável só pelo controle remoto, com oito temas, no lugar
da Home cheia de anúncios.

Dizen é um **add-on do [Vetro](https://github.com/andrearicci93/vetro)**: o Vetro
abre os apps e coloca o Dizen no botão Home; o Dizen é a interface.

> **Leia antes de instalar.** O Dizen só funciona numa TV com o Vetro instalado, e o
> Vetro depende de root na TV. Este repositório não contém nem distribui nenhuma
> ferramenta de root: essa parte é do Vetro e de quem o instala. Fazer root pode
> anular a garantia e, se der errado, deixar a TV inutilizável. Faça por sua conta
> e risco.
>
> Dizen é um projeto independente, sem nenhuma ligação com a Samsung Electronics.
> Samsung e Tizen são marcas da Samsung; os nomes aparecem aqui só para dizer em
> quais TVs o Dizen roda.

## O que tem

- **Grade de apps** com a lista real da TV, ícones incluídos, gerada pelo plugin do Vetro.
- **Entradas de sistema:** TV aberta, TV Plus, HDMI 1–3, configurações da TV e uma
  saída de emergência para a Home original.
- **Continuar:** atalho para reabrir o último app. O foco volta para onde estava.
- **Oito temas:** Dizen, OLED puro (com deslocamento anti burn-in), Canais, Vidro,
  CRT retro, Nord, Clássico e Colina. Escolha na engrenagem (↑ no topo da grade).
- **Ordem dos apps** ajustável pelo controle.
- **Plugin `dizen-sync`** para o Vetro, que mantém apps, ícones, canais e aparelhos
  HDMI atualizados de dentro da TV, sem PC.

## Requisitos

- TV Samsung com Tizen e o **Vetro instalado e funcionando**. Desenvolvido e testado
  numa Q60B (Tizen 6.5); outros modelos podem precisar de ajuste.
- Um PC na mesma rede, com `bash`, `curl`, `python3` e `zip`.
- [`apps2samsung-cli`](https://github.com/Apps2Samsung/Apps2Samsung) para assinar o
  pacote. A Samsung amarra a assinatura ao DUID de cada TV, então **cada pessoa
  assina com o próprio certificado**. Por isso não existe um `.wgt` pronto para baixar.

## Instalar

```sh
cp tools/.env.example tools/.env      # preencha TV_IP
./tools/push-launcher.sh pair         # pareia com o Vetro (código de 6 dígitos na TV)
./tools/sync-apps.sh                  # gera a lista de apps e os ícones da sua TV
./tools/build-dizen.sh                # empacota, assina e instala o Dizen
./tools/install-plugin.sh             # instala o plugin dizen-sync no Vetro
./tools/set-home.sh on                # botão Home abre o Dizen (off desfaz)
```

Para mudanças em HTML, CSS ou JS, `./tools/push-launcher.sh` atualiza a TV em
segundos, sem reinstalar. Mudanças em `config.xml` ou `icon.png` pedem
`build-dizen.sh` de novo.

## Personalizar

Tudo que é seu fica em [`launcher/js/local.js`](launcher/js/local.js): renomear temas,
música de fundo no tema Canais e aparelhos para as entradas HDMI (PS, Switch, PC…).
O arquivo vem só com exemplos comentados.

## Mexer no visual sem TV

Abra `launcher/index.html?preview=1` num navegador. Sem as APIs do Tizen, o
launcher entra em modo demo com apps de exemplo; setas e Enter funcionam no teclado.
Com o Tizen Studio instalado, `./tools/preview-tv-simulator.sh` abre no simulador.

Testes: `node tools/check-initial-theme.cjs` (Playwright) e, para o monitor de
energia do plugin, `node tools/check-power.cjs` (.NET).

## Licença

MIT — ver [LICENSE](LICENSE). Créditos e procedência em [NOTICE.md](NOTICE.md).
