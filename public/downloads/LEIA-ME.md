# Paratech Infinite — atalho gerenciado v1

Esta versão cria atalhos que consultam o Zap Hub antes de abrir os programas selecionados. Não modifica os EXEs, não encerra processos, não oculta o agente e não impede abertura direta ou remoção pelo administrador.

## Instalação

1. No portal, abra **Hubs → Novo Hub**. Selecione a cobrança, o limite de confiança e a validade offline (padrão 24 horas).
2. Copie o código de uso único, válido por 15 minutos. Baixe `Paratech_Infinite.exe` na mesma aba.
3. Execute no usuário Windows que utilizará os programas. Informe o endereço HTTPS do portal e o código. Selecione os EXEs locais e autorize a criação dos atalhos.
4. Use os novos atalhos `Paratech - Nome - número` na área de trabalho. Os atalhos originais não são removidos.

A instalação é por usuário, em `%LOCALAPPDATA%\Paratech\Infinite`. Não exige elevação. O início com o Windows é opcional e usa um atalho visível na pasta Inicializar, abrindo o painel minimizado. Fechar o painel encerra a comunicação até a próxima abertura do Hub/atalho. Os dados locais são protegidos com DPAPI para o usuário atual.

O executável ainda não possui assinatura de código Authenticode. Valide a distribuição em um computador de teste e aplique o certificado de assinatura da empresa antes de distribuição em escala. Não desative as proteções do Windows para instalá-lo.

## Estados e ações

- Em dia: abre o programa.
- Fatura disponível: mostra logo, dados e pagamento; após 5 segundos o botão fecha o aviso e abre o programa.
- Atraso: aviso vermelho e dias restantes até o bloqueio.
- Bloqueio: impede somente a abertura pelo atalho. Fechar o aviso não inicia o programa. Não há contagem de 5 segundos nesse estado.
- Pagamento: abre o checkout real InfinitePay no navegador. QR Code e Copia e Cola são exibidos pelo gateway, não gerados localmente.
- WhatsApp: envia ao telefone cadastrado no cliente. Máximo de três solicitações por Hub por hora.
- Confiança: 24 horas. Contador permanente compartilhado entre os Hubs da mesma cobrança; limite configurável. Bloqueio manual e revogação não aceitam confiança.

Com o painel aberto, o computador consulta o portal a cada minuto, inclusive após o pagamento. O portal identifica como online contatos nos últimos 3 minutos; a coluna também mostra o último contato. Não há push instantâneo. A próxima fatura é calculada a partir dos registros mensais do portal, sem somar 30 dias fixos.

## Sem internet

A situação fica em uma autorização assinada Ed25519, com validade configurável de 1 a 72 horas. Os dados de vencimento e bloqueio continuam sendo avaliados localmente. Autorização expirada exige conexão ou contrassenha. Retrocesso evidente do relógio exige validação online. Esse controle não é inviolável para administradores locais, que também podem abrir diretamente os EXEs.

Na tela bloqueada, **Sem internet — contrassenha** gera um desafio específico do Hub. O operador autenticado usa a aba **Contrassenha** do portal para assinar uma liberação de até 24 horas. O cliente cola o código e clica Liberar. A assinatura vincula o código ao Hub, à instalação e ao desafio; reutilização é rejeitada no estado local. A contrassenha é longa porque contém uma assinatura verificável sem internet. Gerar a mesma solicitação no portal retorna o mesmo código e não prolonga seu prazo. A reconexão aplica novamente a política atual do portal.

Mudanças e revogações online não podem ser entregues a um computador desconectado. Uma autorização offline ou contrassenha previamente emitida pode permanecer válida até expirar.

## Remoção e troca de programas

No painel local, use **Remover atalhos e pareamento local**. Isso remove apenas os atalhos criados e os dados do Hub, sem tocar nos programas. Depois de fechar, o executável instalado pode ser excluído. Revogue o registro no portal quando o computador deixar de ser atendido. Para trocar a lista de EXEs, remova o pareamento local e gere um novo código no registro do Hub.

## Compilar no Windows

Python 3.13, Tkinter, Pillow, cryptography e PyInstaller são necessários para compilar; o cliente final não precisa instalar Python.

```powershell
python -m unittest discover -s windows-hub -p test_core.py
python -m PyInstaller --noconfirm --clean --onefile --windowed --name Paratech_Infinite --distpath public/downloads --workpath data/hub-build --specpath data windows-hub/paratech_infinite.py
```

Verificação do pacote sem instalar nem acessar a rede:

```powershell
Start-Process -FilePath public/downloads/Paratech_Infinite.exe -ArgumentList '--self-test', 'data/hub-self-test.json' -Wait -WindowStyle Hidden
Get-Content data/hub-self-test.json
```
